'use strict';
// Trips (trips.js): days away from the home countries make a trip when it has a night in a stay, a flight or lasts
// three days; a ride over the border and back does not. Made-up towns: Eindhoven at home, Lisbon and Liège abroad.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cities = require('../cities');
const trips = require('../trips');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-trips-'));
const town = (id, name, cc, lat, lon) => [id, name, name, '', lat, lon, 'P', 'PPL', cc, '', '', '', '', '', 200000].join('\t');
fs.writeFileSync(path.join(dir, 'towns.txt'), [town(1, 'Eindhoven', 'NL', 51.44, 5.48), town(2, 'Lisbon', 'PT', 38.72, -9.14),
  town(3, 'Liège', 'BE', 50.63, 5.57)].join('\n'));
const grid = cities.load(path.join(dir, 'towns.txt'));
const airports = { EIN: { lat: 51.45, lon: 5.39, city: 'Eindhoven' }, LIS: { lat: 38.77, lon: -9.13, city: 'Lisbon' } };

function store({ flights = [], stays = [], points = [], photos = [], ground = [], towns = grid }) {
  return trips.create({
    towns: () => towns, cities, days: () => points, flights: () => flights, airports: () => airports, groundTrips: () => ground,
    stays: () => stays, activities: () => [], photos: () => photos, homeAirports: () => ['EIN'], file: path.join(dir, 'drives.json'), log: () => {}
  });
}

test('a flight out and back is one trip, all its days away, named after the country', () => {
  const t = store({ flights: [{ id: 1, date: '2026-11-16 10:00', from: 'EIN', to: 'LIS' }, { id: 2, date: '2026-11-20 18:00', from: 'LIS', to: 'EIN' }],
    points: [{ at: [38.72, -9.14], day: '2026-11-17' }] }).list();
  assert.strictEqual(t.length, 1);
  assert.deepStrictEqual([t[0].start, t[0].end, t[0].days, t[0].flights], ['2026-11-16', '2026-11-20', 5, 2]);
  assert.strictEqual(t[0].name, 'Portugal');
});

test('a day over the border is no trip; a night in a stay there is', () => {
  const ride = [{ at: [50.63, 5.57], day: '2026-05-02' }];
  assert.strictEqual(store({ points: ride }).list().length, 0);
  const t = store({ points: ride, stays: [{ id: 1, what: 'stay', start: '2026-05-02', end: '2026-05-03', lat: 50.63, lon: 5.57 }] }).list();
  assert.deepStrictEqual([t[0].start, t[0].end, t[0].nights], ['2026-05-02', '2026-05-03', 1]);
});

test('local clock times are read with a zone guessed from the longitude', () => {
  assert.strictEqual(trips.localToUnix('2026-11-16 10:00', 0), Date.parse('2026-11-16T10:00:00Z') / 1000);
  assert.strictEqual(trips.localToUnix('2026-11-16 10:00', 120), Date.parse('2026-11-16T02:00:00Z') / 1000);
});

test('the times of a flight are read in the zone of its airport, summer time included: a photo from the plane is on the way', () => {
  const zoned = (id, name, cc, lat, lon, tz) => [id, name, name, '', lat, lon, 'P', 'PPL', cc, '', '', '', '', '', 200000, '', '', tz].join('\t');
  const file = path.join(dir, 'zoned.txt');
  fs.writeFileSync(file, [zoned(1, 'Eindhoven', 'NL', 51.44, 5.48, 'Europe/Amsterdam'), zoned(2, 'Lisbon', 'PT', 38.72, -9.14, 'Europe/Lisbon')].join('\n'));
  // off at 10:00 in Eindhoven (08:00 UTC; 10:00 UTC by its longitude), a photo high over France at 08:45 UTC
  const s = store({ towns: cities.load(file), photos: [[1, Date.parse('2026-07-01T08:45:00Z') / 1000, 44.8, -0.6]],
    flights: [{ id: 1, date: '2026-07-01 10:00', from: 'EIN', to: 'LIS' }, { id: 2, date: '2026-07-05 18:00', from: 'LIS', to: 'EIN' }] });
  const moves = s.get(s.list()[0].id).moves;
  assert.ok(!moves.some(m => [m.from, m.to].some(at => Math.abs(at[0] - 44.8) < 0.01)), 'no way to the photo and on');
});

