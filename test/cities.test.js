'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cities = require('../cities');

test('a local time is read in the zone of the town nearby, summer time included; by the longitude far from any town', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-')), 'cities1000.txt');
  const town = (id, name, lat, lon, cc, tz) => [id, name, name, '', lat, lon, 'P', 'PPLA', cc, '', '', '', '', '', 100000, '', '', tz, '2024-01-01'].join('\t');
  fs.writeFileSync(file, [town(1, 'Riverton', 50.9, 7.0, 'DE', 'Europe/Berlin'), town(2, 'Westport', 40.4, -3.7, 'ES', 'Europe/Madrid')].join('\n'));
  const grid = cities.load(file), iso = s => new Date(s * 1000).toISOString().slice(0, 16);
  assert.strictEqual(iso(cities.localUnix(grid, '2023-08-29 18:05', 50.94, 6.96)), '2023-08-29T16:05');
  assert.strictEqual(iso(cities.localUnix(grid, '2023-01-15 12:00', 50.94, 6.96)), '2023-01-15T11:00');
  assert.strictEqual(iso(cities.localUnix(grid, '2023-08-29 18:05', 40.4, -3.7)), '2023-08-29T16:05');  // not the hour its longitude gives
  assert.strictEqual(iso(cities.localUnix(grid, '2023-08-29 18:00', 0, -150)), '2023-08-30T04:00');
});
