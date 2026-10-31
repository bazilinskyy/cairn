'use strict';
// Stays your runs show (bases.js): nights away with no stay, where your loops start

const { test } = require('node:test');
const assert = require('node:assert');
const ground = require('../ground');
const bases = require('../bases');

// a loop of about 2 km starting and ending at a spot
const loop = (at, date, name = 'Run', sport = 'Run') => ({ date, name, sport, path: ground.encode([at, [at[0] + 0.005, at[1]], [at[0] + 0.005, at[1] + 0.005], at]) });
const make = (acts, stays = [], homes = [[52.0, 4.36]]) => bases.create({ activities: () => acts, stays: () => stays, homes: () => homes, km: ground.km, decode: ground.decode });

test('loops from one spot on nights with no stay make one stay; a morning loop counts for the night before', () => {
  const hotel = [41.15, -8.61];  // Porto
  const list = make([loop(hotel, '2020-05-13 07:50:00'), loop(hotel, '2020-05-14 07:30:00'), loop(hotel, '2020-05-14 18:10:00')]).list();
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual([list[0].start, list[0].end, list[0].nights, list[0].loops], ['2020-05-12', '2020-05-15', 3, 3]);
});

test('not suggested: nights a stay covers, loops near home, where you lived, a lone loop near home, one-way runs', () => {
  const far = [41.15, -8.61], near = [52.3, 4.9];  // Porto; Amsterdam, 40 km from home
  const lived = [55.95, -3.19], many = Array.from({ length: 60 }, (_, i) => loop(lived, `2013-0${1 + (i % 5)}-${String(1 + (i % 27)).padStart(2, '0')} 08:00:00`));
  const oneWay = { date: '2021-06-12 09:00:00', path: ground.encode([far, [far[0] + 0.05, far[1]]]) };
  const list = make([loop(far, '2021-06-08 12:00:00'), loop([52.01, 4.37], '2021-06-08 18:00:00'), loop(near, '2021-06-20 18:00:00'), ...many, oneWay],
    [{ what: 'stay', start: '2021-06-07', end: '2021-06-15' }]).list();
  assert.deepStrictEqual(list, []);
});

test('a stay elsewhere in between splits the nights; a lone loop far from home is a night of its own', () => {
  const spot = [35.01, 135.77];  // Kyoto
  const list = make([loop(spot, '2018-04-16 18:00:00'), loop(spot, '2018-04-19 18:00:00'), loop([34.69, 135.50], '2018-05-02 18:00:00')],
    [{ what: 'stay', start: '2018-04-17', end: '2018-04-18' }]).list();
  assert.deepStrictEqual(list.map(x => [x.start, x.end]), [['2018-05-02', '2018-05-03'], ['2018-04-19', '2018-04-20'], ['2018-04-16', '2018-04-17']]);
});

test('two spots for the same night: where the run starts, not the hike at a trailhead', () => {
  const hotel = [37.18, -3.60], trailhead = [37.13, -3.40];  // Granada, a trailhead in the hills
  const list = make([loop(trailhead, '2022-03-10 15:00:00', 'Hiking', 'Hike'), loop(hotel, '2022-03-10 17:30:00', 'Running')]).list();
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual([list[0].lat, list[0].names], [37.18, ['Running']]);
});
