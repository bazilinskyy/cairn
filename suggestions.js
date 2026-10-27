'use strict';
// Journeys your photos show but nothing else does: your photos, day by day, put you in towns; where they jump from
// one town to another far away (Paris one day, Brussels the next) and no flight, train, bus, ferry or ride of your own
// connects them, that leg is suggested, to add with a click (a bus tour around Europe, a train to St Petersburg).
// Not suggested: moves inside your home countries (to work, to family) and on days with a rental car (drives).
// Legs you said were no trip are kept in data/suggestions.dismissed.json.

const fs = require('fs');
const ground = require('./ground');

const MIN_KM = 60;      // a move shorter than this is a day out, not a journey
const MAX_DAYS = 6;     // photos further apart than this: we do not know what happened between
const MAX_KMH = 900;    // faster than this (between the photos' times) is a clock or a place gone wrong
const MAX_GROUND_KMH = 200, MIN_FLIGHT_KM = 400;

function create({ towns, cities, photos, flights, airports, groundTrips, activities, stays, homeAirports, dismissedFile }) {
  let memo = { key: null, list: [] };
  const dismissed = () => { try { return new Set(JSON.parse(fs.readFileSync(dismissedFile, 'utf8'))); } catch (_) { return new Set(); } };
  const keyOf = s => `${s.from_day}|${s.from_id}|${s.to_id}`;

  function list() {
    const grid = towns();
    const ph = photos(), fl = flights(), gt = groundTrips(), acts = activities(), cars = stays().filter(x => x.what === 'car'), no = dismissed();
    const key = [ph.length, fl.length, gt.length, acts.length, no.size].join('|');
    if (memo.key === key) return memo.list;
    if (!grid) return [];
    const ap = airports(), day = t => new Date(t * 1000).toISOString().slice(0, 10);
    // home: your home airports' countries; moves inside them (to work, to family) are not journeys
    const home = new Set(homeAirports().map(c => ap[c] && cities.townAt(grid, ap[c].lat, ap[c].lon)?.cc).filter(Boolean));
    const driving = (d0, d1) => cars.some(c => c.start <= d1 && (c.end || c.start) >= d0);
    // the photos as a chain of stops: one per run of photos in the same town
    const stops = [], cache = new Map();
    for (const p of [...ph].filter(p => p[2] != null).sort((a, b) => a[1] - b[1])) {
      const c = `${p[2].toFixed(2)},${p[3].toFixed(2)}`;
      if (!cache.has(c)) cache.set(c, cities.townAt(grid, p[2], p[3]));
      const t = cache.get(c);
      if (!t) continue;
      const last = stops[stops.length - 1];
      if (last && last.town === t) { last.t1 = p[1]; last.n++; last.lastPhoto = p[0]; continue; }
      stops.push({ town: t, t0: p[1], t1: p[1], n: 1, firstPhoto: p[0], lastPhoto: p[0] });
    }
    // a stop of one photo between two of the same town is a place gone wrong: left out
    const clean = stops.filter((s, i) => !(s.n === 1 && stops[i - 1] && stops[i + 1] && stops[i - 1].town === stops[i + 1].town));
    const merged = [];
    for (const s of clean) {
      const last = merged[merged.length - 1];
      if (last && last.town === s.town) { last.t1 = s.t1; last.n += s.n; last.lastPhoto = s.lastPhoto; } else merged.push({ ...s });
    }
    // what already connects two days: flights, ground trips, rides and walks from one town to the other
    const near = (a, b) => ground.km(a, b) < 40;
    const connects = (a, b, d0, d1) =>
      fl.some(f => { const x = ap[f.from], y = ap[f.to], d = (f.date || '').slice(0, 10); return x && y && d >= d0 && d <= d1 && (near([x.lat, x.lon], a) || near([y.lat, y.lon], b)); }) ||
      gt.some(t => { const d = (t.date || '').slice(0, 10); return t.from_lat != null && d >= d0 && d <= d1 && (near([t.from_lat, t.from_lon], a) || near([t.to_lat, t.to_lon], b)); }) ||
      acts.some(x => { const d = (x.date || '').slice(0, 10); return x.at && d >= d0 && d <= d1 && (x.distance || 0) >= ground.km(a, b) * 0.6; });
    const out = [];
    for (let i = 1; i < merged.length; i++) {
      const A = merged[i - 1], B = merged[i], a = [A.town.lat, A.town.lon], b = [B.town.lat, B.town.lon];
      const km = ground.km(a, b), hours = Math.max((B.t0 - A.t1) / 3600, 0.1), d0 = day(A.t1), d1 = day(B.t0);
      if (km < MIN_KM || km / hours > MAX_KMH || (B.t0 - A.t1) / 864e2 > MAX_DAYS) continue;
      if (km < MIN_FLIGHT_KM && km / hours > MAX_GROUND_KMH) continue;  // too fast for the road and too near for a flight: a place gone wrong
      if (home.has(A.town.cc) && home.has(B.town.cc)) continue;
      if (driving(d0, d1) || connects(a, b, d0, d1)) continue;
      const s = { from_day: d0, to_day: d1, from: A.town.name, from_id: A.town.id, from_country: A.town.cc, from_lat: A.town.lat, from_lon: A.town.lon,
        to: B.town.name, to_id: B.town.id, to_country: B.town.cc, to_lat: B.town.lat, to_lon: B.town.lon, km: Math.round(km),
        hours: Math.round(hours), photos: [A.n, B.n], last_photo: A.lastPhoto, first_photo: B.firstPhoto,
        // the likeliest way: a flight far, else a train or bus
        mode: km > 1200 || km / hours > MAX_GROUND_KMH ? 'flight' : 'train' };
      if (!no.has(keyOf(s))) out.push({ ...s, key: keyOf(s) });
    }
    memo = { key, list: out.reverse() };
    return memo.list;
  }

  function dismiss(k) {
    const no = dismissed();
    no.add(k);
    fs.writeFileSync(dismissedFile, JSON.stringify([...no]));
    memo.key = null;
  }

  return { list, dismiss };
}

module.exports = { create };
