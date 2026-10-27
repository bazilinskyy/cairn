'use strict';
// Famous cycling climbs (climbs.json: the climbs in the cycle-racing categories of six Wikipedias, towns and
// buildings left out, each with its summit from Wikidata) and which of them your rides went up. A ride counts for a
// climb when it passes within REACH_M of the summit, and for one of its ascents (ascents.js: from Bédoin, from
// Malaucène, ...) when it followed that ascent's last stretch up to the summit. A climb's ascents are worked out in
// the background the first time a ride comes near it, kept in data/climb_ascents.json.

const fs = require('fs');
const path = require('path');
const ground = require('./ground');
const ascentsLib = require('./ascents');
const effortsLib = require('./efforts');

const PHOTO_M = 300, PHOTO_TOP_M = 1000, PHOTO_TOP_S = 20 * 60;  // photos near the way up or the top, and at the top after
const REACH_M = 150, NEAR_M = 1500;  // a ride within NEAR_M of a climb gets its ascents and true top worked out
const RIDE = /Ride|Velomobile|Handcycle/;
const LIST = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'climbs.json'), 'utf8')); } catch (_) { return []; }
})();

// The best known times up the climbs (climb_records.json: from race data, Wikipedia and watts2win.eu, each with its
// source), by the climb's name and the town a way up starts from
const RECORDS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'climb_records.json'), 'utf8')); } catch (_) { return []; }
})();
const norm = s => (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').trim();
// a way up's record: its town the same (without a side: "Gex (south-east)" is Gex) or one in the other's name
// ("Remouchamps" for Sougné-Remouchamps); records that fit none of the climb's ways come with the climb
function records(c, ways) {
  const mine = RECORDS.filter(r => norm(r.climb) === norm(c.name)), by = new Map(), left = [];
  for (const r of mine) {
    const f = norm(r.from);
    const i = [x => norm(x.from) === f, x => norm(x.from).includes(f) || f.includes(norm(x.from))]
      .reduce((found, test) => found >= 0 ? found : ways.findIndex(w => w.from && test(w)), -1);
    if (i >= 0 && !by.has(i)) by.set(i, r); else left.push(r);
  }
  return { by, left };
}

// metres from a point to the segment a-b, on a plane around the point (fine over a few hundred metres)
function metres(p, a, b) {
  const k = Math.cos(p[0] * Math.PI / 180), m = 111320;
  const ax = (a[1] - p[1]) * k * m, ay = (a[0] - p[0]) * m, bx = (b[1] - p[1]) * k * m, by = (b[0] - p[0]) * m;
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function closest(p, pts) {  // metres from p to the route
  let best = Infinity;
  for (let j = 1; j < pts.length; j++) {
    const up = pts[j][0] - p[0], up0 = pts[j - 1][0] - p[0];  // both ends well north, or well south: too far
    if ((up > 0.05 && up0 > 0.05) || (up < -0.05 && up0 < -0.05)) continue;
    best = Math.min(best, metres(p, pts[j - 1], pts[j]));
  }
  return best;
}

// activities: the list as activities.js gives it; key: changes when the list does; towns: GeoNames towns (cities.js)
// profile: () => { ftp, weight, weights: [[day, kg]] } (Garmin); trackDir: the rides' timed tracks
// photos: () => [[id, unix time, lat, lon, video]] (photos.js), for the photos taken on the way up
function create({ activities, key, towns, file, profile = () => ({}), trackDir = null, photos = () => [], log = console.log }) {
  let cache = { key: null }, store = {}, working = false;
  const track = trackDir ? effortsLib.tracks(trackDir) : () => null;
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  const samples = new Map();  // ascent path -> points every 50 m
  const sampled = a => {
    if (!samples.has(a.path)) samples.set(a.path, ascentsLib.resample(ground.decode(a.path)));
    return samples.get(a.path);
  };
  const rides = () => activities().filter(a => RIDE.test(a.sport || '') && !a.trainer && a.path);

  // The climbs near your rides whose ascents are not known yet, one at a time (OSRM's public server: slowly)
  async function learn(todo) {
    if (working || !todo.length || !towns()) return;
    working = true;
    try {
      for (const c of todo) {
        try {
          store[c.id] = await ascentsLib.ascentsOf(c, towns());
          fs.writeFileSync(file, JSON.stringify(store));
          cache.key = null;  // what was ridden is worked out again with these ascents
          log(`[climbs] ${c.name}: ${store[c.id].ascents.map(a => 'from ' + a.from).join(', ') || 'no road up found'}`);
        } catch (e) {
          log(`[climbs] ${c.name}: ${e.message}; tried again later`);
          break;
        }
      }
    } finally { working = false; }
  }

  // Where a ride came up from: the town nearest the point 12 km before the top along the ride
  function approach(c, pts) {
    let i = 0, best = Infinity;
    pts.forEach((p, j) => { const d = metresTo(c, p); if (d < best) { best = d; i = j; } });
    let back = 0;
    while (i > 0 && back < 12000) { back += ground.km(pts[i - 1], pts[i]) * 1000; i--; }
    // the nearest town (not the one that pulls hardest, as for the most visited cities: Bédoin would beat little Sault)
    const p = pts[i], grid = towns();
    let t = null, d = 10;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const town of (grid && grid.get((Math.floor(p[0]) + dy) + ',' + (Math.floor(p[1]) + dx))) || []) {
        const k = ground.km(p, [town.lat, town.lon]);
        if (k < d) { d = k; t = town; }
      }
    }
    return t ? 'via ' + t.name : null;
  }
  const metresTo = (c, p) => ground.km([c.lat, c.lon], p) * 1000;

  function nearestTown(p) {
    const grid = towns();
    let t = null, d = 10;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const town of (grid && grid.get((Math.floor(p[0]) + dy) + ',' + (Math.floor(p[1]) + dx))) || []) {
        const k = ground.km(p, [town.lat, town.lon]);
        if (k < d) { d = k; t = town; }
      }
    }
    return t;
  }
  // an effort with your FTP and weight of its day, and what they would make of a climb of that length and gain
  function withDay(e, lengthKm, gainM) {
    const p = profile() || {}, ftp = ftpOn(e), kg = effortsLib.onDay(p.weights, e.date) ?? p.weight ?? null;
    return { ...e, ftp, kg, wkg: e.power && kg ? Math.round(e.power / kg * 100) / 100 : null,
      predicted: ftp && kg && lengthKm && gainM > 0 ? effortsLib.predict(lengthKm, gainM, ftp, kg) : null };
  }

  // A way up with your times on it (from the rides' tracks), each with your FTP and weight of that day, your best,
  // and the predicted times: yours at today's FTP and weight, and a top climber's
  function timed(a) {
    const s = sampled(a), foot = s[0], top = s[s.length - 1], p = profile() || {};
    const efforts = [];
    for (const r of a.rides) {
      for (const e of effortsLib.efforts(track(r.id), foot, top)) efforts.push(withDay({ ...e, id: r.id, date: r.date, name: r.name }, a.length, a.gain));
    }
    efforts.sort((x, y) => x.seconds - y.seconds);
    return { ...a, times: a.rides.length, rides: a.rides.slice(0, 10), efforts, best: efforts[0] || null,
      you: p.ftp && p.weight ? { ftp: p.ftp, kg: p.weight, seconds: effortsLib.predict(a.length, a.gain, p.ftp, p.weight) } : null,
      pro: { ...effortsLib.PRO, seconds: effortsLib.predict(a.length, a.gain, effortsLib.PRO.wkg * effortsLib.PRO.kg, effortsLib.PRO.kg) } };
  }
  // The FTP of a ride's day: the ride's own (Garmin's intensity factor), else that of the nearest ride with one within
  // 120 days, else today's
  let ftps = null;
  function ftpOn(ride) {
    if (!ftps) ftps = activities().filter(a => a.ftp).map(a => [(a.date || '').slice(0, 10), a.ftp]).sort((x, y) => x[0].localeCompare(y[0]));
    const own = activities().find(a => a.id === ride.id)?.ftp;
    if (own) return own;
    let best = null, gap = 120;
    for (const [d, f] of ftps) {
      const g = Math.abs(Date.parse(d) - Date.parse(ride.date)) / 864e5;
      if (g < gap) { gap = g; best = f; }
    }
    return best ?? profile()?.ftp ?? null;
  }

  // a climb at the road's high point once that is known
  const at = c => (store[c.id]?.top ? { ...c, lat: store[c.id].top[0], lon: store[c.id].top[1], ele: c.ele || store[c.id].top[2] } : c);

  function compute() {
    ftps = null;
    const climbs = LIST.map(at);
    const grid = new Map();  // 0.1-degree cells -> climbs
    climbs.forEach((c, i) => {
      const k = Math.floor(c.lat * 10) + ',' + Math.floor(c.lon * 10);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    });
    const over = new Map(), near = new Set();  // climb -> [{ ride, pts }] that crossed its summit; climbs ridden near
    for (const a of rides()) {
      const pts = ground.decode(a.path);
      if (pts.length < 2) continue;
      const cand = new Set();
      for (const [lat, lon] of pts) {  // the cells the route passes and their neighbours
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          (grid.get((Math.floor(lat * 10) + dy) + ',' + (Math.floor(lon * 10) + dx)) || []).forEach(i => cand.add(i));
        }
      }
      for (const i of cand) {
        const d = closest([climbs[i].lat, climbs[i].lon], pts);
        if (d <= NEAR_M) near.add(i);
        if (d <= REACH_M) {
          if (!over.has(i)) over.set(i, []);
          over.get(i).push({ ride: { id: a.id, date: (a.date || '').slice(0, 10), name: a.name }, pts });
        }
      }
    }
    learn([...near].map(i => LIST[i]).filter(c => !(c.id in store)));
    return climbs.map((c, i) => {
      const list = (over.get(i) || []).sort((x, y) => y.ride.date.localeCompare(x.ride.date));
      const ways = (store[c.id]?.ascents || []).map(a => ({ ...a, rides: [] }));
      // a way up not among the climb's ascents: read from the ride's own heights (efforts.js waysUp), named after
      // the town at its foot; without a timed track, after the town 12 km before the top
      const other = {};
      const prepared = ways.map(a => ({ samples: sampled(a) }));
      for (const { ride, pts } of list) {
        const took = ascentsLib.ridden(prepared, pts);
        took.forEach((t, j) => { if (t) ways[j].rides.push(ride); });
        if (took.some(Boolean)) continue;
        const tr = track(ride.id), found = tr ? effortsLib.waysUp(tr, [c.lat, c.lon]) : [];
        if (!found.length) {
          const v = approach(c, pts) || 'another way';
          (other[v] = other[v] || { rides: [], efforts: [] }).rides.push(ride);
          continue;
        }
        for (const w of found) {
          const e = effortsLib.effortOf(tr, w.from, w.to), foot = tr.pts[w.from];
          const v = nearestTown(foot) ? 'via ' + nearestTown(foot).name : 'another way';
          const o = other[v] = other[v] || { rides: [], efforts: [] };
          if (!o.rides.includes(ride)) o.rides.push(ride);
          o.efforts.push(withDay({ ...e, id: ride.id, date: ride.date, name: ride.name,
            path: ground.encode(ground.simplify(tr.pts.slice(w.from, w.to + 1), 0.00005)) }, e.length, e.gain));
        }
      }
      const rides = list.map(x => x.ride), rec = records(c, ways);
      return { ...c, times: rides.length, first: rides[rides.length - 1]?.date || '', last: rides[0]?.date || '', rides: rides.slice(0, 20),
        ascents: ways.map((a, j) => ({ ...timed(a), record: rec.by.get(j) || null })), records: rec.left,
        other: Object.entries(other).map(([via, o]) => {
          const efforts = o.efforts.sort((x, y) => x.seconds - y.seconds);
          return { via, times: o.rides.length, rides: o.rides.slice(0, 10), efforts, best: efforts[0] || null, path: efforts[0]?.path || null };
        }), known: c.id in store };
    });
  }
  return {
    // One of your efforts up a way, point by point (efforts.js series): { climb, from, date, seconds, points }
    effort(climbId, ride, from) {
      const c = this.list().find(x => x.id === climbId);
      const a = c?.ascents.find(x => x.from === from) || c?.other.find(x => x.via === from);
      const e = a?.efforts?.find(x => String(x.id) === String(ride));
      const tr = e && track(e.id);
      if (!tr) return null;
      return { climb: c.name, from, date: e.date, seconds: e.seconds, kg: e.kg, points: effortsLib.series(tr, e.from, e.to, e.kg) };
    },
    // The photos you took going up a climb: during a timed effort up it, or the next PHOTO_TOP_S at the top; for a
    // ride without a timed track, during the ride. Only those near the way up (PHOTO_M) or the top (PHOTO_TOP_M).
    photos(climbId) {
      const c = this.list().find(x => x.id === climbId);
      if (!c) return null;
      const ways = [...c.ascents.map(a => ({ name: a.from, path: a.path, efforts: a.efforts || [], rides: a.rides || [] })),
        ...c.other.map(o => ({ name: o.via, path: o.path, efforts: o.efforts || [], rides: o.rides || [] }))];
      const byId = new Map(activities().map(a => [String(a.id), a]));
      const windows = [];  // [from, to, ride, way, path points]
      for (const w of ways) {
        const pts = w.path ? ascentsLib.resample(ground.decode(w.path)) : [];
        const timed = new Set();
        for (const e of w.efforts) {
          if (!e.startAt) continue;
          windows.push([e.startAt, e.startAt + e.seconds + PHOTO_TOP_S, e.id, w.name, pts]);
          timed.add(String(e.id));
        }
        for (const r of w.rides) {
          const a = byId.get(String(r.id));
          if (a?.start && !timed.has(String(r.id))) windows.push([a.start, a.start + (a.elapsed_time || a.moving_time || 0), r.id, w.name, pts]);
        }
      }
      for (const r of c.rides) {  // rides over the top by no way known
        const a = byId.get(String(r.id));
        if (a?.start && !windows.some(x => String(x[2]) === String(r.id))) windows.push([a.start, a.start + (a.elapsed_time || a.moving_time || 0), r.id, '', []]);
      }
      const top = [c.lat, c.lon], out = [];
      for (const p of photos()) {
        if (p[2] == null) continue;
        const w = windows.find(([a, b, , , pts]) => p[1] >= a && p[1] <= b &&
          (effortsLib.metres([p[2], p[3]], top) <= PHOTO_TOP_M || pts.some(q => effortsLib.metres([p[2], p[3]], q) <= PHOTO_M)));
        if (w) out.push({ id: p[0], t: p[1], lat: p[2], lon: p[3], video: p[4] || 0, ride: w[2], way: w[3] });
      }
      return out.sort((a, b) => a.t - b.t);
    },
    // all climbs with what you did on them; [] without rides (the layer and the Sports section then stay away)
    list() {
      const k = key();
      if (cache.key !== k) cache = { key: k, list: rides().length ? compute() : [] };
      return cache.list;
    }
  };
}

module.exports = { create, metres, REACH_M, count: () => LIST.length };
