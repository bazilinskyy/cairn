'use strict';
// Curiosities: what all your places and days add up to. Days by the sea (within 2 km of Natural Earth's coastline,
// data/coastline.geojson, downloaded on first use) and up in the mountains (heights from the open AWS Terrain Tiles,
// kept per place in data/heights.json), the farthest you went each way, hemispheres and the tropics, capitals, how far
// you went by each means, the beds you slept in, where each New Year's Eve was, the weather's extremes on your rides,
// and how you slept away and at home. Worked out in the background (the heights take a while the first time) and
// kept until the data changes.

const fs = require('fs');
const ground = require('./ground');
const { decodePNG } = require('./ascents');

const COAST_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson';
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const DEM_Z = 10;          // tiles of about 40 km, a height every 150 m
const SEA_KM = 2;          // a day by the sea: somewhere within this of the coast
const HEIGHTS = [1000, 2000, 3000];
const EARTH_KM = 40075, MOON_KM = 384400;
const cell = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;  // about 1 km

// --- the coast: segments in cells of half a degree, for the distance from a point ---
function coastIndex(geo) {
  const grid = new Map();
  const add = (a, b) => {
    const k = `${Math.floor(Math.min(a[1], b[1]) * 2)},${Math.floor(Math.min(a[0], b[0]) * 2)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([a[1], a[0], b[1], b[0]]);  // lat, lon, lat, lon
  };
  for (const f of geo.features || []) {
    const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const line of lines) for (let i = 1; i < line.length; i++) add(line[i - 1], line[i]);
  }
  return grid;
}
function coastKm(grid, lat, lon) {
  let best = Infinity;
  const k = Math.cos(lat * Math.PI / 180) * 111.32;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const [la1, lo1, la2, lo2] of grid.get(`${Math.floor(lat * 2) + dy},${Math.floor(lon * 2) + dx}`) || []) {
      const ax = (lo1 - lon) * k, ay = (la1 - lat) * 111.32, bx = (lo2 - lon) * k, by = (la2 - lat) * 111.32;
      const vx = bx - ax, vy = by - ay, len = vx * vx + vy * vy;
      const t = len ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len)) : 0;
      best = Math.min(best, Math.hypot(ax + t * vx, ay + t * vy));
    }
  }
  return best;
}

// --- heights: the places' cells, looked up by their terrain tile, four tiles at a time ---
async function lookUpHeights(cells, known, save, log) {
  const byTile = new Map(), n = 2 ** DEM_Z;
  for (const c of cells) {
    if (c in known) continue;
    const [lat, lon] = c.split(',').map(Number), r = lat * Math.PI / 180;
    const xf = (lon + 180) / 360 * n, yf = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
    const key = `${Math.floor(xf)}/${Math.floor(yf)}`;
    if (!byTile.has(key)) byTile.set(key, []);
    byTile.get(key).push([c, xf % 1, yf % 1]);
  }
  const tiles = [...byTile], started = Date.now();
  let done = 0;
  async function one([key, list]) {
    try {
      const res = await fetch(`${DEM}/${DEM_Z}/${key}.png`, { signal: AbortSignal.timeout(30000) });
      const t = res.ok ? decodePNG(Buffer.from(await res.arrayBuffer())) : null;
      for (const [c, fx, fy] of list) {
        if (!t) { known[c] = null; continue; }
        const x = Math.min(t.width - 1, Math.floor(fx * t.width)), y = Math.min(t.width - 1, Math.floor(fy * t.width)), i = (y * t.width + x) * t.channels;
        known[c] = Math.round(t.px[i] * 256 + t.px[i + 1] + t.px[i + 2] / 256 - 32768);
      }
    } catch (_) { /* tried again next time */ }
    if (++done % 200 === 0) { save(); log(`[stats] heights: ${done} of ${tiles.length} terrain tiles`); }
  }
  for (let i = 0; i < tiles.length; i += 4) await Promise.all(tiles.slice(i, i + 4).map(one));
  save();
  if (tiles.length) log(`[stats] heights of ${cells.length} places from ${tiles.length} terrain tiles in ${Math.round((Date.now() - started) / 1000)} s`);
}

// sources: getters; days() = [{ at, day, city }] from every source; towns() the town grid (cities.js)
function create({ days, towns, cities, activities, stays, flights, airports, groundTrips, trips, weather, wellness, homeAirports, places = () => ({}), commutes = () => true, drives = () => [],
  heightsFile, coastFile, download, log = console.log }) {
  let memo = { key: null, value: null }, working = null, coast = null, heights = null;
  const loadHeights = () => {
    if (!heights) { try { heights = JSON.parse(fs.readFileSync(heightsFile, 'utf8')); } catch (_) { heights = {}; } }
    return heights;
  };
  const saveHeights = () => fs.writeFileSync(heightsFile, JSON.stringify(heights));
  async function loadCoast() {
    if (coast) return coast;
    if (!fs.existsSync(coastFile)) fs.writeFileSync(coastFile, await download(COAST_URL));
    return (coast = coastIndex(JSON.parse(fs.readFileSync(coastFile, 'utf8'))));
  }

  function key() {
    return [new Date().toISOString().slice(0, 10), activities().length, stays().length, flights().length, groundTrips().length, Object.keys(weather()).length,
      Object.keys(wellness()).length, commutes()].join('|');
  }

  // the numbers; null until worked out the first time (then the last ones while new ones are made); made again when
  // a list changes, and once a day (photos and Timeline come in by file)
  function get() {
    const k = key();
    if (memo.key !== k && !working) {
      working = compute().then(v => { memo = { key: k, value: v }; }).catch(e => log(`[stats] ${e.message}`)).finally(() => { working = null; });
    }
    return memo.value;
  }

  async function compute() {
    const today = new Date().toISOString().slice(0, 10), past = d => (d || '').slice(0, 10) <= today;  // not the trips still ahead
    const grid = towns(), pts = days('', today).filter(p => p.at && p.day), acts = activities(), ap = airports();
    const townOf = new Map(), town = p => {
      const c = cell(p.at[0], p.at[1]) + (p.city || '');
      if (!townOf.has(c)) townOf.set(c, grid ? (p.city && cities.townNamed(grid, p.city, p.at[0], p.at[1])) || cities.townAt(grid, p.at[0], p.at[1]) : null);
      return townOf.get(c);
    };
    const named = (p, extra = {}) => { const t = town(p); return { day: p.day, lat: p.at[0], lon: p.at[1], town: t?.name || '', country: t?.cc || '', id: t?.id || 0, ...extra }; };
    const allDays = new Set(pts.map(p => p.day));

    // the farthest each way, hemispheres, the tropics, the Arctic
    const most = (f) => pts.reduce((b, p) => (!b || f(p) > f(b) ? p : b), null);
    const extremes = { north: named(most(p => p.at[0])), south: named(most(p => -p.at[0])), east: named(most(p => p.at[1])), west: named(most(p => -p.at[1])) };
    const homes = homeAirports().map(c => ap[c]).filter(Boolean);
    const home = homes.length ? [homes.reduce((s, a) => s + a.lat, 0) / homes.length, homes.reduce((s, a) => s + a.lon, 0) / homes.length] : null;
    if (home) { const far = most(p => ground.km(home, p.at)); extremes.farthest = named(far, { km: Math.round(ground.km(home, far.at)) }); }
    const daysWhere = test => new Set(pts.filter(test).map(p => p.day)).size;
    const zones = { south: daysWhere(p => p.at[0] < 0), west: daysWhere(p => p.at[1] < 0), tropics: daysWhere(p => Math.abs(p.at[0]) < 23.44),
      arctic: daysWhere(p => p.at[0] > 66.56), antarctic: daysWhere(p => p.at[0] < -66.56) };

    // by the sea
    const coastGrid = await loadCoast().catch(e => { log(`[stats] no coastline: ${e.message}`); return null; });
    const seaDays = new Map();  // day -> nearest km
    if (coastGrid) {
      const near = new Map();
      for (const p of pts) {
        const c = cell(p.at[0], p.at[1]);
        if (!near.has(c)) near.set(c, coastKm(coastGrid, p.at[0], p.at[1]));
        if (near.get(c) <= SEA_KM) seaDays.set(p.day, true);
      }
    }
    const seaByYear = {};
    for (const d of seaDays.keys()) seaByYear[d.slice(0, 4)] = (seaByYear[d.slice(0, 4)] || 0) + 1;

    // up in the mountains: each day's highest place, the nights' heights, the highest you went on foot or by bike
    const actCells = new Map();  // cell -> [activity, point]
    for (const a of acts) {
      if (!a.path || a.trainer) continue;
      const line = ground.decode(a.path);
      for (let i = 0; i < line.length; i += 3) { const c = cell(line[i][0], line[i][1]); if (!actCells.has(c)) actCells.set(c, a); }
    }
    const nightStays = stays().filter(s => s.what !== 'car' && s.lat != null && past(s.start));
    const cells = new Set([...pts.map(p => cell(p.at[0], p.at[1])), ...actCells.keys(), ...nightStays.map(s => cell(s.lat, s.lon))]);
    const h = loadHeights();
    await lookUpHeights([...cells], h, saveHeights, log);
    const dayTop = new Map();
    for (const p of pts) {
      const v = h[cell(p.at[0], p.at[1])];
      if (v != null && (!dayTop.has(p.day) || v > dayTop.get(p.day).h)) dayTop.set(p.day, { h: v, p });
    }
    const above = Object.fromEntries(HEIGHTS.map(m => [m, [...dayTop.values()].filter(x => x.h >= m).length]));
    const topDay = [...dayTop.values()].reduce((b, x) => (!b || x.h > b.h ? x : b), null);
    let topAct = null;
    for (const [c, a] of actCells) { const v = h[c]; if (v != null && (!topAct || v > topAct.h)) topAct = { h: v, a, c }; }
    let nights = 0, highNights = 0, topNight = null;
    for (const s of nightStays) {
      const v = h[cell(s.lat, s.lon)], n = Math.max(1, Math.round((Date.parse(s.end || s.start) - Date.parse(s.start)) / 864e5));
      nights += n;
      if (v != null && v >= 1000) highNights += n;
      if (v != null && (!topNight || v > topNight.h)) topNight = { h: v, s };
    }

    // capitals
    const capitals = new Map();
    for (const p of pts) { const t = town(p); if (t && t.fc === 'PPLC' && !capitals.has(t.id)) capitals.set(t.id, { id: t.id, name: t.name, country: t.cc, first: p.day }); }

    // how far by each means
    const fl = flights().filter(f => past(f.date)), gt = groundTrips().filter(t => past(t.date)), tr = trips().filter(t => past(t.start));
    const by = { flight: fl.reduce((n, f) => n + (f.distance || 0), 0) };
    const mine = places(), since = commuteSince(groundTrips(), mine);
    for (const t of gt) {  // a trip added by hand can stand for several; commutes only when counted (the settings)
      const k = groundKind(t, mine, since);
      if (k !== 'commute' || commutes()) by[k] = (by[k] || 0) + (t.distance || 0) * (t.times || 1);
    }
    for (const d of drives()) if (past(d.date)) by.drive = (by.drive || 0) + d.distance;  // and the drives with a rental car
    const kind = s => (/Ride|Velomobile|Handcycle/.test(s || '') ? 'ride' : /Run/.test(s || '') ? 'run' : /Walk|Hike/.test(s || '') ? 'walk' : null);
    for (const a of acts) { const k = kind(a.sport); if (k && !a.trainer) by[k] = (by[k] || 0) + (a.distance || 0); }
    Object.keys(by).forEach(k => { by[k] = Math.round(by[k]); });
    const total = Object.values(by).reduce((a, b) => a + b, 0);

    // beds
    const beds = {};
    for (const s of nightStays) {
      const n = Math.max(1, Math.round((Date.parse(s.end || s.start) - Date.parse(s.start)) / 864e5));
      const what = stayKind(s);
      beds[what] = (beds[what] || 0) + n;
    }
    const longest = nightStays.reduce((b, s) => {
      const n = Math.round((Date.parse(s.end || s.start) - Date.parse(s.start)) / 864e5);
      return !b || n > b.nights ? { nights: n, place: s.place, start: s.start } : b;
    }, null);

    // New Year's Eves, and the busiest days
    const nye = [];
    const yrs = [...new Set(pts.map(p => p.day.slice(0, 4)))].sort();
    for (const y of yrs) {
      const ps = pts.filter(p => p.day === `${y}-12-31`);
      if (!ps.length) continue;
      const counts = new Map();
      ps.forEach(p => { const t = town(p); if (t) counts.set(t, (counts.get(t) || 0) + 1); });
      const t = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (t) nye.push({ year: +y, town: t.name, country: t.cc, id: t.id });
    }
    const countriesOn = new Map();
    for (const p of pts) { const t = town(p); if (t) { if (!countriesOn.has(p.day)) countriesOn.set(p.day, new Set()); countriesOn.get(p.day).add(t.cc); } }
    const mostCountries = [...countriesOn].reduce((b, [d, s]) => (!b || s.size > b.count ? { day: d, count: s.size, countries: [...s] } : b), null);

    // weather on the rides
    const wx = weather(), rides = acts.filter(a => wx[a.id]);
    const pick = f => { const a = rides.reduce((b, x) => (!b || f(wx[x.id]) > f(wx[b.id]) ? x : b), null); return a && { id: a.id, name: a.name, date: (a.date || '').slice(0, 10), ...wx[a.id] }; };
    const ridesWeather = rides.length ? { count: rides.length, hottest: pick(w => w.tmax), coldest: pick(w => -w.tmin), wettest: pick(w => w.rain),
      windiest: pick(w => w.gust || w.wind), rainy: rides.filter(a => wx[a.id].rain >= 1).length } : null;

    // sleep and heart away and at home
    const well = wellness(), away = new Set();
    for (const t of tr) for (let d = t.start; d <= t.end; d = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10)) away.add(d);
    const avg = (list, k) => { const v = list.map(x => x[k]).filter(Boolean); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const wAway = Object.entries(well).filter(([d]) => away.has(d)).map(([, x]) => x), wHome = Object.entries(well).filter(([d]) => !away.has(d)).map(([, x]) => x);
    const body = wAway.length && wHome.length ? { away: { sleep: avg(wAway, 'sleep'), rhr: avg(wAway, 'rhr'), score: avg(wAway, 'score'), steps: avg(wAway, 'steps') },
      home: { sleep: avg(wHome, 'sleep'), rhr: avg(wHome, 'rhr'), score: avg(wHome, 'score'), steps: avg(wHome, 'steps') } } : null;

    return {
      days: allDays.size, first: [...allDays].sort()[0],
      sea: { days: seaDays.size, km: SEA_KM, byYear: seaByYear },
      heights: { above, top: topDay && named(topDay.p, { h: topDay.h }), activity: topAct && { h: topAct.h, id: topAct.a.id, name: topAct.a.name, sport: topAct.a.sport, date: (topAct.a.date || '').slice(0, 10) },
        nights, highNights, topNight: topNight && { h: topNight.h, place: topNight.s.place, hotel: topNight.s.hotel || '', start: topNight.s.start } },
      extremes, zones, capitals: [...capitals.values()].sort((a, b) => a.first.localeCompare(b.first)),
      distance: { by, total, earth: Math.round(total / EARTH_KM * 10) / 10, moon: Math.round(total / MOON_KM * 100) },
      beds, longest, nye, mostCountries, rides: ridesWeather, body,
      trips: { count: tr.length, awayDays: away.size }
    };
  }

  return { get };
}

// The kind of bed a stay was, for counting nights: at a friend's place (a trip doc's "with a friend", the form's
// friends), with family (the form's family, a relative), both by its kind only, so a "Friends guest house" stays a
// hostel; Couchsurfing, BeWelcome, a hostel, an Airbnb, camping, else a hotel or other
// A train between the town you live in and the one you work in (data/home.json: residence, work) is a commute, counted
// apart from the other trains: from the first month with COMMUTE_MONTH of them on (the job's start; the odd one before
// it, to the airport there, stays a train)
const COMMUTE_KM = 15, COMMUTE_MONTH = 4;
function homeWork(t, home) {
  const r = home.residence, w = home.work;
  if (t.mode !== 'train' || !r || !w || t.from_lat == null || t.to_lat == null) return false;
  const near = (lat, lon, p) => ground.km([lat, lon], [p.lat, p.lon]) < COMMUTE_KM;
  return (near(t.from_lat, t.from_lon, r) && near(t.to_lat, t.to_lon, w)) || (near(t.from_lat, t.from_lon, w) && near(t.to_lat, t.to_lon, r));
}

// the month ('2022-10') commuting began, or null
function commuteSince(trips, home = {}) {
  const months = new Map();
  for (const t of trips) if (homeWork(t, home)) months.set(t.date.slice(0, 7), (months.get(t.date.slice(0, 7)) || 0) + 1);
  return [...months].filter(([, n]) => n >= COMMUTE_MONTH).map(([m]) => m).sort()[0] || null;
}

function groundKind(t, home = {}, since = null) {
  return since && (t.date || '').slice(0, 7) >= since && homeWork(t, home) ? 'commute' : t.mode;
}

function stayKind(s) {
  const kind = `${s.type || ''} ${s.hotel || ''}`;
  return /couchsurf/i.test(s.provider) ? 'Couchsurfing' : /bewelcome/i.test(s.provider) ? 'BeWelcome'
    : /friend/i.test(s.type || '') ? "Friend's place" : /family|relative/i.test(s.type || '') ? 'Family'
    : /hostel/i.test(kind) ? 'Hostel' : /airbnb/i.test(s.provider) ? 'Airbnb' : /camp/i.test(kind) ? 'Camping' : 'Hotel and other';
}

module.exports = { create, coastIndex, coastKm, stayKind, groundKind, commuteSince };
