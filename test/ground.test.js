'use strict';
// ground.js without the network: polylines, simplification, timetable dates, starting points, stale fields.
const { test } = require('node:test');
const assert = require('node:assert');
const g = require('../ground');

test('polyline6 round trip', () => {
  const pts = [[51.5955, 4.7799], [51.2, 4.5], [50.8357, 4.3364], [-33.9, 151.2]];
  const back = g.decode(g.encode(pts));
  pts.forEach((p, i) => { assert.ok(Math.abs(p[0] - back[i][0]) < 1e-6 && Math.abs(p[1] - back[i][1]) < 1e-6); });
  assert.deepStrictEqual(g.decode('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('simplify keeps the ends and the corners only', () => {
  const line = Array.from({ length: 11 }, (_, i) => [50, 4 + i * 0.01]);
  assert.deepStrictEqual(g.simplify(line), [[50, 4], [50, 4.1]]);
  const corner = [...line, [50.1, 4.1], [50.2, 4.1]];
  assert.deepStrictEqual(g.simplify(corner), [[50, 4], [50, 4.1], [50.2, 4.1]]);
});

test('a track must start and end at the stations without a long detour', () => {
  const a = [51.59, 4.78], b = [50.84, 4.34];
  assert.ok(g.plausible([a, [51.2, 4.5], b], a, b));
  assert.ok(!g.plausible([[52.37, 4.9], b], a, b));
  assert.ok(!g.plausible([a, [45, 10], b], a, b));
});

test('past trips are looked up on the same weekday in the coming week', () => {
  const today = new Date(Date.UTC(2026, 9, 24));  // a Saturday
  assert.strictEqual(g.planTime('2026-12-14 13:42:00', today), '2026-12-14T13:42:00Z');
  assert.strictEqual(g.planTime('2021-10-01 14:30:00', today), '2026-10-30T14:30:00Z');  // a Friday
  assert.strictEqual(g.planTime('2026-10-26 08:00:00', today), '2026-10-26T08:00:00Z');
  assert.strictEqual(g.planTime('2026-10-25 08:00:00', today), '2026-11-01T08:00:00Z');  // tomorrow: too soon
  assert.strictEqual(g.planTime('', today), null);
});

test('a trip starts near the last arrival of the three weeks before it', () => {
  const airports = { AMS: { lat: 52.3, lon: 4.76 }, VDE: { lat: 27.81, lon: -17.89 } };
  const flights = [{ date: '2023-12-20 10:00:00', from: 'AMS', to: 'VDE' }, { date: '2024-01-10 10:00:00', from: 'VDE', to: 'AMS' }];
  const before = { date: '2023-12-23 09:00:00', to_lat: 28.09, to_lon: -17.11 };
  const trip = { date: '2023-12-24 10:15:00' };
  assert.deepStrictEqual(g.startNear(trip, flights, [before, trip], airports), [28.09, -17.11]);
  assert.deepStrictEqual(g.startNear(trip, flights, [trip], airports), [27.81, -17.89]);
  assert.strictEqual(g.startNear({ date: '2024-03-01 10:00:00' }, flights, [], airports), null);
});

test('a new station name forgets its place and the track', () => {
  const t = { from: 'Faro', to: 'Lagos', from_lat: 37, from_lon: -7.9, to_lat: 37.1, to_lon: -8.7, path: 'x', path_source: 'osrm' };
  g.forget(t, { to: 'Sagres' });
  assert.deepStrictEqual([t.from_lat, t.to_lat, t.path, t.path_source], [37, undefined, undefined, undefined]);
  const u = { from: 'Faro', to: 'Lagos', from_lat: 37, from_lon: -7.9, path: 'x', path_source: 'osrm' };
  g.forget(u, { from: 'Faro', note: 'window seat' });
  assert.strictEqual(u.path, 'x');
});

test('the place: Photon first, an exact name only when it is more of a place or as near', () => {
  const c = (name, key, value, lat, lon) => ({ name: name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase(), key, value, at: [lat, lon] });
  const pirot = [c('Пирот', 'place', 'city', 43.15, 22.59), c('Pirot', 'place', 'hamlet', 46.19, 4.36)];
  assert.deepStrictEqual(g.pick(pirot, 'Pirot', { bias: [43.29, 22.01], maxKm: 1500 }).at, [43.15, 22.59]);
  const malaga = [c('Malaga', 'place', 'isolated_dwelling', 43.9, -0.18), c('Malagarriga', 'place', 'locality', 41.4, 1.16),
    c('Málaga', 'place', 'municipality', 36.76, -4.44)];
  assert.deepStrictEqual(g.pick(malaga, 'Malaga', { bias: [41.19, 1.27], maxKm: 1500 }).at, [36.76, -4.44]);
  const sanAndres = [c('San Andrés y Sauces', 'boundary', 'administrative', 28.78, -17.79), c('San Andrés', 'place', 'hamlet', 27.77, -17.96)];
  assert.deepStrictEqual(g.pick(sanAndres, 'San Andres', { bias: [27.81, -17.92], maxKm: 1500 }).at, [27.77, -17.96]);
  sanAndres.push(c('San Andrés', 'place', 'village', 28.51, -16.19));  // also a village on Tenerife: the nearer one
  assert.deepStrictEqual(g.pick(sanAndres, 'San Andres', { bias: [27.81, -17.92], maxKm: 1500 }).at, [27.77, -17.96]);
  const petrovac = [c('Petrovac na Moru', 'place', 'town', 42.21, 18.94), c('Petrovac', 'place', 'suburb', 45.85, 17.39)];
  assert.deepStrictEqual(g.pick(petrovac, 'Petrovac', { bias: [44.82, 20.46], maxKm: 1500 }).at, [42.21, 18.94]);
  const riep = [c('Ried am Riederberg', 'place', 'village', 48.3, 16.1)];
  assert.strictEqual(g.pick(riep, 'Siem Riep', {}), undefined);
  const siem = [c('Siem', 'place', 'village', 5.57, 95.4)];
  assert.strictEqual(g.pick(siem, 'Siem', { shortened: true }), undefined);
  const airports = [c('Αερολιμένας Λήμνου', 'aeroway', 'aerodrome', 39.92, 25.24), c('Κως', 'aeroway', 'aerodrome', 36.79, 27.09)];
  assert.deepStrictEqual(g.pick(airports, 'airport', { bias: [36.9, 27.29], maxKm: 1500, anyAirport: true }).at, [36.79, 27.09]);
  assert.deepStrictEqual(g.pick([c('Brussels Airport', 'aeroway', 'aerodrome', 50.9, 4.48)], 'Brussels Zaventem Airport', {}).at, [50.9, 4.48]);
});

test('similar names: typos and longer names yes, other places no', () => {
  assert.ok(g.similar('Isntabul', 'istanbul'));
  assert.ok(g.similar('Paris Nord', 'paris gare du nord'));
  assert.ok(g.similar('Bruxelles Midi', 'bruxelles-midi - brussel-zuid'));
  assert.ok(g.similar('Bangkok', 'กรุงเทพมหานคร'));  // another script: cannot tell
  assert.ok(g.similar('Bucharest', 'bucuresti') && g.similar('Munich', 'munchen'));
  assert.ok(!g.similar('Siem Riep', 'ried am riederberg'));
  assert.ok(!g.similar('Kaunas', 'tallinn'));
});
