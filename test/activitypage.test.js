'use strict';
// An activity's page (activitypage.js): its numbers, towns, profile, and what happened while it lasted. A made-up ride.

const { test } = require('node:test');
const assert = require('node:assert');
const ground = require('../ground');
const page = require('../activitypage');

const route = [[38.72, -9.14], [38.75, -9.10], [38.78, -9.14], [38.7201, -9.1401]];   // out and back to the start
const start = Date.UTC(2026, 2, 1, 9) / 1000;
const ride = { id: '7', name: 'Lisbon Cycling', sport: 'Ride', source: 'garmin', date: '2026-03-01 09:00:00', start: String(start),
  distance: '16.5', moving_time: '3000', elapsed_time: '3600', elevation: '120', heartrate: '140', trainer: 'False', path: ground.encode(route) };
const track = { start, t: [0, 600, 1200, 1800, 2400, 3000], pts: [route[0], route[1], route[1], route[2], route[2], route[3]],
  alt: [10, 60, 60, 110, 110, 12], hr: [120, 150, 0, 160, 140, 130], pw: [180, 250, 0, 300, 200, 150] };

function create(extra = {}) {
  return page.create({ list: () => [ride], track: id => (id === '7' ? track : null), weather: () => ({ 7: { temp: 18 } }),
    climbs: () => [{ id: 'Q1', name: 'A hill', ele: 110, country: 'PT', rides: [{ id: 7 }] }, { id: 'Q2', name: 'Another', rides: [{ id: 8 }] }],
    photos: () => [[1, start + 1200, 38.75, -9.10, 0], [2, start + 9000, 38.72, -9.14, 0]],
    plays: (from, to) => [[start + 60, 'An artist', 'A song'], [start + 7200, 'Later', 'Not on the ride']].filter(p => p[0] >= from && p[0] <= to),
    townAt: () => ({ id: 2, name: 'Lisbon', cc: 'PT' }), trips: () => [{ id: '2026-02-28', name: 'Portugal', start: '2026-02-28', end: '2026-03-04' }],
    day: d => (d === '2026-03-01' ? { sleep: 27000, rhr: 50 } : null), ...extra });
}

test('a ride in full: numbers, a loop from its town, the trip, the night before', () => {
  const a = create().get('7');
  assert.deepStrictEqual([a.distance, a.moving_time, a.elevation, a.loop, a.from.name, a.trip.name, a.day.rhr, a.weather.temp],
    [16.5, 3000, 120, true, 'Lisbon', 'Portugal', 50, 18]);
  assert.strictEqual(create().get('nothing'), null);
});

test('its profile from the timed track: height, speed, heart rate and power, the zeros (stops) left out of the averages', () => {
  const p = create().get('7').profile;
  assert.strictEqual(p.points.length, 6);
  assert.deepStrictEqual([p.alt.min, p.alt.max, p.hr.max, p.power.max, p.power.avg], [10, 110, 160, 300, 216]);
  assert.ok(p.km > 10 && p.maxKmh > 0, `${p.km} km, ${p.maxKmh} km/h`);
});

test('only what happened while it lasted: its photos, its music, the climbs it went up', () => {
  const a = create().get('7');
  assert.deepStrictEqual(a.photos.map(x => x.id), [1]);
  assert.deepStrictEqual(a.music.map(m => m.name), ['A song']);
  assert.deepStrictEqual(a.climbs.map(c => c.name), ['A hill']);
});

test('without a timed track: no profile, the rest still there', () => {
  const a = create({ track: () => null }).get('7');
  assert.strictEqual(a.profile, null);
  assert.strictEqual(a.distance, 16.5);
});
