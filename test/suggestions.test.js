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
  town(3, 'Delft', 'NL', 52.01, 4.36), town(4, 'Eindhoven', 'NL', 51.44, 5.48), town(5, 'San Francisco', 'US', 37.77, -122.42),
  town(6, 'Los Angeles', 'US', 34.05, -118.24)].join('\n'));
const grid = cities.load(path.join(dir, 'towns.txt'));
const t = s => Date.parse(s) / 1000;
const photos = [['a', t('2019-07-12T10:00:00Z'), 48.86, 2.35], ['b', t('2019-07-12T15:00:00Z'), 48.85, 2.34],
  ['c', t('2019-07-13T11:00:00Z'), 50.85, 4.35], ['d', t('2019-08-01T10:00:00Z'), 52.01, 4.36], ['e', t('2019-08-01T18:00:00Z'), 51.44, 5.48]];

function make(groundTrips = [], fromPlane) {
  return suggestions.create({ towns: () => grid, cities, photos: () => photos, flights: () => [], airports: () => ({ EIN: { lat: 51.45, lon: 5.39 } }),
    groundTrips: () => groundTrips, activities: () => [], stays: () => [], homeAirports: () => ['EIN'], dismissedFile: path.join(dir, 'dismissed.json'), fromPlane });
}

test('Paris to Brussels is suggested; not Brussels to Delft (19 days later: unknown) nor Delft to Eindhoven (at home)', () => {
  const list = make().list();
  assert.deepStrictEqual(list.map(s => `${s.from}>${s.to}`), ['Paris>Brussels']);
  const s = list[0];
  assert.deepStrictEqual([s.from_day, s.to_day, s.photos, s.last_photo, s.first_photo], ['2019-07-12', '2019-07-13', [2, 1], 'b', 'c']);
});

test('a photo taken from a plane is no stop: Brussels seen from above is no journey from Paris', () => {
  const above = (time, at) => time === t('2019-07-13T11:00:00Z') && at[0] === 50.85;
  assert.ok(!make([], above).list().some(s => s.from === 'Paris'));
});

test('an evening photo is on its own day where it was taken: a night bus that evening explains the next morning', () => {
  // San Francisco at 21:00 on 10 Aug (05:00 UTC on the 11th), Los Angeles the next morning; the bus left on the 10th
  const ph = [['s', t('2017-08-11T04:00:00Z'), 37.77, -122.42], ['s2', t('2017-08-11T05:00:00Z'), 37.78, -122.41], ['l', t('2017-08-11T16:00:00Z'), 34.05, -118.24]];
  const bus = [{ mode: 'bus', date: '2017-08-10 23:35:00', from_lat: 37.77, from_lon: -122.42, to_lat: 34.05, to_lon: -118.24 }];
  const m = suggestions.create({ towns: () => grid, cities, photos: () => ph, flights: () => [], airports: () => ({ EIN: { lat: 51.45, lon: 5.39 } }),
    groundTrips: () => bus, activities: () => [], stays: () => [], homeAirports: () => ['EIN'], dismissedFile: path.join(dir, 'dismissed2.json') });
  assert.deepStrictEqual(m.list().map(s => `${s.from}>${s.to}`), []);
});

test('a train between them, or saying it was no trip, takes it away', () => {
  assert.ok(!make([{ mode: 'train', date: '2019-07-13 09:00:00', from_lat: 48.88, from_lon: 2.36, to_lat: 50.84, to_lon: 4.36 }]).list().some(s => s.from === 'Paris'));
  // a train from further away, by both towns (Rennes to Liège, by Paris and Brussels): its line explains it
  assert.ok(!make([{ mode: 'train', date: '2019-07-13 07:00:00', from_lat: 48.11, from_lon: -1.68, to_lat: 50.63, to_lon: 5.57,
    path: require('../ground').encode([[48.11, -1.68], [48.84, 2.37], [50.84, 4.34], [50.63, 5.57]]) }]).list().some(s => s.from === 'Paris'));
  const m = make();
  m.dismiss(m.list().find(s => s.from === 'Paris').key);
  assert.ok(!m.list().some(s => s.from === 'Paris'));
});

test('albums: read from a Photos library\'s albums (photos.py --albums), the photos with no place of their own', async () => {
  const albums = require('../albums');
  const file = path.join(dir, 'photo_albums.json');
  fs.writeFileSync(file, JSON.stringify([
    { album: 'Facebook: Paris 2009', photos: [['fb_1.jpg', '/lib/originals/1/A.jpeg', t('2009-05-01T10:00:00Z'), false],
      ['fb_2.jpg', '/lib/originals/2/B.jpeg', t('2009-05-02T10:00:00Z'), false], ['IMG_3.jpg', '/lib/originals/3/C.jpeg', 0, true]] },
    { album: 'Photos from 2009', photos: [['IMG_4.jpg', '/lib/originals/4/D.jpeg', 0, false]] },
    { album: 'Holiday', photos: [['IMG_5.jpg', '/lib/originals/5/E.jpeg', 0, true]] }]));
  const a = albums.create({ dir: () => file, cacheFile: path.join(dir, 'albums.json'), placesFile: path.join(dir, 'album_places.json'),
    km: () => 0, towns: () => grid, flights: () => [], airports: () => ({}), groundTrips: () => [], stays: () => [], dismissed: () => new Set(), log: () => {} });
  a.albums();
  for (let i = 0; i < 50 && !a.ready(); i++) await new Promise(r => setTimeout(r, 20));
  const list = a.albums();
  assert.deepStrictEqual(list.map(x => [x.album, x.photos, x.loose, x.year]), [['Facebook: Paris 2009', 3, 2, 2009]]);
  assert.deepStrictEqual(albums.parse('Facebook: Paris 2009'), { place: 'Paris', year: 2009 });
  assert.strictEqual(a.albumFile('Facebook: Paris 2009', 'fb_2.jpg'), '/lib/originals/2/B.jpeg');
  assert.strictEqual(a.albumFile('Facebook: Paris 2009', 'IMG_3.jpg'), null);  // has a place of its own
});

test('albums: the place and year a name gives, and the places to look up, best first', () => {
  const { parse, candidates } = require('../albums');
  assert.deepStrictEqual(parse('Copy of Crimea 2011'), { place: 'Crimea', year: 2011 });
  assert.deepStrictEqual(parse('Saint Petersburg - 2009'), { place: 'Saint Petersburg', year: 2009 });
  assert.deepStrictEqual(parse('Chernihiv (Chernigov), Ukraine').place, 'Chernihiv Ukraine');
  assert.strictEqual(candidates(parse('GA of EMA in Krakow').place)[0], 'Krakow');
  assert.ok(candidates(parse('Copy of UK OUG 2011 Conference and Birmingham').place).includes('Birmingham'));
  assert.strictEqual(candidates(parse('Ring of Kerry').place)[0], 'Ring of Kerry');
  for (const everyday of ['Autumn 2010', 'Christmas holidays 2012', 'March 2011', 'Gigs']) assert.deepStrictEqual(candidates(parse(everyday).place), [], everyday);
});
