'use strict';
// Which way up a climb a ride took (ascents.js): the last stretch up to the top, going up, and the part only that
// way has. A made-up climb with two ways up that share their last 2 km, like Bédoin and Sault on the Ventoux.
const test = require('node:test');
const assert = require('node:assert');
const { ridden, resample } = require('../ascents');

const north = (lat, lon, km) => [lat + km / 111.32, lon];
const line = (from, to, n = 40) => Array.from({ length: n + 1 }, (_, i) => [from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n]);
const top = [45.1, 6.0], junction = north(45.1, 6.0, -2);
const west = [junction[0] - 0.05, junction[1] - 0.08], east = [junction[0] - 0.05, junction[1] + 0.08];
const shared = line(junction, top);
const ascents = [
  { samples: resample([...line(west, junction).slice(0, -1), ...shared]) },  // from the west
  { samples: resample([...line(east, junction).slice(0, -1), ...shared]) }   // from the east
];

test('up from the west and down to the east: the west way only', () => {
  const ride = [...line(west, junction).slice(0, -1), ...shared, ...shared.slice().reverse().slice(1), ...line(junction, east).slice(1)];
  assert.deepStrictEqual(ridden(ascents, ride), [true, false]);
});

test('up the east way: the east way only', () => {
  assert.deepStrictEqual(ridden(ascents, [...line(east, junction).slice(0, -1), ...shared]), [false, true]);
});

test('only down a way: none', () => {
  const down = [...shared.slice().reverse(), ...line(junction, west).slice(1)];
  assert.deepStrictEqual(ridden(ascents, down), [false, false]);
});

test('up neither way (from the junction only): none', () => {
  assert.deepStrictEqual(ridden(ascents, line(north(junction[0], junction[1], -0.1), top)), [false, false]);
});

// Your time up a way (efforts.js): from passing its foot to passing its top, with the power held meanwhile
const { efforts, predict, onDay } = require('../efforts');

test('a ride up: the time from the foot to the top, and the average power', () => {
  const foot = [45.0, 6.0], top = [45.02, 6.0];
  const pts = Array.from({ length: 41 }, (_, i) => [45.0 - 0.005 + i * 0.000625, 6.0]);  // from 550 m before the foot to past the top
  const t = pts.map((_, i) => i * 60), pw = pts.map(() => 250);
  const [e] = efforts({ pts, t, pw, hr: pts.map(() => 150), start: 1000 }, foot, top);
  assert.strictEqual(e.seconds, 32 * 60);  // 8 points in, 32 more to the top, a minute apart
  assert.deepStrictEqual([e.power, e.hr], [250, 150]);
});

test('the model: more power or less weight is faster; steeper is slower', () => {
  assert.ok(predict(10, 800, 300, 70) < predict(10, 800, 250, 70));
  assert.ok(predict(10, 800, 300, 60) < predict(10, 800, 300, 70));
  assert.ok(predict(10, 1000, 300, 70) > predict(10, 800, 300, 70));
});

test('the weight of a day: the last weigh-in before it, else the first after', () => {
  const w = [['2020-01-01', 70], ['2022-06-01', 75]];
  assert.deepStrictEqual([onDay(w, '2021-05-05'), onDay(w, '2019-01-01'), onDay(w, '2023-01-01'), onDay([], '2023-01-01')], [70, 70, 75, null]);
});
