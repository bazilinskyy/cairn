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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-test-'));
  fs.copyFileSync(path.join(ROOT, 'app.js'), path.join(dir, 'app.js'));
  fs.copyFileSync(path.join(ROOT, 'ground.js'), path.join(dir, 'ground.js'));
  fs.copyFileSync(path.join(ROOT, 'strava.js'), path.join(dir, 'strava.js'));
  fs.copyFileSync(path.join(ROOT, 'cities.js'), path.join(dir, 'cities.js'));
  fs.copyFileSync(path.join(ROOT, 'activities.js'), path.join(dir, 'activities.js'));
  fs.copyFileSync(path.join(ROOT, 'regions.js'), path.join(dir, 'regions.js'));
  fs.copyFileSync(path.join(ROOT, 'country-lists.json'), path.join(dir, 'country-lists.json'));
  ['climbs.js', 'ascents.js', 'efforts.js', 'climbs.json', 'photos.js', 'climb_records.json', 'trips.js', 'weather.js', 'stats.js', 'lastfm.js', 'suggestions.js'].forEach(f => fs.copyFileSync(path.join(ROOT, f), path.join(dir, f)));
  fs.copyFileSync(path.join(ROOT, 'default.config'), path.join(dir, 'default.config'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'airports.dat'), AIRPORTS);
  fs.writeFileSync(path.join(dir, 'data', 'flights.json'), JSON.stringify([
    { id: 1, date: '2026-11-16 16:10:00', from: 'AMS', to: 'LIS', flight_number: 'KL1234', airline: 'KLM', distance: 1, duration: '02:55' },
    { id: 2, date: '2026-11-20 10:00:00', from: 'LIS', to: 'AMS', flight_number: 'KL1235', airline: 'KLM', distance: 1, duration: '02:45' },
  ]));
  const square = (iso, code, lat, lon) => ({ type: 'Feature', properties: { iso_a2: iso, adm0_a3: '', iso_3166_2: code, adm1_code: code },
    geometry: { type: 'Polygon', coordinates: [[[lon - 1, lat - 1], [lon + 1, lat - 1], [lon + 1, lat + 1], [lon - 1, lat + 1], [lon - 1, lat - 1]]] } });
  fs.writeFileSync(path.join(dir, 'data', 'admin1.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
    square('NL', 'NL-NH', 52.3, 4.8), square('PT', 'PT-11', 38.8, -9.1), square('ES', 'ES-TF', 28.4, -16.5)] }));
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

test('stays: one per booking code, a new place forgets the old position', async () => {
  const faro = { code: 'B1', what: 'stay', provider: 'Booking.com', place: 'Faro', country: 'Portugal', start: '2026-10-22', end: '2026-10-23', type: 'Hostel' };
  const a = await (await call('POST', '/api/stays', faro)).json();
  await call('PUT', `/api/stays/${a.id}`, { lat: 37.02, lon: -7.93 });
  const b = await (await call('POST', '/api/stays', { ...faro, end: '2026-10-24' })).json();
  assert.strictEqual(b.id, a.id);
  assert.strictEqual(b.lat, 37.02);  // same place: position kept
  const c = await (await call('POST', '/api/stays', { ...faro, place: 'Olhão' })).json();
  assert.strictEqual(c.lat, undefined);
  assert.strictEqual((await call('POST', '/api/stays', { code: 'X' })).status, 400);
  assert.strictEqual((await (await call('GET', '/api/stays')).json()).length, 1);
  assert.deepStrictEqual(await (await call('DELETE', `/api/stays/${a.id}`)).json(), { deleted: a.id });
  assert.strictEqual((await call('DELETE', `/api/stays/${a.id}`)).status, 404);
});

test('photos and Timeline come from the import files, read again when they change', async () => {
  assert.deepStrictEqual(await (await call('GET', '/api/photos')).json(), []);
  assert.deepStrictEqual(await (await call('GET', '/api/timeline')).json(), { visits: [], paths: [] });
  const cells = [{ lat: 51.44, lon: 5.47, year: 2024, count: 2, days: ['2024-06-01'] }];
  fs.writeFileSync(path.join(dir, 'data', 'photos.json'), JSON.stringify(cells));
  assert.deepStrictEqual(await (await call('GET', '/api/photos')).json(), cells);
  assert.deepStrictEqual(await (await call('GET', '/api/settings')).json(), { home_airports: ['AMS', 'EIN', 'RTM'] });
});

