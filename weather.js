'use strict';
// The weather on your rides, from Open-Meteo's history (ERA5, free, no key, open-meteo.com): at the ride's start, for
// the hours it lasted, the temperature (average, lowest, highest), rain, wind (average, its direction, the strongest
// gust) and what the sky did (WMO weather code, at the middle of the ride). Looked up in the background, one ride a
// second, and kept in data/weather.json; a ride of the last 6 days waits, as the history is a few days behind.

const fs = require('fs');

const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const RIDE = /Ride|Velomobile|Handcycle/;
const LAG_DAYS = 6;
const HOURLY = 'temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code';

// WMO weather codes as an icon and a word
function sky(code) {
  if (code == null) return ['', ''];
  if (code === 0) return ['☀️', 'clear'];
  if (code <= 2) return ['🌤️', 'partly cloudy'];
  if (code === 3) return ['☁️', 'overcast'];
  if (code <= 48) return ['🌫️', 'fog'];
  if (code <= 57) return ['🌦️', 'drizzle'];
  if (code <= 67) return ['🌧️', 'rain'];
  if (code <= 77) return ['🌨️', 'snow'];
  if (code <= 82) return ['🌧️', 'showers'];
  if (code <= 86) return ['🌨️', 'snow showers'];
  return ['⛈️', 'thunderstorm'];
}

// Open-Meteo's hourly answer -> the ride's weather, over the hours from `from` to `to` (unix seconds, UTC)
function summarise(hourly, from, to) {
  const t = (hourly.time || []).map(s => Date.parse(s + 'Z') / 1000);
  const idx = t.map((x, i) => i).filter(i => t[i] + 3600 > from && t[i] <= to);
  if (!idx.length) return null;
  const col = k => idx.map(i => hourly[k]?.[i]).filter(v => v != null);
  const temp = col('temperature_2m'), wind = col('wind_speed_10m'), gust = col('wind_gusts_10m'), rain = col('precipitation');
  if (!temp.length) return null;
  const avg = a => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null);
  // the wind's direction: the mean of the hours' directions as arrows, each as long as its wind
  let x = 0, y = 0;
  idx.forEach(i => {
    const s = hourly.wind_speed_10m?.[i], d = hourly.wind_direction_10m?.[i];
    if (s != null && d != null) { x += s * Math.sin(d * Math.PI / 180); y += s * Math.cos(d * Math.PI / 180); }
  });
  const mid = idx[Math.floor(idx.length / 2)];
  return { temp: avg(temp), tmin: Math.min(...temp), tmax: Math.max(...temp), rain: Math.round(rain.reduce((a, b) => a + b, 0) * 10) / 10,
    wind: avg(wind), gust: gust.length ? Math.max(...gust) : null, dir: x || y ? Math.round((Math.atan2(x, y) * 180 / Math.PI + 360) % 360) : null,
    code: hourly.weather_code?.[mid] ?? null };
}

function create({ activities, file, log = console.log }) {
  let store = null, running = false;
  const load = () => {
    if (!store) { try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { store = {}; } }
    return store;
  };
  const rides = () => activities().filter(a => RIDE.test(a.sport || '') && !a.trainer && a.at && a.start);

  // the rides not looked up yet, newest first, one a second
  function fill() {
    if (running) return;
    const known = load(), ready = Date.now() / 1000 - LAG_DAYS * 864e2;
    const todo = rides().filter(a => !(a.id in known) && a.start < ready).sort((a, b) => b.start - a.start);
    if (!todo.length) return;
    running = true;
    (async () => {
      let done = 0;
      for (const a of todo) {
        const end = a.start + (a.elapsed_time || a.moving_time || 3600);
        const day = s => new Date(s * 1000).toISOString().slice(0, 10);
        const p = new URLSearchParams({ latitude: a.at[0].toFixed(3), longitude: a.at[1].toFixed(3), start_date: day(a.start), end_date: day(end),
          hourly: HOURLY, timezone: 'GMT', wind_speed_unit: 'kmh' });
        try {
          await new Promise(r => setTimeout(r, 1000));
          const res = await fetch(`${ARCHIVE}?${p}`, { headers: { 'User-Agent': 'cairn (personal travel log; https://github.com/bazilinskyy/cairn)' },
            signal: AbortSignal.timeout(30000) });
          if (res.status === 429 || res.status >= 500) throw new Error(`Open-Meteo: HTTP ${res.status}`);
          const d = await res.json();
          known[a.id] = d.hourly ? summarise(d.hourly, a.start, end) : null;
          if (++done % 25 === 0) fs.writeFileSync(file, JSON.stringify(known));
        } catch (e) {
          log(`[weather] paused: ${e.message}`);
          break;
        }
      }
      fs.writeFileSync(file, JSON.stringify(known));
      if (done) log(`[weather] ${done} rides looked up`);
      running = false;
    })();
  }

  return { all: () => load(), fill };
}

module.exports = { create, summarise, sky };