test('a rental car abroad is not driven at home: not on the way to the airport before landing, nor after the flight home', () => {
  const car = { id: 1, what: 'car', start: '2026-03-01', end: '2026-03-06', lat: 38.77, lon: -9.13 };  // picked up at Lisbon's airport
  const at = (iso, lat, lon, id) => [id, Date.parse(iso) / 1000, lat, lon];
  const s = store({ stays: [car],
    flights: [{ id: 1, date: '2026-03-01 12:00', from: 'EIN', to: 'LIS', duration: '02:50' }, { id: 2, date: '2026-03-06 12:00', from: 'LIS', to: 'EIN', duration: '02:40' }],
    photos: [at('2026-03-01T07:00:00Z', 51.99, 4.36, 1), at('2026-03-01T09:30:00Z', 51.45, 5.38, 2),   // to the airport at home that morning
      at('2026-03-03T10:00:00Z', 38.72, -9.14, 3), at('2026-03-03T16:00:00Z', 40.21, -8.43, 4),         // driving in Portugal
      at('2026-03-06T16:00:00Z', 51.45, 5.38, 5), at('2026-03-06T19:00:00Z', 51.99, 4.36, 6)] });      // home by train that evening
  const moves = s.get(s.list()[0].id).moves.filter(m => m.km >= 10);
  const kind = (lat, day) => moves.filter(m => Math.abs(m.from[0] - lat) < 0.6 && new Date(m.t0 * 1000).toISOString().startsWith(day)).map(m => m.kind);
  assert.ok(kind(51.7, '2026-03-01').length && !kind(51.7, '2026-03-01').includes('drive'), 'the morning at home was not by car');
  assert.ok(kind(51.7, '2026-03-06').length && !kind(51.7, '2026-03-06').includes('drive'), 'the evening at home was not by car');
  assert.ok(moves.some(m => m.kind === 'drive' && Math.abs(m.to[0] - 40.21) < 0.01), 'the drive in Portugal still is');
});

test('a car for the day you fly home is driven before the flight, not after landing at home', () => {
  const car = { id: 1, what: 'car', start: '2026-03-06', end: '2026-03-07', lat: 38.77, lon: -9.13 };
  const at = (iso, lat, lon, id) => [id, Date.parse(iso) / 1000, lat, lon];
  const s = store({ stays: [car],
    flights: [{ id: 1, date: '2026-03-01 12:00', from: 'EIN', to: 'LIS', duration: '02:50' }, { id: 2, date: '2026-03-06 16:00', from: 'LIS', to: 'EIN', duration: '02:40' }],
    photos: [at('2026-03-06T08:00:00Z', 38.72, -9.14, 1), at('2026-03-06T11:00:00Z', 38.70, -9.42, 2),    // a drive out that morning
      at('2026-03-06T20:00:00Z', 51.45, 5.38, 3), at('2026-03-06T22:00:00Z', 51.99, 4.36, 4)] });          // home by train after
  const moves = s.get(s.list()[0].id).moves.filter(m => m.km >= 10);
  assert.ok(moves.some(m => m.kind === 'drive' && Math.abs(m.to[1] + 9.42) < 0.01), 'the drive that morning');
  assert.ok(!moves.some(m => m.kind === 'drive' && m.from[0] > 50), 'nothing at home by car');
});

test('a car from the morning after an evening in town: the way out that morning was driven, and on that day', () => {
  const room = { id: 1, what: 'stay', start: '2026-03-01', end: '2026-03-02', lat: 38.72, lon: -9.14 };   // left that morning
  const car = { id: 2, what: 'car', start: '2026-03-02', end: '2026-03-02', lat: 38.72, lon: -9.14 };    // a day's road trip
  const at = (iso, lat, lon, id) => [id, Date.parse(iso) / 1000, lat, lon];
  const s = store({ stays: [room, car],
    photos: [at('2026-03-01T15:00:00Z', 38.72, -9.14, 1), at('2026-03-01T19:00:00Z', 38.721, -9.141, 2),   // in town that evening
      at('2026-03-02T09:00:00Z', 38.80, -9.38, 3), at('2026-03-02T15:00:00Z', 38.72, -9.14, 4)] });       // out and back the next day
  const out = s.get(s.list()[0].id).moves.find(m => Math.abs(m.to[1] + 9.38) < 0.01);
  assert.equal(out.kind, 'drive');
  assert.ok(new Date(out.t0 * 1000).toISOString().startsWith('2026-03-02'), 'on the day of the car');
});

