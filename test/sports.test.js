'use strict';
// The Sports tab's numbers (public/sports.js), without a browser: Eddington, streaks, explored tiles.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TILES = 16384;
const sports = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sports.js'), 'utf8') +
  ';({ eddington, streaks, exploredOf })', { TILES });
const on = (date, km) => ({ date: date + ' 09:00:00', distance: km });

test('Eddington: E days of at least E km, and how many more days the next one needs', () => {
  // per day: 12, 11, 10 (two rides), 9, 4 km: four days of 4+ km, not five of 5+
  const e = sports.eddington([on('2024-06-01', 12), on('2024-06-02', 11), on('2024-06-03', 6), on('2024-06-03', 4),
    on('2024-06-04', 9), on('2024-06-05', 4)]);
  assert.strictEqual(e.e, 4);
  assert.deepStrictEqual([e.next, e.missing], [5, 1]);
  assert.strictEqual(sports.eddington([]).e, 0);
});

test('streaks: the longest run of days, not counting two on one day twice', () => {
  const s = sports.streaks([on('2024-06-01', 1), on('2024-06-02', 1), on('2024-06-02', 5), on('2024-06-03', 1),
    on('2024-06-10', 1), on('2024-06-11', 1)]);
  assert.deepStrictEqual([s.best.n, s.best.end, s.days, s.current], [3, '2024-06-03', 5, 0]);
});

test('explored tiles: the max square and the biggest cluster of tiles with four explored neighbours', () => {
  const t = (x, y) => x * TILES + y, block = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 3; y++) block.push(t(100 + x, 200 + y));  // 4 wide, 3 high
  const ex = sports.exploredOf([{ tiles: block }, { tiles: [t(300, 300)] }]);
  assert.deepStrictEqual([ex.tiles, ex.square, ex.cluster], [13, 3, 2]);  // inner tiles: (101,201) and (102,201)
});
