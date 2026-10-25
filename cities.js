'use strict';
// Your most visited cities: every place you were on a day (an airport you landed at or left from, a station, a stay,
// photos, a Timeline visit, the start of a Strava activity) is put in the town it belongs to, from GeoNames' towns
// over 1,000 people (data/cities1000.txt, which flightmail downloads), and the days are counted per town.

const fs = require('fs');

const SKIP = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH']);  // parts of a town, historical, abandoned, destroyed
const REACH_KM = 25;
const norm = s => (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

function km(a, b) {
  const r = x => x * Math.PI / 180, dLat = r(b[0] - a[0]), dLon = r(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// The towns in a grid of 1-degree cells; null when the file is not there
function load(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const grid = new Map();
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length < 15 || SKIP.has(f[7])) continue;
    const town = { id: +f[0], name: f[1], cc: f[8], lat: +f[4], lon: +f[5], pop: +f[14] || 1000 };
    // its names to match an airport's city by: other spellings only for towns over 50,000 ("Kiev" is Kyiv)
    town.names = new Set([f[1], f[2], ...(town.pop >= 50000 ? f[3].split(',') : [])].map(norm).filter(Boolean));
    const key = Math.floor(town.lat) + ',' + Math.floor(town.lon);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(town);
  }
  return grid;
}

// The town a place belongs to: the one that pulls hardest, population over distance squared, within 25 km
// (Veldhoven's station is Veldhoven, not Eindhoven next door; a hamlet next to a city goes to the city)
function townAt(grid, lat, lon) {
  let best = null, pull = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const t of grid.get((Math.floor(lat) + dy) + ',' + (Math.floor(lon) + dx)) || []) {
      const d = km([lat, lon], [t.lat, t.lon]);
      if (d > REACH_KM) continue;
      const p = t.pop / (d + 2) ** 2;
      if (p > pull) { pull = p; best = t; }
    }
  }
  return best;
}

// The town of that name nearest a place, within 80 km: an airport is in its city, not in the suburb it stands in
// (Boryspil airport is Kyiv's, Vantaa is Helsinki's)
function townNamed(grid, name, lat, lon) {
  const n = norm(name);
  let best = null, dist = 80;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const t of grid.get((Math.floor(lat) + dy) + ',' + (Math.floor(lon) + dx)) || []) {
      const d = km([lat, lon], [t.lat, t.lon]);
      if (d < dist && t.names.has(n)) { dist = d; best = t; }
    }
  }
  return best;
}

// points: [{ at: [lat, lon], day: 'YYYY-MM-DD', city? }] (city: an airport's city) -> the towns by days there, with
// the number of separate visits (a gap of more than a day starts a new one), the first and the last day
function rank(grid, points, limit = 100) {
  const cache = new Map(), days = new Map();
  for (const { at, day, city } of points) {
    if (!at || !day) continue;
    const key = at[0].toFixed(2) + ',' + at[1].toFixed(2) + (city ? '|' + city : '');
    if (!cache.has(key)) cache.set(key, (city && townNamed(grid, city, at[0], at[1])) || townAt(grid, at[0], at[1]));
    const t = cache.get(key);
    if (!t) continue;
    if (!days.has(t)) days.set(t, new Set());
    days.get(t).add(day);
  }
  return [...days].map(([t, set]) => {
    const list = [...set].sort();
    let visits = 0, last = null;
    for (const d of list) {
      if (!last || (Date.parse(d) - Date.parse(last)) / 864e5 > 1) visits++;
      last = d;
    }
    return { name: t.name, country: t.cc, lat: t.lat, lon: t.lon, days: list.length, visits, first: list[0], last: list[list.length - 1] };
  }).sort((a, b) => b.days - a.days || b.visits - a.visits || a.name.localeCompare(b.name)).slice(0, limit);
}

module.exports = { load, townAt, townNamed, rank };
