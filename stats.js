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
const HEIGHTS = [500, 1000, 1500, 2000, 2500, 3000, 4000];
// below sea level: land under it (Dutch polders, the Dead Sea at -430 m), not the sea's depth the terrain tiles also
// give, so only places this far from the coast
const LOW_MIN = -450, LOW_COAST_KM = 2, LOW_SHALLOW = -10;
// deeper than LOW_SHALLOW only in the land's own depressions ([south, west, north, east]); elsewhere it is the sea
// (a ferry photo off an island can read -400 m)
const DEPRESSIONS = [[29.5, 35.0, 33.0, 35.8], [36.5, 45.5, 47.5, 55.5], [35.8, -117.6, 37.0, -116.5], [42.4, 88.3, 43.3, 90.2],
  [12.8, 39.6, 15.2, 41.2], [28.3, 25.3, 30.7, 29.7], [11.4, 42.2, 11.9, 42.7], [32.5, -116.3, 33.7, -115.3]];
const inDepression = ([lat, lon]) => DEPRESSIONS.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e);
const HOME_RINGS = [50, 500, 2000, 5000];  // km: at home, near, the region, the continent, far away
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
    // below sea level: each day's lowest place on land (inland of the coast, above the Dead Sea)
    const dayLow = new Map(), inland = new Map();
    for (const p of pts) {
      const c = cell(p.at[0], p.at[1]), v = h[c];
      if (v == null || v >= 0 || v < LOW_MIN || (v < LOW_SHALLOW && !inDepression(p.at))) continue;
      if (!inland.has(c)) inland.set(c, !coastGrid || coastKm(coastGrid, p.at[0], p.at[1]) > LOW_COAST_KM);
      if (inland.get(c) && (!dayLow.has(p.day) || v < dayLow.get(p.day).h)) dayLow.set(p.day, { h: v, p });
    }
    const lowest = [...dayLow.values()].reduce((b, x) => (!b || x.h < b.h ? x : b), null);
    const topDay = [...dayTop.values()].reduce((b, x) => (!b || x.h > b.h ? x : b), null);
    let topAct = null;
    for (const [c, a] of actCells) { const v = h[c]; if (v != null && (!topAct || v > topAct.h)) topAct = { h: v, a, c }; }
    let nights = 0, highNights = 0, topNight = null;
    const sideAway = awayNights(stays());
    for (const s of nightStays) {
      const v = h[cell(s.lat, s.lon)], n = sleptNights(s, sideAway);
      nights += n;
      if (v != null && v >= 1000) highNights += n;
      if (v != null && (!topNight || v > topNight.h)) topNight = { h: v, s };
    }

    // how far from home each day (its farthest place), the months away, the weekdays you fly, crossing the equator
    // and the date line, leap days
    const dayFar = new Map();
    if (home) for (const p of pts) { const k = ground.km(home, p.at); if (!dayFar.has(p.day) || k > dayFar.get(p.day)) dayFar.set(p.day, k); }
    const rings = home ? [...HOME_RINGS, Infinity].map((max, i) => ({ min: i ? HOME_RINGS[i - 1] : 0, max: Number.isFinite(max) ? max : null,
      days: [...dayFar.values()].filter(k => k >= (i ? HOME_RINGS[i - 1] : 0) && k < max).length })) : null;
    const flown = flights().filter(f => past(f.date) && ap[f.from] && ap[f.to]);
    const weekdays = [0, 0, 0, 0, 0, 0, 0];  // Monday first
    flown.forEach(f => { weekdays[(new Date(f.date.slice(0, 10) + 'T12:00:00Z').getUTCDay() + 6) % 7]++; });
    const crossings = { equator: flown.filter(f => Math.sign(ap[f.from].lat) !== Math.sign(ap[f.to].lat)).length,
      dateLine: flown.filter(f => Math.abs(ap[f.from].lon - ap[f.to].lon) > 180).length };
    const leapDays = [...new Set(pts.filter(p => p.day.slice(5) === '02-29').map(p => p.day))].sort().map(d => {
      const counts = new Map();
      pts.filter(p => p.day === d).forEach(p => { const t = town(p); if (t) counts.set(t, (counts.get(t) || 0) + 1); });
      const t = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
      return t && { year: +d.slice(0, 4), town: t.name, country: t.cc, id: t.id };
    }).filter(Boolean);

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
      const n = sleptNights(s, sideAway);
      const what = stayKind(s);
      beds[what] = (beds[what] || 0) + n;
    }
    const longest = nightStays.reduce((b, s) => {
      const n = s.end ? sleptNights(s, sideAway) : 0;
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
      trips: { count: tr.length, awayDays: away.size,
        byMonth: Array.from({ length: 12 }, (_, m) => [...away].filter(d => +d.slice(5, 7) === m + 1).length) },
      below: { days: dayLow.size, lowest: lowest && named(lowest.p, { h: lowest.h }) },
      tops: Object.fromEntries([[0, [...dayTop.values()].filter(x => x.h < HEIGHTS[0]).length],
        ...HEIGHTS.map((m, i) => [m, [...dayTop.values()].filter(x => x.h >= m && (i === HEIGHTS.length - 1 || x.h < HEIGHTS[i + 1])).length])]),
      rings, weekdays, crossings, leapDays
    };
  }

  return { get };
}

