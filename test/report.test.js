'use strict';
// The report (report.js): made-up trips, flights and stays, made into its page; the sketches; the PDF's browser.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const report = require('../report');

const trip = (id, start, end, countries, towns, more = {}) => ({ id, start, end, name: countries.join(' · '), days: 3, nights: 2,
  countries: countries.map(cc => ({ cc, days: 3 })), work: [], towns, ...more });
const lisbon = { id: 1, name: 'Lisbon', country: 'PT', lat: 38.72, lon: -9.14, days: 3 };
const book = (over = {}) => report.create({
  trips: () => [trip('2024-05-01', '2024-05-01', '2024-05-03', ['PT'], [lisbon]), trip('2025-02-01', '2025-02-01', '2025-02-03', ['ES'], []),
    trip('2099-01-01', '2099-01-01', '2099-01-05', ['JP'], [])],
  flights: () => [{ id: 1, date: '2024-05-01 08:00:00', from: 'AMS', to: 'LIS', flight_number: 'XX123', airline: 'Made-up Air', distance: 1850 }],
  airports: () => ({ AMS: { city: 'Amsterdam', lat: 52.31, lon: 4.76 }, LIS: { city: 'Lisbon', lat: 38.77, lon: -9.13 } }),
  groundTrips: () => [{ id: 1, date: '2024-05-02 10:00:00', mode: 'train', from: 'Lisbon', to: 'Sintra', distance: 25, from_lat: 38.71, from_lon: -9.14, to_lat: 38.8, to_lon: -9.38 }],
  stays: () => [{ id: 1, what: 'stay', start: '2024-05-01', end: '2024-05-03', place: 'Lisbon', hotel: '<b>Hostel</b> & co', type: 'hostel', lat: 38.71, lon: -9.14 }],
  activities: () => [{ id: 1, date: '2024-05-02 07:00:00', name: 'Morning run', sport: 'Run', distance: 10.2, elevation: 120 },
    { id: 2, date: '2024-05-02 18:00:00', name: 'On the trainer', sport: 'VirtualRide', distance: 40 }],
  photos: () => [['abc123', Date.parse('2024-05-02T12:00:00Z') / 1000, 38.7, -9.1, 0]],
  curiosities: () => null, years: () => [{ year: 2024, days: 3, away: 3, trips: 1, countries: 1, newCountries: 1, towns: 1, newTowns: 1, distance: {}, photos: 1 }],
  countries: () => [{ cc: 'PT', country: 'PT', days: 3, visits: 1, towns: 1, first: '2024-05-01', last: '2024-05-03' }],
  today: () => '2026-01-01', ...over
});

test('every trip with its travel, beds, outings and photos; the ones ahead listed apart; text kept as text', () => {
  const html = book().html();
  assert.match(html, /<title>Cairn · your travels 2024–2025<\/title>/);
  assert.match(html, /id="trip-2024-05-01"/);
  assert.match(html, /Amsterdam <small>AMS<\/small> → Lisbon <small>LIS<\/small>/);
  assert.match(html, /XX123 · Made-up Air/);
  assert.match(html, /Lisbon → Sintra/);
  assert.match(html, /&lt;b&gt;Hostel&lt;\/b&gt; &amp; co/, 'a hotel\'s name is text, not markup');
  assert.match(html, /Morning run/);
  assert.doesNotMatch(html, /On the trainer/, 'a ride on a trainer is no outing of the trip');
  assert.match(html, /\/api\/photos\/abc123\/small/);
  assert.match(html, /<h2>Coming up<\/h2>/);
  assert.doesNotMatch(html, /id="trip-2099-01-01"/, 'a trip ahead has no page of its own');
  assert.match(html, /The records are still being worked out/);
});

test('the years asked for only, and without photos when so asked', () => {
  const html = book().html({ from: 2025, to: 2025, photos: false });
  assert.doesNotMatch(html, /id="trip-2024-05-01"/);
  assert.match(html, /id="trip-2025-02-01"/);
  assert.doesNotMatch(html, /\/api\/photos\//);
});

test('a place with no town of its own is near the nearest one', () => {
  const c = { extremes: { south: { day: '2023-04-05', lat: -46.66, lon: 169.1, town: '', country: '' } } };
  const html = book({ curiosities: () => c, nearTown: () => ({ name: 'Southtown', cc: 'NZ' }) }).html();
  assert.match(html, /Farthest south<\/span><b>🇳🇿 near Southtown/);
});

test('a sketch: nothing without places; across the date line the short way; the coast in it', () => {
  assert.strictEqual(report.sketch({}), '');
  const across = report.sketch({ legs: [{ from: [-17.8, 177.4], to: [-13.8, -171.8], mode: 'flight' }] });
  const [x1, x2] = across.match(/x1="([\d.-]+)" y1="[\d.-]+" x2="([\d.-]+)"/).slice(1).map(Number);
  assert.ok(x1 >= 0 && x1 <= 600 && x2 >= 0 && x2 <= 600 && x2 > x1, 'Fiji to Samoa eastwards in the picture, not round the world');
  const coast = [{ line: [[-9.5, 38.6], [-9.4, 38.7], [-9.3, 38.8]], box: [-9.5, 38.6, -9.3, 38.8] }];
  assert.match(report.sketch({ towns: [lisbon] }, coast), /<path class="coast" d="M/);
});

test('the PDF: a browser where it usually is, else none; printed to a file of its own', async () => {
  assert.strictEqual(report.findBrowser(null, f => f === '/usr/bin/chromium'), '/usr/bin/chromium');
  const saved = process.env.CHROME;
  delete process.env.CHROME;
  try { assert.strictEqual(report.findBrowser(null, () => false), null); } finally { if (saved !== undefined) process.env.CHROME = saved; }
  await assert.rejects(report.pdf('http://127.0.0.1/report', { browser: null }), e => e.status === 501);
  let args;
  const run = (cmd, a, opts, done) => { args = a; fs.writeFileSync(a.find(x => x.startsWith('--print-to-pdf=')).slice(15), '%PDF-1.4'); done(null); };
  const { file, dir } = await report.pdf('http://127.0.0.1:3000/report?from=2024', { browser: '/x/chrome', run });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '%PDF-1.4');
  assert.ok(args.includes('--no-pdf-header-footer') && args.some(a => a.startsWith('--user-data-dir=')) && args[args.length - 1].endsWith('?from=2024'));
  fs.rmSync(dir, { recursive: true, force: true });
});
