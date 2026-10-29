'use strict';
// Curiosities (stats.js): the distance to the coast, commutes; music (lastfm.js): the top artists and tracks of some days

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { coastIndex, coastKm, stayKind, groundKind, commuteSince } = require('../stats');
const lastfm = require('../lastfm');

test('the distance to a coast, in km', () => {
  const coast = coastIndex({ features: [{ geometry: { type: 'LineString', coordinates: [[4.0, 52.0], [4.0, 53.0]] } }] });  // a north-south coast at 4°E
  assert.ok(Math.abs(coastKm(coast, 52.5, 4.01) - 0.68) < 0.02);
  assert.ok(coastKm(coast, 52.5, 6.0) > 2);  // 135 km inland, its cell's neighbours hold no coast: far
});

test('a train between the towns you live and work in is a commute, either way, from the first month of four; others stay trains', () => {
  const places = { residence: { lat: 52.38, lon: 4.64 }, work: { lat: 52.09, lon: 5.12 } };  // Haarlem, Utrecht
  const train = (a, b, date = '2024-03-04') => ({ mode: 'train', date, from_lat: a[0], from_lon: a[1], to_lat: b[0], to_lon: b[1] });
  const haarlem = [52.387, 4.638], utrecht = [52.089, 5.110], leiden = [52.166, 4.482];
  const trips = [train(haarlem, utrecht, '2023-05-02'), ...['04', '05', '11', '12'].map(d => train(haarlem, utrecht, `2024-03-${d}`))];
  const since = commuteSince(trips, places);
  assert.strictEqual(since, '2024-03');  // one in May 2023, then four in March 2024
  assert.strictEqual(groundKind(train(haarlem, utrecht), places, since), 'commute');
  assert.strictEqual(groundKind(train(utrecht, haarlem, '2025-01-07'), places, since), 'commute');
  assert.strictEqual(groundKind(trips[0], places, since), 'train');  // before the job
  assert.strictEqual(groundKind(train(haarlem, leiden), places, since), 'train');
  assert.strictEqual(groundKind({ ...train(haarlem, utrecht), mode: 'bus' }, places, since), 'bus');
  assert.strictEqual(commuteSince(trips, {}), null);  // no places set
});

test("a night at a friend's place is its own kind, apart from family; a friendly hostel stays a hostel", () => {
  assert.strictEqual(stayKind({ type: 'with a friend', provider: 'trip doc' }), "Friend's place");
  assert.strictEqual(stayKind({ type: 'friends', provider: '' }), "Friend's place");
  assert.strictEqual(stayKind({ type: 'family', provider: '' }), 'Family');
  assert.strictEqual(stayKind({ type: 'Hostel', hotel: 'Friends guest house', provider: 'Booking.com' }), 'Hostel');
  assert.strictEqual(stayKind({ type: '', provider: 'Trustroots' }), 'Trustroots');  // a host, as on Couchsurfing and BeWelcome
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
