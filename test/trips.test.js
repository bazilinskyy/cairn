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

function store({ flights = [], stays = [], points = [] }) {
  return trips.create({
    towns: () => grid, cities, days: () => points, flights: () => flights, airports: () => airports, groundTrips: () => [],
    stays: () => stays, activities: () => [], photos: () => [], homeAirports: () => ['EIN'], file: path.join(dir, 'drives.json'), log: () => {}
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
