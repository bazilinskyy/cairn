'use strict';
// Runs a copy of app.js in a temp dir with its own config and data, so the real data/ is never touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const PORT = 39123;
const BASE = `http://127.0.0.1:${PORT}`;
const AIRPORTS = [
  '580,"Amsterdam Airport Schiphol","Amsterdam","Netherlands","AMS","EHAM",52.308601,4.76389,-11,1,"E","Europe/Amsterdam","airport","OurAirports"',
  '1229,"Adolfo Suárez Madrid–Barajas Airport","Madrid","Spain","MAD","LEMD",40.471926,-3.56264,1998,1,"E","Europe/Madrid","airport","OurAirports"',
  '1638,"Humberto Delgado Airport (Lisbon Portela Airport)","Lisbon","Portugal","LIS","LPPT",38.7813,-9.13592,374,0,"E","Europe/Lisbon","airport","OurAirports"',
].join('\n');

let dir, server;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-test-'));
  fs.copyFileSync(path.join(ROOT, 'app.js'), path.join(dir, 'app.js'));
  fs.copyFileSync(path.join(ROOT, 'ground.js'), path.join(dir, 'ground.js'));
  fs.copyFileSync(path.join(ROOT, 'default.config'), path.join(dir, 'default.config'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'airports.dat'), AIRPORTS);
  fs.writeFileSync(path.join(dir, 'data', 'flights.json'), JSON.stringify([
    { id: 1, date: '2026-11-16 16:10:00', from: 'AMS', to: 'LIS', flight_number: 'KL1234', airline: 'KLM', distance: 1, duration: '02:55' },
    { id: 2, date: '2026-11-20 10:00:00', from: 'LIS', to: 'AMS', flight_number: 'KL1235', airline: 'KLM', distance: 1, duration: '02:45' },
  ]));
  fs.writeFileSync(path.join(dir, 'config'), JSON.stringify({ port: PORT, ground_lookups: false }));
  fs.writeFileSync(path.join(dir, 'secret'), '{}');
  server = spawn(process.execPath, ['app.js'], {
    cwd: dir, env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/flights`); return; } catch (_) { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});

after(() => {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (method, p, body) => fetch(BASE + p, {
  method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
});

test('PUT merges fields and keeps id', async () => {
  const res = await call('PUT', '/api/flights/1', { id: 99, flight_number: 'KL1236', to: 'MAD' });
  assert.strictEqual(res.status, 200);
  const f = await res.json();
  assert.strictEqual(f.id, 1);
  assert.strictEqual(f.to, 'MAD');
  assert.strictEqual(f.flight_number, 'KL1236');
  assert.ok(f.distance > 1000, `distance recomputed, got ${f.distance}`);
  const all = await (await call('GET', '/api/flights')).json();
  assert.strictEqual(all.find(x => x.id === 1).to, 'MAD');
});

test('DELETE removes the flight', async () => {
  const res = await call('DELETE', '/api/flights/2');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { deleted: 2 });
  const all = await (await call('GET', '/api/flights')).json();
  assert.strictEqual(all.length, 1);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'flights.json'), 'utf8'));
  assert.strictEqual(onDisk.length, 1);
});

test('unknown id gives 404', async () => {
  assert.strictEqual((await call('PUT', '/api/flights/999', { to: 'AMS' })).status, 404);
  assert.strictEqual((await call('DELETE', '/api/flights/999')).status, 404);
});

test('ground trips: added, updated in place when posted again, edited and deleted', async () => {
  const bus = { date: '2026-10-24 13:15:00', mode: 'bus', from: 'Albufeira', to: 'Vila Nova de Milfontes', event_id: 'E1', source: 'flightmail' };
  const a = await (await call('POST', '/api/ground', bus)).json();
  assert.strictEqual(a.id, 1);
  assert.strictEqual((await call('POST', '/api/ground', { mode: 'bus', from: 'Faro' })).status, 400);

  // the same event again, renamed: one trip, its old place forgotten
  await call('PUT', '/api/ground/1', { from_lat: 37.09, from_lon: -8.25, to_lat: 37.72, to_lon: -8.78, path_source: 'straight' });
  const b = await (await call('POST', '/api/ground', { ...bus, from: 'Albufeira (Terminal)' })).json();
  assert.strictEqual(b.id, 1);
  assert.strictEqual(b.from_lat, undefined);
  assert.strictEqual(b.to_lat, 37.72);
  assert.strictEqual(b.path_source, undefined);

  // the same minute and mode is the same trip
  const train = { date: '2026-12-14 13:42:00', mode: 'train', service: 'EC9236', from: 'Breda', to: 'Bruxelles Midi', source: 'flightmail' };
  const c = await (await call('POST', '/api/ground', train)).json();
  const d = await (await call('POST', '/api/ground', { ...train, to: 'Brussel-Zuid', event_id: 'E2' })).json();
  assert.strictEqual(d.id, c.id);
  assert.strictEqual(d.to, 'Brussel-Zuid');
  assert.strictEqual(d.event_id, 'E2');

  assert.strictEqual((await (await call('GET', '/api/ground')).json()).length, 2);
  assert.deepStrictEqual(await (await call('DELETE', `/api/ground/${c.id}`)).json(), { deleted: c.id });
  assert.strictEqual((await call('PUT', `/api/ground/${c.id}`, { to: 'X' })).status, 404);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'ground.json'), 'utf8'));
  assert.deepStrictEqual(onDisk.map(t => t.id), [1]);
});

test('listens on 127.0.0.1 only', async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal);
  if (!lan) return t.skip('no non-loopback IPv4 address');
  const connected = await new Promise(resolve => {
    const s = net.connect(PORT, lan.address);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  assert.strictEqual(connected, false, `port ${PORT} reachable on ${lan.address}`);
});