test('activities: Strava not set up, then the Garmin file read when it appears, gzipped and cached', async () => {
  const strava = { configured: false, connected: false, athlete: '', count: 0, last_sync: '', error: '' };
  assert.deepStrictEqual(await (await call('GET', '/api/strava/status')).json(), strava);
  assert.deepStrictEqual(await (await call('GET', '/api/activities')).json(), []);
  assert.strictEqual((await fetch(BASE + '/auth/strava', { redirect: 'manual' })).status, 503);
  const ride = { id: 1, name: 'Ride', sport: 'Ride', date: '2024-06-01 09:00:00', start: 1717225200, distance: 15, moving_time: 2900,
    elevation: 42, path: '', at: null, tiles: [] };
  fs.writeFileSync(path.join(dir, 'data', 'garmin.json'), JSON.stringify({ activities: [ride], last_sync: '2024-06-01T10:00:00Z' }));
  const res = await fetch(BASE + '/api/activities', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.deepStrictEqual(await res.json(), [ride]);
  const again = await fetch(BASE + '/api/activities', { headers: { 'If-None-Match': res.headers.get('etag') } });
  assert.strictEqual(again.status, 304);
  assert.deepStrictEqual((await (await call('GET', '/api/activities/status')).json()).garmin,
    { count: 1, last_sync: '2024-06-01T10:00:00Z', error: '', error_at: '' });
});

test('climbs: none without rides', async () => {
  assert.deepStrictEqual(await (await call('GET', '/api/climbs')).json(), []);
});

test('cities: none without the town list', async () => {
  assert.deepStrictEqual(await (await call('GET', '/api/cities?from=2024-01-01')).json(), []);
});

test('stays: a mail for a stay from the Booking.com export takes it over and keeps the hotel position', async () => {
  const hotel = await (await call('POST', '/api/stays', { code: 'bk-1', what: 'stay', place: 'Ixelles', country: 'BE', start: '2025-04-29',
    end: '2025-04-30', hotel: 'Hotel X', lat: 50.83, lon: 4.37, source: 'booking' })).json();
  for (let i = 0; i < 2; i++) {  // the confirmation, then a reminder for the same booking
    const s = await (await call('POST', '/api/stays', { code: '5555555555', what: 'stay', provider: 'Booking.com', place: 'Brussels',
      country: 'Belgium', start: '2025-04-29', end: '2025-04-30', price: '€ 90' })).json();
    assert.deepStrictEqual([s.id, s.code, s.place, s.lat, s.hotel, s.price], [hotel.id, '5555555555', 'Ixelles', 50.83, 'Hotel X', '€ 90']);
  }
  const all = await (await call('GET', '/api/stays')).json();
  assert.strictEqual(all.filter(s => s.start === '2025-04-29').length, 1);
  await call('DELETE', `/api/stays/${hotel.id}`);
});

test('stays: one deleted stays deleted when its booking is sent again', async () => {
  const s = await (await call('POST', '/api/stays', { code: 'GONE1', what: 'stay', place: 'Split', start: '2020-04-03', end: '2020-04-05' })).json();
  await call('DELETE', `/api/stays/${s.id}`);
  const again = await (await call('POST', '/api/stays', { code: 'GONE1', what: 'stay', place: 'Split', start: '2020-04-03', end: '2020-04-05' })).json();
  assert.strictEqual(again.ignored, 'deleted before');
  assert.ok(!(await (await call('GET', '/api/stays')).json()).some(x => x.code === 'GONE1'));
});

test('countries as each list counts them: a stay on Tenerife is Spain, or the Canary Islands', async () => {
  const stay = await (await call('POST', '/api/stays', { code: 'TF1', what: 'stay', place: 'Adeje', start: '2026-11-17', end: '2026-11-19', lat: 28.12, lon: -16.73 })).json();
  const names = async scheme => {
    const r = await (await call('GET', `/api/regions?scheme=${scheme}`)).json();
    return [r.total, r.places.map(p => p.name).sort()];
  };
  assert.deepStrictEqual(await names('iso'), [250, ['Netherlands', 'Portugal', 'Spain']]);
  assert.deepStrictEqual(await names('un'), [200, ['Netherlands', 'Portugal', 'Spain']]);
  assert.deepStrictEqual(await names('tcc'), [330, ['Canary Islands', 'Netherlands', 'Portugal']]);
  const r = await (await call('GET', '/api/regions?scheme=tcc&from=2026-11-17&to=2026-11-19')).json();
  const canary = r.places.find(p => p.name === 'Canary Islands');
  assert.deepStrictEqual([r.places.length, canary.days, canary.first, canary.shape.type], [1, 3, '2026-11-17', 'MultiPolygon']);
  await call('DELETE', `/api/stays/${stay.id}`);
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