test('a day trip with the car on a short ferry: driven to the ferry and on from it, not picked up off it', () => {
  const room = { id: 1, what: 'stay', start: '2026-03-01', end: '2026-03-03', lat: 38.72, lon: -9.14 };
  const car = { id: 2, what: 'car', start: '2026-03-02', end: '2026-03-02', lat: 38.72, lon: -9.14 };
  const at = (iso, lat, lon, id) => [id, Date.parse(iso) / 1000, lat, lon];
  const s = store({ stays: [room, car],
    ground: [{ id: 1, mode: 'ferry', date: '2026-03-02 13:00', arrival: '2026-03-02 13:20', from_lat: 38.705, from_lon: -9.145, to_lat: 38.688, to_lon: -9.148 }],
    photos: [at('2026-03-02T11:00:00Z', 38.697, -9.206, 1), at('2026-03-02T16:00:00Z', 38.52, -8.89, 2)] });   // Belém; Setúbal
  const moves = s.get(s.list()[0].id).moves.filter(m => new Date(m.t0 * 1000).toISOString().startsWith('2026-03-02') && m.km >= 2);
  assert.ok(moves.some(m => m.kind === 'drive' && Math.abs(m.to[0] - 38.705) < 0.01), 'to the ferry by car');
  assert.ok(moves.some(m => m.kind === 'drive' && Math.abs(m.from[0] - 38.688) < 0.01 && Math.abs(m.to[0] - 38.52) < 0.01), 'on from it by car');
});

test('island to island: a ferry with its times ends one car and starts the next, waiting at the port; a slow hop by car', () => {
  const carA = { id: 1, what: 'car', start: '2026-03-01', end: '2026-03-03', lat: 38.72, lon: -9.14 };   // the first island's car
  const carB = { id: 2, what: 'car', start: '2026-03-03', end: '2026-03-05', lat: 38.53, lon: -8.89 };   // the next one's, at its port
  const at = (iso, lat, lon, id) => [id, Date.parse(iso) / 1000, lat, lon];
  const s = store({ stays: [carA, carB],
    flights: [{ id: 1, date: '2026-03-01 08:00', from: 'EIN', to: 'LIS', duration: '02:50' }],
    ground: [{ id: 1, mode: 'ferry', date: '2026-03-03 12:00', arrival: '2026-03-03 13:30', from: 'A', to: 'B', from_lat: 38.70, from_lon: -9.15, to_lat: 38.53, to_lon: -8.89, distance: 30 }],
    photos: [at('2026-03-03T08:00:00Z', 38.72, -9.14, 1), at('2026-03-03T09:00:00Z', 38.76, -9.30, 2),   // a drive on the first island
      at('2026-03-03T15:00:00Z', 38.53, -8.90, 3), at('2026-03-03T17:00:00Z', 38.49, -8.81, 4)] });     // off the ferry, then 8 km in two hours
  const moves = s.get(s.list()[0].id).moves.filter(m => m.km >= 2 && new Date(m.t0 * 1000).toISOString().startsWith('2026-03-03'));
  assert.ok(!moves.some(m => (m.from[1] < -9 && m.to[1] > -8.95) || (m.from[1] > -8.95 && m.to[1] < -9)), 'no drive across the water');
  assert.ok(moves.some(m => m.kind === 'drive' && Math.abs(m.to[1] + 9.30) < 0.01), 'the first island by car');
  assert.ok(moves.some(m => m.kind === 'drive' && Math.abs(m.to[1] + 8.81) < 0.01), 'the slow hop on the next one by car too');
  assert.ok(!moves.some(m => m.t0 > Date.parse('2026-03-03T15:00:00Z') / 1000 && Math.abs(m.to[1] + 8.89) < 0.005), 'no way back to the car at the port');
});

test('a room kept in town while sleeping elsewhere: its check-out that day is not where you were', () => {
  const room = { id: 1, what: 'stay', start: '2026-03-01', end: '2026-03-06', lat: 38.72, lon: -9.14 };   // Lisbon
  const away = { id: 2, what: 'stay', start: '2026-03-05', end: '2026-03-06', lat: 40.21, lon: -8.43 };   // a night 200 km off
  const s = store({ flights: [{ id: 1, date: '2026-03-01 10:00', from: 'EIN', to: 'LIS' }, { id: 2, date: '2026-03-06 18:00', from: 'LIS', to: 'EIN' }],
    stays: [room, away] });
  const id = s.list()[0].id, out = trips.localToUnix('2026-03-06 10:00', -9.14);
  assert.ok(!s.get(id).moves.some(m => m.t1 === out && Math.abs(m.to[0] - 38.72) < 0.01), 'no way back to the room at its check-out');
});
