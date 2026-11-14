'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wallet = require('../wallet');
const { bcbp, parse, readJson, yours } = require('../wallet');

test('a boarding pass\'s barcode: route, flight, day of the year, seat and booking code', () => {
  const b = bcbp(`M1${'DOE/JANE MRS'.padEnd(20)}EX1Y2Z3 AMSBCNVY 8301 060Y012A0012 100`);
  assert.deepStrictEqual(b, { name: 'DOE/JANE MRS', booking: 'X1Y2Z3', from: 'AMS', to: 'BCN', flight_number: 'VY8301', julian: 60, cabin: 'Y', seat: '12A' });
  assert.strictEqual(bcbp(`M1${'DOE/JANE'.padEnd(20)}EX1Y2Z3 AMSBCNVY 8301 060Y0000 0012 100`).seat, '');  // no seat yet
  assert.strictEqual(bcbp('not a barcode'), null);
});

test('a train ticket\'s towns: the value, or the label when the value is a time or a code', () => {
  const p = parse({ organizationName: 'Renfe', relevantDate: '2024-09-17T08:55+02:00', boardingPass: { transitType: 'PKTransitTypeTrain',
    primaryFields: [{ key: 'boardingTime', label: 'ZARAGOZA', value: '08:55' }, { key: 'destino', label: 'JACA', value: '11:04' }] } }, { id: 'x' });
  assert.deepStrictEqual([p.kind, p.date, p.from, p.to], ['train', '2024-09-17 08:55', 'Zaragoza', 'Jaca']);
  const bus = parse({ organizationName: 'Gothenburg - Malmö', boardingPass: { transitType: 'PKTransitTypeBus',
    headerFields: [{ key: 'date', value: '2017-05-25T09:35+02:00' }] } }, { id: 'y' });
  assert.deepStrictEqual([bus.kind, bus.date, bus.from, bus.to], ['bus', '2017-05-25 09:35', 'Gothenburg', 'Malmö']);
  assert.strictEqual(parse({ voided: true, boardingPass: { transitType: 'PKTransitTypeBus' } }), null);
});

test('pass.json as it comes: UTF-16, Latin-1, a comma before a bracket', () => {
  assert.deepStrictEqual(readJson(Buffer.from('{"a":1}', 'utf16le')), { a: 1 });
  assert.deepStrictEqual(readJson(Buffer.from('{"a":"café"}', 'latin1')), { a: 'café' });
  assert.deepStrictEqual(readJson(Buffer.from('{"a":[1,2,],}')), { a: [1, 2] });
});

test('your passes and those of the people you travel with', () => {
  const mine = n => yours({ passenger: n }, ['Jane Doe']);
  assert.deepStrictEqual(['DOE/JANEMRS', 'J.DOE', 'Doe/Jane A', 'DOE/JOHN', 'Johnny Doe', 'passenger_list', ''].map(mine),
    [true, true, true, false, false, true, true]);
});

test('when a pass last came: the newest of the Wallet folder and the passes given; none, nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-wallet-')), cards = path.join(dir, 'Cards'), given = path.join(dir, 'given');
  fs.mkdirSync(path.join(cards, 'a.pkpass'), { recursive: true });
  fs.mkdirSync(given);
  const w = wallet.create({ dir: () => cards, uploads: given, log: () => {} });
  fs.utimesSync(path.join(cards, 'a.pkpass'), new Date('2025-01-02T03:04:05Z'), new Date('2025-01-02T03:04:05Z'));
  assert.strictEqual(w.changed(), '2025-01-02T03:04:05.000Z');
  fs.writeFileSync(path.join(given, 'b.pkpass'), 'x');
  fs.utimesSync(path.join(given, 'b.pkpass'), new Date('2026-06-07T08:09:10Z'), new Date('2026-06-07T08:09:10Z'));
  assert.strictEqual(w.changed(), '2026-06-07T08:09:10.000Z');
  assert.strictEqual(wallet.create({ dir: () => '', uploads: path.join(dir, 'none'), log: () => {} }).changed(), '');
});
