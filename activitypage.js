'use strict';
// One activity in full, for its page (as a town's or a country's): its numbers, where it started and ended, its route,
// the profile of its timed track (height, speed, heart rate and power along the way: imports/garmin.py's point every
// 5 s), the weather on it, the famous climbs it went up, the photos taken and the music played while it lasted, the
// trip it was part of and that day's sleep.

const ground = require('./ground');

const PROFILE_POINTS = 600;   // the profile's points at most (a long ride's track has thousands)
const SPEED_WINDOW_S = 30;    // speed over this long, so GPS jitter makes no spikes

// list() -> activities; track(id) -> { start, t, pts, alt, hr, pw } or null; weather() -> { id: { ... } };
// climbs() -> [{ id, name, ele, country, rides: [{ id }] }]; photos() -> [[id, unix, lat, lon, video]];
// plays(from, to) -> [[unix, artist, track]]; townAt(lat, lon) -> { id, name, cc } | null; trips() -> [{ id, name, start,
// end }]; day(date) -> that day's sleep and heart rate, or null
function create({ list, track, weather = () => ({}), climbs = () => [], photos = () => [], plays = () => [], townAt = () => null,
  trips = () => [], day = () => null }) {
  function profile(t) {
    const n = t.pts.length, d = [0];
    for (let i = 1; i < n; i++) d.push(d[i - 1] + ground.km(t.pts[i - 1], t.pts[i]));
    // speed over the window ending at each point (from the last point at least that long before, else the one before)
    const speed = [];
    for (let i = 0, j = 0; i < n; i++) {
      while (j + 1 < i && t.t[i] - t.t[j + 1] >= SPEED_WINDOW_S) j++;
      const dt = t.t[i] - t.t[j];
      speed.push(i && dt > 0 ? (d[i] - d[j]) / dt * 3600 : 0);
    }
    const step = Math.max(1, Math.ceil(n / PROFILE_POINTS)), out = [];
    for (let i = 0; i < n; i += step) {
      out.push({ km: +d[i].toFixed(2), s: t.t[i], alt: t.alt?.[i] ?? null, kmh: +speed[i].toFixed(1), hr: t.hr?.[i] ?? null, w: t.pw?.[i] ?? null });
    }
    const vals = list => list.filter(v => v != null && v > 0);
    const max = list => (vals(list).length ? Math.max(...vals(list)) : null);
    const avg = list => (vals(list).length ? Math.round(vals(list).reduce((s, v) => s + v, 0) / vals(list).length) : null);
    return { points: out, km: d[n - 1], maxKmh: speed.length ? +Math.max(...speed).toFixed(1) : null,
      hr: { avg: avg(t.hr || []), max: max(t.hr || []) }, power: { avg: avg(t.pw || []), max: max(t.pw || []) },
      alt: { min: vals(t.alt || []).length ? Math.min(...vals(t.alt)) : null, max: max(t.alt || []) } };
  }

  function get(id) {
    const a = list().find(x => String(x.id) === String(id));
    if (!a) return null;
    const start = Number(a.start) || Math.round(Date.parse(String(a.date).replace(' ', 'T') + 'Z') / 1000);
    const end = start + (Number(a.elapsed_time) || Number(a.moving_time) || 0);
    const pts = a.path ? ground.decode(a.path) : [];
    const t = track(a.id);
    const day0 = String(a.date).slice(0, 10);
    const climbed = climbs().filter(c => (c.rides || []).some(r => String(r.id) === String(a.id)))
      .map(c => ({ id: c.id, name: c.name, ele: c.ele, country: c.country }));
    const shot = photos().filter(p => p[1] >= start - 300 && p[1] <= end + 300).map(p => ({ id: p[0], t: p[1], at: [p[2], p[3]], video: !!p[4] }));
    const played = plays(start, end).map(([at, artist, name]) => ({ t: at, artist, name }));
    const trip = trips().find(x => x.start <= day0 && x.end >= day0);
    const from = pts[0] || (Array.isArray(a.at) ? a.at : null), to = pts[pts.length - 1] || null;
    const town = at => { const x = at && townAt(at[0], at[1]); return x ? { id: x.id, name: x.name, cc: x.cc || x.country } : null; };
    return {
      id: a.id, name: a.name, sport: a.sport, source: a.source, date: a.date, start, end,
      distance: Number(a.distance) || 0, moving_time: Number(a.moving_time) || 0, elapsed_time: Number(a.elapsed_time) || 0,
      elevation: Number(a.elevation) || 0, heartrate: Number(a.heartrate) || null, trainer: a.trainer === true || a.trainer === 'True',
      path: a.path || '', from: town(from), to: town(to), loop: !!(from && to && ground.km(from, to) < 1),
      profile: t?.pts?.length > 1 ? profile(t) : null,
      weather: weather()[a.id] || null, climbs: climbed, photos: shot, music: played,
      trip: trip ? { id: trip.id, name: trip.name, start: trip.start, end: trip.end } : null, day: day(day0)
    };
  }
  return { get };
}

module.exports = { create };
