'use strict';
// Getting ready (prep.js): a check-in to-do counts for its flight by number or by date, connections share one, a night
// without a bed is missing, an open to-do about it means it is not reported; spending (spending.js) reads prices

const { test } = require('node:test');
const assert = require('node:assert');
const { parsePrice } = require('../spending');
const prep = require('../prep');

const km = (a, b) => Math.hypot(a[0] - b[0], (a[1] - b[1]) * Math.cos(a[0] * Math.PI / 180)) * 111.2;
const airports = { AMS: { lat: 52.3, lon: 4.76, city: 'Amsterdam' }, LIS: { lat: 38.77, lon: -9.13, city: 'Lisbon' }, HOR: { lat: 38.52, lon: -28.72, city: 'Horta' } };
function make({ flights, stays = [], todos }) {
  const d = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10), end = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  return { start: d, end, p: prep.create({ trips: () => [{ id: d, name: 'Portugal', start: d, end, days: 5, countries: [{ cc: 'PT', days: 5 }], towns: [] }],
    flights: () => flights(d, end), airports: () => airports, stays: () => stays, groundTrips: () => [], climbs: () => [],
    things: { todos: async () => todos(d) }, homeAirports: () => ['AMS'], km, sentFile: '/dev/null', dismissed: () => new Set(), discord: async () => {} }) };
}

test('check-ins: by number for one flight, the connection shares it; the way back without one is missing', async () => {
  const { p } = make({
    flights: (d, end) => [{ id: 1, date: `${d} 08:00:00`, from: 'AMS', to: 'LIS', flight_number: 'TP661' }, { id: 2, date: `${d} 13:00:00`, from: 'LIS', to: 'HOR', flight_number: 'S4151' },
      { id: 3, date: `${end} 10:00:00`, from: 'LIS', to: 'AMS', flight_number: 'TP662' }],
    stays: [], todos: () => [{ title: 'check in TP 661', notes: '', status: 'open', checklist: [] }] });
  const [t] = await p.coming({ withForecast: false });
  assert.deepStrictEqual(t.flights.map(f => !!f.checkin), [true, true, false]);
  assert.deepStrictEqual(t.missing.filter(m => m.kind === 'checkin').map(m => m.flight), ['TP662']);
});

test('nights without a bed are missing, unless an open to-do is about them', async () => {
  const flights = (d, end) => [{ id: 1, date: `${d} 08:00:00`, from: 'AMS', to: 'LIS', flight_number: 'TP661' }, { id: 3, date: `${end} 10:00:00`, from: 'LIS', to: 'AMS', flight_number: 'TP662' }];
  const checkins = () => [{ title: 'check in TP661', notes: '', status: 'done', checklist: [] }, { title: 'check in TP662', notes: '', status: 'open', checklist: [] }];
  const [bare] = await make({ flights, todos: checkins }).p.coming({ withForecast: false });
  const stay = bare.missing.find(m => m.kind === 'stay');
  assert.ok(stay && !stay.todo && stay.text.includes('4 nights') && stay.text.includes('Lisbon'), stay && stay.text);
  const [covered] = await make({ flights, todos: d => [...checkins(d), { title: 'trip to Portugal', notes: '', status: 'open', checklist: ['book hostel in Lisbon'] }] }).p.coming({ withForecast: false });
  assert.ok(covered.missing.find(m => m.kind === 'stay').todo);
});

test('prices in their many spellings', () => {
  assert.deepStrictEqual(parsePrice('43.50€'), { amount: 43.5, currency: 'EUR' });
  assert.deepStrictEqual(parsePrice('€ 1.234,50'), { amount: 1234.5, currency: 'EUR' });
  assert.deepStrictEqual(parsePrice('4105.50 DKK'), { amount: 4105.5, currency: 'DKK' });
  assert.deepStrictEqual(parsePrice('2 000 KZT'), { amount: 2000, currency: 'KZT' });
  assert.strictEqual(parsePrice(''), null);
});
