'use strict';
// Suggestions (suggestions.js): photos in Paris one day and in Brussels the next, with nothing connecting them, make
// a leg to add; a train between them, or moves inside the home country, do not

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cities = require('../cities');
const suggestions = require('../suggestions');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-sugg-'));
const town = (id, name, cc, lat, lon) => [id, name, name, '', lat, lon, 'P', 'PPL', cc, '', '', '', '', '', 500000].join('\t');
fs.writeFileSync(path.join(dir, 'towns.txt'), [town(1, 'Paris', 'FR', 48.86, 2.35), town(2, 'Brussels', 'BE', 50.85, 4.35),
  town(3, 'Delft', 'NL', 52.01, 4.36), town(4, 'Eindhoven', 'NL', 51.44, 5.48)].join('\n'));
const grid = cities.load(path.join(dir, 'towns.txt'));
const t = s => Date.parse(s) / 1000;
const photos = [['a', t('2019-07-12T10:00:00Z'), 48.86, 2.35], ['b', t('2019-07-12T15:00:00Z'), 48.85, 2.34],
  ['c', t('2019-07-13T11:00:00Z'), 50.85, 4.35], ['d', t('2019-08-01T10:00:00Z'), 52.01, 4.36], ['e', t('2019-08-01T18:00:00Z'), 51.44, 5.48]];

function make(groundTrips = []) {
  return suggestions.create({ towns: () => grid, cities, photos: () => photos, flights: () => [], airports: () => ({ EIN: { lat: 51.45, lon: 5.39 } }),
    groundTrips: () => groundTrips, activities: () => [], stays: () => [], homeAirports: () => ['EIN'], dismissedFile: path.join(dir, 'dismissed.json') });
}

test('Paris to Brussels is suggested; not Brussels to Delft (19 days later: unknown) nor Delft to Eindhoven (at home)', () => {
  const list = make().list();
  assert.deepStrictEqual(list.map(s => `${s.from}>${s.to}`), ['Paris>Brussels']);
  const s = list[0];
  assert.deepStrictEqual([s.from_day, s.to_day, s.photos, s.last_photo, s.first_photo], ['2019-07-12', '2019-07-13', [2, 1], 'b', 'c']);
});

test('a train between them, or saying it was no trip, takes it away', () => {
  assert.ok(!make([{ mode: 'train', date: '2019-07-13 09:00:00', from_lat: 48.88, from_lon: 2.36, to_lat: 50.84, to_lon: 4.36 }]).list().some(s => s.from === 'Paris'));
  const m = make();
  m.dismiss(m.list().find(s => s.from === 'Paris').key);
  assert.ok(!m.list().some(s => s.from === 'Paris'));
});
