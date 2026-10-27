'use strict';
// The weather on a ride (weather.js): Open-Meteo's hours over the ride, summed up

const { test } = require('node:test');
const assert = require('node:assert');
const { summarise, sky } = require('../weather');

const hourly = {
  time: ['2026-07-14T08:00', '2026-07-14T09:00', '2026-07-14T10:00', '2026-07-14T11:00', '2026-07-14T12:00'],
  temperature_2m: [12, 14, 17, 19, 25], precipitation: [0, 0.4, 0.6, 0, 3], wind_speed_10m: [10, 10, 20, 10, 50],
  wind_direction_10m: [90, 90, 90, 90, 270], wind_gusts_10m: [20, 25, 40, 22, 90], weather_code: [1, 61, 61, 3, 95]
};

test('a ride from 9:30 to 11:20 counts the hours 9, 10 and 11', () => {
  const w = summarise(hourly, Date.parse('2026-07-14T09:30:00Z') / 1000, Date.parse('2026-07-14T11:20:00Z') / 1000);
  assert.deepStrictEqual(w, { temp: 16.7, tmin: 14, tmax: 19, rain: 1, wind: 13.3, gust: 40, dir: 90, code: 61 });
});

test('no hours of the ride: nothing', () => {
  assert.strictEqual(summarise(hourly, Date.parse('2026-07-15T09:00:00Z') / 1000, Date.parse('2026-07-15T10:00:00Z') / 1000), null);
});

test('weather codes as words', () => {
  assert.deepStrictEqual([sky(0)[1], sky(2)[1], sky(63)[1], sky(95)[1]], ['clear', 'partly cloudy', 'rain', 'thunderstorm']);
});
