'use strict';
// Trips: the runs of days you were away, from everything Cairn knows (flights, trains, buses and ferries, stays,
// activities, photos, Timeline). A day is away when something puts you outside your home countries (those of your
// home airports) or you slept in a stay; days in a row make a trip when it has a night in a stay, a flight or a
// train, bus or ferry, or lasts three days or more (a ride over the border and back is not a trip). Each trip gets
// its day-by-day story and its moves, as Polarsteps draws them: where you were from photo to photo, activity to
// activity and stay to stay, when no flight, ground trip or activity of your own already shows how you got there.
// Moves of 10 km or more go along the roads (OSRM's car route, looked up in the background, kept in
// data/drives.json); with a rental car on that day they count as drives.

const fs = require('fs');
const ground = require('./ground');

const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const WORK = /conferen|congress|symposi|workshop|summit|seminar|colloqui|summer school|winter school|meeting|kick-?off|defen[cs]e|viva|keynote|invited talk|panel|committee|review|project|hackathon|expo\b|trade fair|training|course\b|lecture|visit to|site visit|retreat|plenary/i;
const MIN_DAYS = 3, MAX_FLOWN_DAYS = 90, MOVE_KM = 1, ROAD_KM = 10, ROAD_MAX_KM = 900, CAR_KMH = 140;
const regionName = (() => {
  try { const n = new Intl.DisplayNames(['en'], { type: 'region' }); return cc => { try { return n.of(cc); } catch (_) { return cc; } }; } catch (_) { return cc => cc; }
})();
const dayOf = t => new Date(t * 1000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
// local clock time ("2026-10-24 15:53") at a longitude as unix seconds: the zone guessed from the longitude
const localToUnix = (s, lon) => {
  const m = /^(\d{4}-\d\d-\d\d)[ T]?(\d\d:\d\d)?/.exec(s || '');
  return m ? Date.parse(`${m[1]}T${m[2] || '12:00'}:00Z`) / 1000 - Math.round((lon || 0) / 15) * 3600 : null;
};

// sources: getters for the server's lists; towns() the town grid (cities.js), or null without the town list
// wellness: () => { day: { rhr, sleep, score, ... } } (Garmin); weather: () => { activity id: the ride's weather }
// calendar: () => [{ start, end, title, location }] (imports/calendar_events.py): what a trip was for (workOf)
function create({ towns, cities, days, flights, airports, groundTrips, stays, activities, photos, homeAirports, file,
  wellness = () => ({}), weather = () => ({}), calendar = () => [], log = console.log }) {
  let memo = { key: null, list: [] };
  let drives = null;
  const loadDrives = () => {
    if (!drives) { try { drives = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { drives = {}; } }
    return drives;
  };

  function homeCountries(grid) {
    const ap = airports();
    return new Set(homeAirports().map(c => ap[c] && cities.townAt(grid, ap[c].lat, ap[c].lon)?.cc).filter(Boolean));
  }

  function list() {
    const grid = towns();
    if (!grid) return [];
    const fl = flights(), gt = groundTrips(), st = stays(), acts = activities(), ph = photos();
    const key = [fl.length, gt.length, st.length, acts.length, ph.length, acts[0]?.id, st[st.length - 1]?.id, (calendar() || []).length].join('|');
    if (memo.key === key) return memo.list;
    const home = homeCountries(grid), ap = airports();
    const cache = new Map(), townOf = (at, city) => {
      const k = at[0].toFixed(2) + ',' + at[1].toFixed(2) + (city ? '|' + city : '');
      if (!cache.has(k)) cache.set(k, (city && cities.townNamed(grid, city, at[0], at[1])) || cities.townAt(grid, at[0], at[1]));
      return cache.get(k);
    };
    const away = new Map();  // day -> { cc -> points }
    const mark = (d, cc) => { if (!away.has(d)) away.set(d, new Map()); if (cc) away.get(d).set(cc, (away.get(d).get(cc) || 0) + 1); };
    const pts = days('', '');
    for (const p of pts) {
      const t = p.at && townOf(p.at, p.city);
      if (t && !home.has(t.cc)) mark(p.day, t.cc);
    }
    for (const p of ph) if (p[2] != null) { const t = townOf([p[2], p[3]]); if (t && !home.has(t.cc)) mark(dayOf(p[1]), t.cc); }
    const nights = new Set();
    for (const s of st) {
      if (s.what === 'car' || !s.start) continue;
      for (let d = s.start, n = 0; d < (s.end || s.start) && n < 120; d = addDays(d, 1), n++) { nights.add(d); mark(d); mark(addDays(d, 1)); }
    }
    const travel = new Set([...fl.map(f => (f.date || '').slice(0, 10)), ...gt.filter(t => !t.approx).map(t => (t.date || '').slice(0, 10))]);
    // flights from a home airport until landing at one again: all those days are away
    const homeAp = new Set(homeAirports());
    let leftOn = null;
    for (const f of [...fl].filter(f => f.date).sort((a, b) => a.date.localeCompare(b.date))) {
      if (homeAp.has(f.from) && !leftOn) leftOn = f.date.slice(0, 10);
      if (leftOn && homeAp.has(f.to)) {  // (not over months with no flight home: you came back some other way)
        if ((Date.parse(f.date.slice(0, 10)) - Date.parse(leftOn)) / 864e5 <= MAX_FLOWN_DAYS) {
          for (let d = leftOn; d <= f.date.slice(0, 10); d = addDays(d, 1)) mark(d);
        }
        leftOn = null;
      }
    }
    const runs = [];
    for (const d of [...away.keys()].sort()) {
      const r = runs[runs.length - 1];
      if (r && addDays(r.end, 1) >= d) r.end = d, r.days.push(d); else runs.push({ start: d, end: d, days: [d] });
    }
    const out = runs.filter(r => r.days.length >= MIN_DAYS || r.days.some(d => nights.has(d) || travel.has(d))).map(r => {
      const cc = new Map();
      r.days.forEach(d => (away.get(d) || new Map()).forEach((n, c) => cc.set(c, (cc.get(c) || 0) + 1)));
      const countries = [...cc].sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ cc: c, days: n }));
      const townList = cities.rank(grid, pts.filter(p => p.day >= r.start && p.day <= r.end)).filter(t => !home.has(t.country) || !countries.length);
      const name = countries.length ? countries.slice(0, 3).map(c => regionName(c.cc)).join(' · ') + (countries.length > 3 ? ' …' : '')
        : (townList[0]?.name || 'Trip');
      const inTrip = d => d && d.slice(0, 10) >= r.start && d.slice(0, 10) <= r.end;
      return { id: r.start, start: r.start, end: r.end, name, days: r.days.length, countries, work: workOf(r.start, r.end, townList),
        towns: townList.slice(0, 6).map(t => ({ id: t.id, name: t.name, country: t.country, lat: t.lat, lon: t.lon, days: t.days })),
        nights: r.days.filter(d => nights.has(d)).length, flights: fl.filter(f => inTrip(f.date)).length,
        ground: gt.filter(t => inTrip(t.date)).length, activities: acts.filter(a => inTrip(a.date)).length,
        photos: ph.filter(p => inTrip(dayOf(p[1]))).length };
    }).reverse();
    memo = { key, list: out };
    return out;
  }

  // One trip in full: its flights, trains, stays, activities and photos, day by day, and the moves between them
  function get(id) {
    const trip = list().find(t => t.id === id);
    if (!trip) return null;
    const grid = towns(), ap = airports();
    const inTrip = d => d && d.slice(0, 10) >= trip.start && d.slice(0, 10) <= trip.end;
    const fl = flights().filter(f => inTrip(f.date) && ap[f.from] && ap[f.to]).sort((a, b) => a.date.localeCompare(b.date));
    const gt = groundTrips().filter(t => inTrip(t.date)).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const st = stays().filter(s => s.start && s.start <= trip.end && (s.end || s.start) >= trip.start).sort((a, b) => a.start.localeCompare(b.start));
    const acts = activities().filter(a => inTrip(a.date)).sort((a, b) => (a.start || 0) - (b.start || 0));
    const ph = photos().filter(p => p[2] != null && inTrip(dayOf(p[1]))).sort((a, b) => a[1] - b[1]);
    const pts = days(trip.start, trip.end);

    // the events of the trip in time, each where it happened; flights, ground trips and activities cover the time
    // from their start to their end (they are drawn themselves)
    const ev = [];
    for (const p of ph) ev.push({ t: p[1], at: [p[2], p[3]], what: 'photo' });
    for (const a of acts) {
      const path = a.path ? ground.decode(a.path) : [];
      if (!a.start || !path.length) continue;
      ev.push({ t: a.start, at: path[0], what: 'activity', cover: 'a' + a.id });
      ev.push({ t: a.start + (a.elapsed_time || a.moving_time || 0), at: path[path.length - 1], what: 'activity', cover: 'a' + a.id });
    }
    for (const t of gt) {
      if (t.from_lat == null || t.to_lat == null) continue;
      const t0 = localToUnix(t.date, t.from_lon), t1 = t.arrival ? localToUnix(t.arrival, t.to_lon) : t0 + Math.max(1800, (t.distance || 50) / 60 * 3600);
      ev.push({ t: t0, at: [t.from_lat, t.from_lon], what: 'ground', cover: 'g' + t.id });
      ev.push({ t: t1, at: [t.to_lat, t.to_lon], what: 'ground', cover: 'g' + t.id });
    }
    for (const f of fl) {
      const a = ap[f.from], b = ap[f.to], t0 = localToUnix(f.date, a.lon);
      const [h, m] = (f.duration || '').split(':').map(Number);
      ev.push({ t: t0, at: [a.lat, a.lon], what: 'flight', cover: 'f' + f.id });
      ev.push({ t: t0 + ((h || 0) * 60 + (m || 0) || 120) * 60, at: [b.lat, b.lon], what: 'flight', cover: 'f' + f.id });
    }
    for (const s of st) {
      if (s.lat == null || s.what === 'car') continue;
      ev.push({ t: localToUnix(s.start + ' 18:00', s.lon), at: [s.lat, s.lon], what: 'stay' });
      if (s.end) ev.push({ t: localToUnix(s.end + ' 10:00', s.lon), at: [s.lat, s.lon], what: 'stay' });
    }
    // a photo or a stay's check-in during a flight, train or activity is on the way (or its clock is off): left out
    const spans = {};
    ev.filter(e => e.cover).forEach(e => { const x = spans[e.cover] = spans[e.cover] || [e.t, e.t]; x[0] = Math.min(x[0], e.t); x[1] = Math.max(x[1], e.t); });
    const during = e => !e.cover && Object.values(spans).some(([a, b]) => e.t > a && e.t < b);
    ev.splice(0, ev.length, ...ev.filter(e => !during(e)).sort((a, b) => a.t - b.t));
    const cars = st.filter(s => s.what === 'car');
    const carOn = t => cars.some(c => dayOf(t) >= c.start && dayOf(t) <= (c.end || c.start));
    const moves = [];
    let last = null;
    for (const e of ev) {
      if (last && last.cover && e.cover === last.cover) { last = e; continue; }  // drawn by its own line
      if (last) {
        const km = ground.km(last.at, e.at);
        if (km >= MOVE_KM) {
          const hours = Math.max((e.t - last.t) / 3600, 0.01), car = carOn(last.t);
          const road = km >= ROAD_KM && km <= ROAD_MAX_KM && (car || km / hours <= CAR_KMH);
          moves.push({ from: last.at, to: e.at, t0: last.t, t1: e.t, km: Math.round(km * 10) / 10, kind: road ? (car ? 'drive' : 'road') : 'move' });
        } else if (!e.cover) continue;  // a few steps on: keep the earlier place as where you were
      }
      last = e;
    }
    const known = loadDrives(), missing = [];
    for (const m of moves) {
      if (m.kind === 'move') continue;
      const k = driveKey(m.from, m.to);
      if (k in known) { if (known[k]) m.path = known[k].path, m.km = known[k].km; else m.kind = m.kind === 'drive' ? 'drive' : 'move'; } else missing.push(m);
    }
    if (missing.length) lookUp(missing);

    // day by day: where (towns), where you slept, how you moved, what you did, photos
    const well = wellness() || {}, wx = weather() || {};
    const pick = (x, keys) => (x ? Object.fromEntries(keys.filter(k => x[k] != null).map(k => [k, x[k]])) : null);
    const dayList = [];
    for (let d = trip.start; d <= trip.end; d = addDays(d, 1)) {
      const towns_ = grid ? cities.rank(grid, pts.filter(p => p.day === d)).slice(0, 4).map(t => ({ id: t.id, name: t.name, country: t.country })) : [];
      dayList.push({ day: d, towns: towns_,
        stay: st.find(s => s.what !== 'car' && s.start <= d && (s.end || s.start) > d)?.id ?? null,
        flights: fl.filter(f => f.date.slice(0, 10) === d).map(f => f.id), ground: gt.filter(t => (t.date || '').slice(0, 10) === d).map(t => t.id),
        activities: acts.filter(a => (a.date || '').slice(0, 10) === d).map(a => a.id),
        photos: ph.filter(p => dayOf(p[1]) === d).length,
        road: Math.round(moves.filter(m => m.kind !== 'move' && dayOf(m.t0) === d).reduce((n, m) => n + m.km, 0)),
        body: pick(well[d], ['rhr', 'sleep', 'score', 'deep', 'rem', 'bb_max', 'steps']) });
    }
    // sleep and resting heart rate on the trip, and in the 30 days before it (at home, mostly)
    const mean = (from, to, k) => {
      const v = Object.entries(well).filter(([d, x]) => d >= from && d <= to && x[k]).map(([, x]) => x[k]);
      return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
    };
    const before = [addDays(trip.start, -30), addDays(trip.start, -1)];
    const body = { rhr: mean(trip.start, trip.end, 'rhr'), sleep: mean(trip.start, trip.end, 'sleep'), score: mean(trip.start, trip.end, 'score'),
      rhr_before: mean(...before, 'rhr'), sleep_before: mean(...before, 'sleep'), score_before: mean(...before, 'score') };
    return { ...trip,
      flights: fl.map(f => ({ id: f.id, date: f.date, from: f.from, to: f.to, flight_number: f.flight_number, airline: f.airline, distance: f.distance,
        from_city: ap[f.from]?.city, to_city: ap[f.to]?.city })),
      ground: gt.map(t => ({ id: t.id, date: t.date, arrival: t.arrival, mode: t.mode, service: t.service, from: t.from, to: t.to, distance: t.distance })),
      stays: st.map(s => ({ id: s.id, what: s.what, start: s.start, end: s.end, place: s.place, hotel: s.hotel, type: s.type, provider: s.provider, lat: s.lat, lon: s.lon })),
      activities: acts.map(a => ({ id: a.id, date: a.date, name: a.name, sport: a.sport, distance: a.distance, moving_time: a.moving_time, elevation: a.elevation,
        weather: wx[a.id] || null })), body,
      photo_ids: ph.map(p => p[0]), photos: ph.map(p => [p[0], p[1], p[2], p[3], p[4] || 0]), moves,
      roads_pending: missing.length, dayList };
  }

  // the car route of a move, in the background, one a second (OSRM's demo server), kept for good
  const driveKey = (a, b) => `${a[0].toFixed(3)},${a[1].toFixed(3)}|${b[0].toFixed(3)},${b[1].toFixed(3)}`;
  let queue = [], running = false;
  function lookUp(moves) {
    const known = loadDrives(), have = new Set(queue.map(m => driveKey(m.from, m.to)));
    queue.push(...moves.filter(m => !(driveKey(m.from, m.to) in known) && !have.has(driveKey(m.from, m.to))));
    if (running) return;
    running = true;
    (async () => {
      while (queue.length) {
        const m = queue.shift(), k = driveKey(m.from, m.to);
        try {
          await new Promise(r => setTimeout(r, 1100));
          const res = await fetch(`${OSRM}${m.from[1]},${m.from[0]};${m.to[1]},${m.to[0]}?overview=full&geometries=polyline6`,
            { headers: { 'User-Agent': 'cairn (personal travel log; https://github.com/bazilinskyy/cairn)' }, signal: AbortSignal.timeout(30000) });
          if (res.status === 429 || res.status >= 500) throw new Error('OSRM: HTTP ' + res.status);
          const d = await res.json(), pts = d.code === 'Ok' && d.routes?.[0] ? ground.decode(d.routes[0].geometry, 6) : [];
          // a route much longer than the way there (across water, a closed border): no road; the move stays a line
          known[k] = ground.plausible(pts, m.from, m.to) && ground.km(pts[0], m.from) < 2 && ground.km(pts[pts.length - 1], m.to) < 2
            ? { path: ground.encode(ground.simplify(pts)), km: Math.round(d.routes[0].distance / 100) / 10 } : null;
          fs.writeFileSync(file, JSON.stringify(known));
        } catch (e) {
          log(`[trips] road lookups paused: ${e.message}`);
          queue = [];
        }
      }
      running = false;
    })();
  }

  // The events of your calendars that say a trip was for work: during it, and either named so (a conference, a
  // workshop, a project meeting) or of several days in one of its towns; their titles, the longest first
  function workOf(start, end, townList) {
    const names = townList.map(t => t.name.toLowerCase());
    return (calendar() || []).filter(e => e.start <= end && e.end >= start && (WORK.test(`${e.title} ${e.location}`)
      || (e.end > e.start && names.some(n => (e.location || '').toLowerCase().includes(n)))))
      .sort((a, b) => (Date.parse(b.end) - Date.parse(b.start)) - (Date.parse(a.end) - Date.parse(a.start)))
      .map(e => e.title).filter((t, i, all) => t && all.indexOf(t) === i).slice(0, 3);
  }

  return { list, get };
}

module.exports = { create, localToUnix };
