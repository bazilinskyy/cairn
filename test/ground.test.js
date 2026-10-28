'use strict';
// ground.js without the network: polylines, simplification, timetable dates, starting points, stale fields, a car's way
// through the photos.
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

test('Strava: an activity keeps its route as a 6-decimal polyline, and full listings replace the list', () => {
  const s = require('../strava');
  const a = s.toActivity({ id: 7, name: 'Morning Ride', sport_type: 'Ride', start_date: '2024-06-01T07:00:00Z',
    start_date_local: '2024-06-01T09:00:00Z', distance: 42195, moving_time: 5400, total_elevation_gain: 312.4,
    map: { summary_polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' } });
  assert.deepStrictEqual({ ...a, path: undefined, tiles: undefined }, { id: 7, name: 'Morning Ride', sport: 'Ride', date: '2024-06-01 09:00:00',
    start: 1717225200, distance: 42.2, moving_time: 5400, elevation: 312, elapsed_time: 0, heartrate: null, prs: 0, kudos: 0,
    commute: false, trainer: false, path: undefined, at: [38.5, -120.2], tiles: undefined });
  assert.ok(a.tiles.length > 100, 'every tile along 600 km of route');
  assert.deepStrictEqual(g.decode(a.path), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  assert.strictEqual(s.toActivity({ id: 8, type: 'Swim', start_date: '2024-06-02T07:00:00Z', map: {} }).path, '');
  // zoom-14 tiles (OpenStreetMap's numbering), packed x * 16384 + y: Eindhoven station is in tile 8441/5452; a 3 km
  // ride east passes through every tile on the way, also the one between
  assert.deepStrictEqual(s.tilesOf([[51.4433, 5.4797]]), [8441 * 16384 + 5452]);
  assert.deepStrictEqual(s.tilesOf([[51.4433, 5.4797], [51.4433, 5.52]]), [8441, 8442, 8443].map(x => x * 16384 + 5452));
  const old = [{ id: 1, start: 10 }, { id: 2, start: 20 }];
  assert.deepStrictEqual(s.merge(old, [{ id: 3, start: 30 }, { id: 2, start: 21 }], false).map(x => [x.id, x.start]), [[3, 30], [2, 21], [1, 10]]);
  assert.deepStrictEqual(s.merge(old, [{ id: 2, start: 20 }], true).map(x => x.id), [2]);  // 1 was deleted on Strava
});

test('cities: a place goes to the town that pulls hardest, an airport to its own city, days and visits counted', () => {
  const c = require('../cities'), fs = require('fs'), os = require('os'), path = require('path');
  const row = (id, name, alt, lat, lon, code, cc, pop) => [id, name, name, alt, lat, lon, 'P', code, cc, '', '', '', '', '', pop, '', '', 'Europe/X', '2024-01-01'].join('\t');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'towns-')), 'cities1000.txt');
  fs.writeFileSync(file, [row(1, 'Eindhoven', '', 51.4416, 5.4697, 'PPLA2', 'NL', 235000),
    row(2, 'Veldhoven', '', 51.4183, 5.4028, 'PPL', 'NL', 45000),
    row(3, 'Kyiv', 'Kiev,Kiew', 50.4501, 30.5234, 'PPLC', 'UA', 2900000),
    row(4, 'Boryspil', '', 50.3527, 30.9550, 'PPL', 'UA', 60000),
    row(5, 'Strijp', '', 51.445, 5.45, 'PPLX', 'NL', 30000)].join('\n'));
  const towns = c.load(file);
  assert.strictEqual(c.townAt(towns, 51.4183, 5.4028).name, 'Veldhoven');      // in Veldhoven itself
  assert.strictEqual(c.townAt(towns, 51.445, 5.45).name, 'Eindhoven');         // a part of town is its town
  assert.strictEqual(c.townAt(towns, 50.345, 30.894).name, 'Boryspil');        // the airport by place alone...
  assert.strictEqual(c.townNamed(towns, 'Kiev', 50.345, 30.894).name, 'Kyiv'); // ...and by its city's name
  assert.strictEqual(c.townAt(towns, 40, 0), null);
  const top = c.rank(towns, [
    { at: [51.44, 5.47], day: '2024-06-01' }, { at: [51.44, 5.47], day: '2024-06-02' }, { at: [51.42, 5.40], day: '2024-06-02' },
    { at: [51.44, 5.47], day: '2024-06-10' }, { at: [50.345, 30.894], day: '2024-07-01', city: 'Kiev' }]);
  assert.deepStrictEqual(top.map(t => [t.name, t.days, t.visits, t.first, t.last]), [
    ['Eindhoven', 3, 2, '2024-06-01', '2024-06-10'], ['Kyiv', 1, 1, '2024-07-01', '2024-07-01'], ['Veldhoven', 1, 1, '2024-06-02', '2024-06-02']]);
  assert.strictEqual(c.load(file + '.missing'), null);
  // picking a town by name: its own name before another spelling, then the biggest; by id
  assert.deepStrictEqual(c.search(towns, 'ki').map(t => t.name), ['Kyiv']);
  assert.deepStrictEqual(c.search(towns, 'e').map(t => t.name), []);  // too short
  assert.deepStrictEqual(c.search(towns, 'kie').map(t => t.name), ['Kyiv']);  // by another spelling
  assert.strictEqual(c.byId(towns, 2).name, 'Veldhoven');
  assert.strictEqual(c.byId(towns, 99), null);
  assert.strictEqual(c.biggestNamed(towns, 'Kiev').name, 'Kyiv');  // the trip's place: the biggest of that name
  assert.strictEqual(c.biggestNamed(towns, 'Nowhere'), null);
});

test('activities: an activity in Garmin and in Strava (started within two minutes, same kind) is kept once, from Garmin', () => {
  const { merge } = require('../activities');
  const garmin = [{ id: 1, sport: 'Ride', start: 1000000 }, { id: 2, sport: 'Run', start: 2000000 }];
  const strava = [{ id: 10, sport: 'Ride', start: 1000090 }, { id: 11, sport: 'Run', start: 1000000 }, { id: 12, sport: 'Ride', start: 3000000 }];
  assert.deepStrictEqual(merge(garmin, strava).map(a => a.id), [12, 2, 1, 11]);
});

test('a car journey goes through the photos on the way: between the ends, spread out, not a detour', () => {
  const lyon = [45.76, 4.84], valence = [44.93, 4.89];
  const photos = [[45.75, 4.85], [45.52, 4.87], [45.51, 4.87], [45.27, 4.83], [44.0, 6.5], [44.94, 4.89]];  // Lyon, Vienne twice, Saint-Vallier, the Alps, Valence
  assert.deepStrictEqual(g.viaPoints(lyon, valence, photos), [[45.52, 4.87], [45.27, 4.83]]);
  assert.deepStrictEqual(g.viaPoints(lyon, valence, []), []);
});
