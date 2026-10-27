'use strict';
// Strava activities for the map, as statshunters shows them. Cairn signs in once (OAuth, read-only), then keeps
// data/strava.json in step with the list of activities, each with its route (Strava's summary polyline): new ones
// every hour, the whole list once a day (so renamed, made private or deleted activities follow).
// Made for thousands of activities: the explored tiles of each are worked out here, once, not in the browser, and
// the list goes to the browser gzipped, or not at all when it has not changed (ETag).

const fs = require('fs');
const zlib = require('zlib');
const ground = require('./ground');

const API = 'https://www.strava.com/api/v3';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const SCOPE = 'read,activity:read_all';
const FULL_EVERY = 864e5;  // ms between full listings

// Map tiles at zoom 14 a route passes through, as statshunters and VeloViewer count them, packed as x * 16384 + y.
// Points are added every ~200 m along each segment, so a long straight stretch misses no tile.
const TILE_Z = 14, TILES = 2 ** TILE_Z;
function tilesOf(pts) {
  const out = new Set();
  const add = (lat, lon) => {
    const r = lat * Math.PI / 180;
    out.add(Math.floor((lon + 180) / 360 * TILES) * TILES + Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * TILES));
  };
  pts.forEach((b, i) => {
    const a = pts[Math.max(0, i - 1)];
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], (b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180)) / 0.002));
    for (let s = 1; s <= steps; s++) add(a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps);
  });
  return [...out];
}

// One activity as the map keeps it; times are the activity's own local time
function toActivity(a) {
  const pts = a.map?.summary_polyline ? ground.decode(a.map.summary_polyline, 5) : [];
  return {
    id: a.id, name: a.name || '', sport: a.sport_type || a.type || 'Workout',
    date: (a.start_date_local || '').replace('T', ' ').replace('Z', ''), start: Date.parse(a.start_date) / 1000 || 0,
    distance: Math.round((a.distance || 0) / 100) / 10, moving_time: a.moving_time || 0,
    elevation: Math.round(a.total_elevation_gain || 0), elapsed_time: a.elapsed_time || 0,
    heartrate: a.average_heartrate ? Math.round(a.average_heartrate) : null, prs: a.pr_count || 0, kudos: a.kudos_count || 0,
    commute: !!a.commute, trainer: !!a.trainer, path: pts.length > 1 ? ground.encode(pts) : '',
    at: pts.length ? pts[0].map(x => Math.round(x * 1e5) / 1e5) : null, tiles: pts.length > 1 ? tilesOf(pts) : []
  };
}

// A full listing replaces the list; an incremental one adds to it (and updates what it lists again)
function merge(old, fresh, full) {
  if (full) return [...fresh].sort((a, b) => b.start - a.start);
  const byId = new Map(old.map(a => [a.id, a]));
  fresh.forEach(a => byId.set(a.id, a));
  return [...byId.values()].sort((a, b) => b.start - a.start);
}

function create({ tokenFile, dataFile, keys, redirectUri, log = console.log }) {
  const read = (f, empty) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return empty; } };
  const write = (f, v, mode) => { fs.writeFileSync(f, JSON.stringify(v), mode ? { mode } : undefined); if (mode) fs.chmodSync(f, mode); };
  let data = read(dataFile, { activities: [] }), syncing = null, lastError = '', payload = null;
  (data.activities || []).forEach(a => {  // kept by an older Cairn: add what the map now expects
    if (a.tiles && a.at !== undefined) return;
    const pts = a.path ? ground.decode(a.path) : [];
    a.at = pts.length ? pts[0].map(x => Math.round(x * 1e5) / 1e5) : null;
    a.tiles = pts.length > 1 ? tilesOf(pts) : [];
  });

  async function tokenCall(params) {
    const { id, secret } = keys();
    const res = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, client_secret: secret, ...params }), signal: AbortSignal.timeout(30000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Strava sign-in: HTTP ${res.status} ${body.message || ''}`.trim());
    const old = read(tokenFile, {});
    const token = { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: body.expires_at,
      athlete: body.athlete ? { id: body.athlete.id, firstname: body.athlete.firstname } : old.athlete };
    write(tokenFile, token, 0o600);
    return token;
  }

  async function accessToken() {
    let t = read(tokenFile, null);
    if (!t) throw new Error('not connected to Strava');
    if (t.expires_at - 300 < Date.now() / 1000) t = await tokenCall({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    return t.access_token;
  }

  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      const full = !data.last_full || Date.now() - Date.parse(data.last_full) > FULL_EVERY;
      const after = full ? 0 : Math.max(0, ...data.activities.map(a => a.start)) - 1;
      const fresh = [];
      for (let page = 1; ; page++) {
        const res = await fetch(`${API}/athlete/activities?per_page=200&page=${page}&after=${after}`, {
          headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(60000)
        });
        if (!res.ok) throw new Error(`Strava: HTTP ${res.status}${res.status === 429 ? ' (rate limit, tried again later)' : ''}`);
        const list = await res.json();
        if (!list.length) break;
        fresh.push(...list.map(toActivity));
      }
      const now = new Date().toISOString();
      data = { activities: merge(data.activities || [], fresh, full), last_sync: now, last_full: full ? now : data.last_full };
      write(dataFile, data);
      payload = null;
      lastError = '';
      log(`[strava] ${full ? 'all' : 'new'} activities: ${fresh.length}, ${data.activities.length} in all`);
    })().catch(e => { lastError = e.message; log(`[strava] ${e.message}`); }).finally(() => { syncing = null; });
    return syncing;
  }

  return {
    activities: () => data.activities || [],
    // The list as the browser gets it, made once per change: JSON, its gzip and an ETag
    payload() {
      if (!payload) {
        const json = Buffer.from(JSON.stringify(data.activities || []));
        payload = { json, gz: zlib.gzipSync(json), etag: `"${(data.activities || []).length}-${data.last_sync || ''}"` };
      }
      return payload;
    },
    status() {
      const { id, secret } = keys(), t = read(tokenFile, null);
      return { configured: !!(id && secret), connected: !!t, athlete: t?.athlete?.firstname || '', count: (data.activities || []).length,
        last_sync: data.last_sync || '', error: lastError };
    },
    authorizeUrl: () => `https://www.strava.com/oauth/authorize?${new URLSearchParams({
      client_id: keys().id, redirect_uri: redirectUri, response_type: 'code', approval_prompt: 'auto', scope: SCOPE })}`,
    async connect(code, scope) {
      if (!/activity:read/.test(scope || '')) throw new Error('Strava did not allow reading activities: tick "View data about your activities" and connect again');
      await tokenCall({ code, grant_type: 'authorization_code' });
      data = { activities: [] };  // a new sign-in may be another athlete: list everything again
      payload = null;
      sync();
    },
    sync,
    connected: () => !!read(tokenFile, null)
  };
}

module.exports = { create, toActivity, merge, tilesOf };
