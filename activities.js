'use strict';
// All sports activities for the map and the Sports tab, from every source: Garmin (data/garmin.json, written by
// imports/garmin.py from the data export and the hourly Garmin Connect sync) and Strava (strava.js). Garmin uploads
// to Strava too: an activity in both, started within two minutes of each other and of the same kind, is kept once,
// Garmin's (its route is the full track, not Strava's simplified one).

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

// sources: { garmin: () => the garmin.json document, strava } (each read again only when it changed)
function create({ garmin, strava }) {
  let cache = { g: null, s: null };
  function current() {
    const g = garmin(), s = strava.activities();
    if (cache.g !== g || cache.s !== s) {
      const fromGarmin = (g.activities || []).map(a => {  // made by an older importer: what the map now expects
        if (a.tiles) return a;
        const pts = a.path ? ground.decode(a.path) : [];
        return { ...a, at: pts.length ? pts[0] : null, tiles: pts.length > 1 ? tilesOf(pts) : [] };
      });
      cache = { g, s, list: merge(fromGarmin, s), payload: null };
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
        c.payload = { json, gz: zlib.gzipSync(json), etag: `"${c.list.length}-${g.last_sync || ''}-${strava.status().last_sync || ''}"` };
      }
      return c.payload;
    },
    status() {
      const g = current().g || {};
      return {
        count: current().list.length,
        garmin: { count: (g.activities || []).length, last_sync: g.last_sync || '', error: g.error || '', error_at: g.error_at || '' },
        strava: strava.status()
      };
    }
  };
}

module.exports = { create, merge };