// The kind of bed a stay was, for counting nights: at a friend's place (a trip doc's "with a friend", the form's
// friends), with family (the form's family, a relative), both by its kind only, so a "Friends guest house" stays a
// hostel; Couchsurfing, BeWelcome, Trustroots, a hostel, an Airbnb, camping, else a hotel or other
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
    : /trustroots/i.test(s.provider) ? 'Trustroots'
    : /friend/i.test(s.type || '') ? "Friend's place" : /family|relative/i.test(s.type || '') ? 'Family'
    : /hostel/i.test(kind) ? 'Hostel' : /airbnb/i.test(s.provider) ? 'Airbnb' : /camp/i.test(kind) ? 'Camping' : 'Hotel and other';
}

// Nights away from a base: a stay inside a longer one, in another town (a night in another city while a flat was kept
// on, a road trip from a city booking, a monastery each night of a stay on Mount Athos), is where you slept, so its nights come off the base's. Map base ->
// { nights: how many, days: the base's days spent wholly away (between arriving at a side trip and leaving it) }
const AWAY_KM = 20;
const bookedNights = s => Math.max(1, Math.round((Date.parse(s.end || s.start) - Date.parse(s.start)) / 864e5));
const townKey = p => (p || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s*\(.*?\)/g, '').replace(/[^a-z]/g, '');
function sideTrip(base, s) {
  if (s === base || s.what === 'car' || base.what === 'car' || !s.end || !base.end || s.start < base.start || s.end > base.end ||
    bookedNights(s) >= bookedNights(base)) return false;
  if (s.place && base.place && s.place.startsWith(`${base.place} - `)) return true;  // "Mount Athos - Iviron" in "Mount Athos"
  if (base.lat != null && s.lat != null) return ground.km([base.lat, base.lon], [s.lat, s.lon]) > AWAY_KM;
  return townKey(base.place) !== townKey(s.place);
}
let awayMemo = { stays: null, sig: '', out: null };  // kept while the stays are the same (their nights and places)
function awayNights(stays) {
  const sig = stays.map(s => `${s.id}|${s.what}|${s.start}|${s.end}|${s.lat}|${s.lon}|${s.place}`).join('\n');
  if (awayMemo.stays === stays && awayMemo.sig === sig) return awayMemo.out;
  const out = awayNightsOf(stays);
  awayMemo = { stays, sig, out };
  return out;
}
function awayNightsOf(stays) {
  const beds = stays.filter(s => s.what !== 'car' && s.start && s.end > s.start).sort((a, b) => a.start.localeCompare(b.start));
  const out = new Map(), next = d => new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10);
  for (const base of beds) {
    const nights = new Set(), days = new Set();
    for (const s of beds) {
      if (s.start >= base.end) break;
      if (!sideTrip(base, s)) continue;
      for (let d = s.start; d < s.end; d = next(d)) { nights.add(d); if (d > s.start) days.add(d); }
    }
    if (nights.size) out.set(base, { nights: nights.size, days });
  }
  return out;
}
// the nights you slept in a stay: those booked, less those away on side trips (awayNights)
const sleptNights = (s, away) => Math.max(0, bookedNights(s) - (away.get(s)?.nights || 0));

module.exports = { inDepression, create, coastIndex, coastKm, stayKind, groundKind, commuteSince, sideTrip, awayNights, sleptNights };
