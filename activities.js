'use strict';
// All sports activities for the map and the Sports tab, from every source: Garmin (data/garmin.json, written by
// imports/garmin.py from the data export and the hourly Garmin Connect sync) and Strava (strava.js). Garmin uploads
// to Strava too: an activity in both, started within two minutes of each other and of the same kind, is kept once,
// Garmin's (its route is the full track, not Strava's simplified one). Apple Health's workouts (data/health.json,
// imports/health.py) come last: one Garmin or Strava has too is left to them (Garmin Connect and Strava write theirs
// to Health, Connect at times in the wrong time zone: sameWorkout).

const zlib = require('zlib');
const { tilesOf } = require('./strava');
const ground = require('./ground');

const KIND = s => (/Ride|Velomobile|Handcycle|Wheelchair/.test(s) ? 'ride' : /Run/.test(s) ? 'run' : /Walk|Hike|Snowshoe/.test(s) ? 'walk' : 'sport');

function merge(garmin, strava) {
  const slots = new Map();  // kind | minute -> a Garmin activity started then
  garmin.forEach(a => {
    for (const d of [-2, -1, 0, 1, 2]) slots.set(`${KIND(a.sport)}|${Math.round(a.start / 60) + d}`, a);
  });
  const fromStrava = strava.filter(a => !slots.has(`${KIND(a.sport)}|${Math.round(a.start / 60)}`));
  return [...garmin, ...fromStrava].sort((a, b) => b.start - a.start);
}
const HEALTH_SAME_S = 600, HEALTH_SHIFT_S = 15 * 3600;
const GARMIN_APP = /^(Connect|Garmin Connect)$/;  // what Garmin Connect writes to Health: Garmin's own data has it all
// the same workout in Health and in Garmin or Strava: started within ten minutes, of the same kind; or written into
// Health in the wrong time zone (Garmin Connect does), its start whole quarter hours off (within two minutes) and
// as long (within 3% or 150 m; without a distance, within a minute and a half)
function sameWorkout(h, a) {
  const d = Math.abs(a.start - h.start);
  if (d <= HEALTH_SAME_S && KIND(a.sport) === KIND(h.sport)) return true;
  if (d > HEALTH_SHIFT_S || Math.min(d % 900, 900 - (d % 900)) > 120) return false;
  const x = h.distance || 0, y = a.distance || 0;
  if (x || y) return Math.abs(x - y) <= Math.max(0.15, 0.03 * Math.max(x, y));
  return Math.abs((h.elapsed_time || 0) - (a.elapsed_time || a.moving_time || 0)) <= 90;
}
function withHealth(list, health) {
  if (!health.length) return list;
  const sorted = [...list].sort((a, b) => a.start - b.start), starts = sorted.map(a => a.start);
  const first = t => { let lo = 0, hi = starts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] < t) lo = m + 1; else hi = m; } return lo; };
  const known = h => { for (let i = first(h.start - HEALTH_SHIFT_S); i < sorted.length && sorted[i].start <= h.start + HEALTH_SHIFT_S; i++) if (sameWorkout(h, sorted[i])) return true; return false; };
  const fresh = health.filter(h => !GARMIN_APP.test(h.app || '') && !known(h));
  return fresh.length ? [...list, ...fresh].sort((a, b) => b.start - a.start) : list;
}

// sources: { garmin: () => the garmin.json document, strava, health: () => the health.json document } (each read
// again only when it changed)
function create({ garmin, strava, health = () => ({}) }) {
  let cache = { g: null, s: null, h: null };
  function current() {
    const g = garmin(), s = strava.activities(), h = health();
    if (cache.g !== g || cache.s !== s || cache.h !== h) {
      const fromGarmin = (g.activities || []).map(a => {  // made by an older importer: what the map now expects
        if (a.tiles) return a;
        const pts = a.path ? ground.decode(a.path) : [];
        return { ...a, at: pts.length ? pts[0] : null, tiles: pts.length > 1 ? tilesOf(pts) : [] };
      });
      cache = { g, s, h, list: withHealth(merge(fromGarmin, s), (h && h.activities) || []), payload: null };
    }
    return cache;
  }
  return {
    list: () => current().list,
    // The list as the browser gets it, made once per change: JSON, its gzip and an ETag
    payload() {
      const c = current();
      if (!c.payload) {
        const json = Buffer.from(JSON.stringify(c.list));
        const g = c.g || {};
        c.payload = { json, gz: zlib.gzipSync(json), etag: `"${c.list.length}-${g.last_sync || ''}-${strava.status().last_sync || ''}-${((c.h || {}).activities || []).length}"` };
      }
      return c.payload;
    },
    status() {
      const g = current().g || {};
      return {
        count: current().list.length,
        garmin: { count: (g.activities || []).length, last_sync: g.last_sync || '', error: g.error || '', error_at: g.error_at || '' },
        strava: strava.status(),
        health: { count: ((current().h || {}).activities || []).length }
      };
    }
  };
}

module.exports = { create, merge, withHealth };
