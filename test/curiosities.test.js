'use strict';
// Curiosities (stats.js): the distance to the coast; music (lastfm.js): the top artists and tracks of some days

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { coastIndex, coastKm } = require('../stats');
const lastfm = require('../lastfm');

test('the distance to a coast, in km', () => {
  const coast = coastIndex({ features: [{ geometry: { type: 'LineString', coordinates: [[4.0, 52.0], [4.0, 53.0]] } }] });  // a north-south coast at 4°E
  assert.ok(Math.abs(coastKm(coast, 52.5, 4.01) - 0.68) < 0.02);
  assert.ok(coastKm(coast, 52.5, 6.0) > 2);  // 135 km inland, its cell's neighbours hold no coast: far
});

test('music: the top of the days asked, per day its most played track', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-music-'));
  const t = (day, h) => Date.parse(`${day}T${h}:00:00Z`) / 1000;
  fs.writeFileSync(path.join(dir, 'lastfm.json'), JSON.stringify({ user: 'me', scrobbles: [
    [t('2026-07-14', '08'), 'Air', 'La femme d\'argent', ''], [t('2026-07-14', '09'), 'Air', 'La femme d\'argent', ''],
    [t('2026-07-14', '10'), 'Daft Punk', 'Veridis Quo', ''], [t('2026-07-15', '10'), 'Daft Punk', 'Veridis Quo', ''],
    [t('2026-07-20', '10'), 'Justice', 'D.A.N.C.E.', '']] }));
  const m = lastfm.create({ file: path.join(dir, 'lastfm.json'), keys: () => ({}), log: () => {} });
  const trip = m.top({ from: '2026-07-14', to: '2026-07-15' });
  assert.strictEqual(trip.plays, 4);
  assert.deepStrictEqual(trip.artists.map(a => [a.name, a.plays]), [['Air', 2], ['Daft Punk', 2]]);
  assert.deepStrictEqual(trip.days['2026-07-14'].top, { artist: 'Air', name: 'La femme d\'argent', plays: 2 });
  assert.strictEqual(m.top({ days: new Set(['2026-07-20']) }).tracks[0].name, 'D.A.N.C.E.');
});
