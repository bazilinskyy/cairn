'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { create, dayOf } = require('../code');

// Lisbon (UTC+0 in winter) on 10 January 2026, Amsterdam (UTC+1) on the 11th; a flight between them that afternoon
const lisbon = { id: 1, name: 'Lisbon', cc: 'PT', lat: 38.72, lon: -9.14, tz: 'Europe/Lisbon' };
const amsterdam = { id: 2, name: 'Amsterdam', cc: 'NL', lat: 52.37, lon: 4.9, tz: 'Europe/Amsterdam' };
const t = s => Date.parse(s) / 1000;
const commits = [
  [t('2026-01-10T10:00:00Z'), 0, 'me/app', 'in Lisbon'],
  [t('2026-01-10T11:00:00Z'), 60, 'me/jobs', 'a job at home while away'],  // an Amsterdam clock that day: another computer
  [t('2026-01-10T15:00:00Z'), 0, 'me/app', 'over the Bay of Biscay'],
  [t('2026-01-10T23:30:00Z'), 60, 'me/app', 'after midnight on an Amsterdam clock'],  // the 11th where it was made
  [t('2026-02-01T09:00:00Z'), 60, 'me/app', 'a day with no place']
];
const code = create({
  read: () => ({ commits }), dayTowns: () => new Map([['2026-01-10', lisbon], ['2026-01-11', amsterdam]]),
  trips: () => [{ id: 't', name: 'Lisbon', start: '2026-01-09', end: '2026-01-11' }],
  flights: () => [{ id: 9, date: '2026-01-10 14:30:00', duration: '02:40', from: 'LIS', to: 'AMS', flight_number: 'TP662' }],
  airports: () => ({ LIS: { tz: 'Europe/Lisbon' }, AMS: { tz: 'Europe/Amsterdam' } }),
  home: () => amsterdam, km: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) * 111
});

test('a commit\'s day is the day on its own clock', () => {
  assert.strictEqual(dayOf(commits[3]), '2026-01-11');
  assert.strictEqual(dayOf(commits[0]), '2026-01-10');
});

test('commits in the towns of their days; another computer\'s clock and days with no place in none', () => {
  const s = code.summary();
  assert.deepStrictEqual([s.commits, s.placed, s.elsewhere, s.awayCommits], [5, 3, 1, 3]);
  assert.deepStrictEqual(s.countries.map(c => [c.cc, c.commits]), [['PT', 2], ['NL', 1]]);
  assert.deepStrictEqual(s.towns.map(x => [x.name, x.commits]), [['Lisbon', 2], ['Amsterdam', 1]]);
  assert.deepStrictEqual(s.trips.map(x => [x.id, x.commits]), [['t', 4]]);
  assert.strictEqual(s.farthest.town.name, 'Lisbon');
});

test('commits made between take-off and landing, on a clock of either end', () => {
  assert.deepStrictEqual(code.summary().air.map(a => [a.flight.flight_number, a.commits]), [['TP662', 1]]);
});

test('a trip\'s, a town\'s and a country\'s commits', () => {
  const trip = code.between('2026-01-09', '2026-01-11');
  assert.deepStrictEqual([trip.commits, trip.byDay], [4, { '2026-01-10': 3, '2026-01-11': 1 }]);
  assert.deepStrictEqual([code.inTown(1).commits, code.inTown(1).repos], [2, [['me/app', 2]]]);
  assert.deepStrictEqual(code.inCountry('NL').towns, [['Amsterdam', 1]]);
  assert.strictEqual(code.inCountry('FR'), null);
});
