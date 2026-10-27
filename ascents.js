'use strict';
// The ways up a climb, and which of them a ride took. A climb's ascents are worked out once, when a ride first comes
// near its summit: roads from the summit down to the towns around it (OSRM), with heights along them from the open
// AWS Terrain Tiles; a road goes down until it starts to climb again, and that point is the ascent's foot. Two roads
// with feet close together are one ascent; each is named after the town at its foot.
// A ride counts for an ascent when it follows the ascent's last stretch up to the summit, going up, and also the part
// that sets it apart from the climb's other ascents (Bédoin and Sault share the last 6 km of the Ventoux).

const zlib = require('zlib');
const https = require('https');
const ground = require('./ground');

const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const DEM_Z = 12;
const STEP_M = 50;          // ascents are compared every 50 m
const NEAR_M = 60;          // a ride is on the ascent's road within this
const LAST_M = 2000;        // the last stretch a ride must follow to the summit (or half the ascent, when shorter)
const MIN_GAIN = 40, MIN_LEN = 400;  // short Flemish and Dutch hills count too

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Cairn (personal travel map)' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${res.statusCode} ${url}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject).setTimeout(30000, function () { this.destroy(new Error('timeout')); });
  });
}

// --- heights: terrarium PNG tiles (8-bit RGB), height = R * 256 + G + B / 256 - 32768 ---

function decodePNG(buf) {
  let pos = 8, width = 0, height = 0, channels = 3;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[data[9]] || 3;
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * channels, out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0, b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? out[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, channels, px: out };
}

const tiles = new Map();
async function heightAt(lat, lon) {
  const n = 2 ** DEM_Z, xf = (lon + 180) / 360 * n, r = lat * Math.PI / 180;
  const yf = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  const key = `${Math.floor(xf)}/${Math.floor(yf)}`;
  if (!tiles.has(key)) tiles.set(key, get(`${DEM}/${DEM_Z}/${key}.png`).then(decodePNG).catch(() => null));
  const t = await tiles.get(key);
  if (!t) return null;
  const x = Math.min(t.width - 1, Math.floor((xf % 1) * t.width)), y = Math.min(t.width - 1, Math.floor((yf % 1) * t.width)), i = (y * t.width + x) * t.channels;
  return t.px[i] * 256 + t.px[i + 1] + t.px[i + 2] / 256 - 32768;
}

// --- geometry ---

const metresBetween = (a, b) => ground.km(a, b) * 1000;
function resample(pts, step = STEP_M) {  // points every `step` metres along the line
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = metresBetween(pts[i - 1], pts[i]);
    let t = step - carry;
    while (t <= d) {
      const f = t / d;
      out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]);
      t += step;
    }
    carry = (carry + d) % step;
  }
  return out;
}

// --- the ascents of one climb ---

// { top: [lat, lon, height] of the road's high point (null: no road up), ascents: [{ from, length, gain, grade, path }] }
async function ascentsOf(climb, towns, wait = ms => new Promise(r => setTimeout(r, ms))) {
  let top = [climb.lat, climb.lon];
  if (climb.peak) {  // a mountain (not a pass): its highest point within 1.5 km, where a road to the top ends
    let h = await heightAt(top[0], top[1]) ?? -1e9;
    const k = Math.cos(top[0] * Math.PI / 180), c0 = [...top];
    for (let dy = -1500; dy <= 1500; dy += 30) for (let dx = -1500; dx <= 1500; dx += 30) {
      if (dx * dx + dy * dy > 1500 * 1500) continue;
      const p = [c0[0] + dy / 111320, c0[1] + dx / (111320 * k)], hp = await heightAt(p[0], p[1]);
      if (hp != null && hp > h) { h = hp; top = p; }
    }
  }
  // the biggest town in each eighth of the compass, 4 to 25 km away
  const best = {};
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const t of towns.get((Math.floor(climb.lat) + dy) + ',' + (Math.floor(climb.lon) + dx)) || []) {
      const d = ground.km(top, [t.lat, t.lon]);
      if (d < 4 || d > 25) continue;
      const sector = Math.floor(((Math.atan2(t.lon - climb.lon, t.lat - climb.lat) * 180 / Math.PI) + 360) % 360 / 45);
      if (!best[sector] || t.pop > best[sector].pop) best[sector] = t;
    }
  }
  const found = [];
  let highest = null;  // [lat, lon, height] of the highest road point at the top
  for (const town of Object.values(best)) {
    let d;
    try { d = JSON.parse(await get(`${OSRM}${top[1]},${top[0]};${town.lon},${town.lat}?overview=full&geometries=polyline6`)); } catch (_) { continue; }
    await wait(1100);  // the public OSRM server: about one request a second
    const route = d.routes?.[0];
    if (!route) continue;
    let pts = resample(ground.decode(route.geometry));
    if (metresBetween(pts[0], top) > (climb.peak ? 400 : 1500)) continue;  // no road up (Etna's crater, a peak)
    let hs = [];
    for (const p of pts) hs.push(await heightAt(p[0], p[1]));
    if (hs.some(h => h == null)) continue;
    // a mountain's position is often rounded (the Ventoux's by a kilometre): the road's high point in its first 3 km
    // is the top, and the way down starts there
    let peak = 0;
    for (let i = 1; i < Math.min(hs.length, 3000 / STEP_M); i++) if (hs[i] > hs[peak]) peak = i;
    pts = pts.slice(peak); hs = hs.slice(peak);
    if (!highest || hs[0] > highest[2]) highest = [pts[0][0], pts[0][1], Math.round(hs[0])];
    // down from the summit until the road flattens out (the next 3 km drop less than 1.5% on average; a short flat
    // stretch on the way, as near Chalet Reynard, does not end it) or climbs 60 m again
    const W = Math.round(3000 / STEP_M);
    let low = 0;
    for (let i = 1; i < hs.length; i++) {
      if (hs[i] < hs[low]) low = i;
      else if (hs[i] - hs[low] > 60) break;
      const j = Math.min(hs.length - 1, i + W);
      if (hs[i] - hs[j] < 0.015 * (j - i) * STEP_M) { if (hs[i] <= hs[low] + 5) low = i; break; }
    }
    // the climb proper starts where it gets going: up from the foot, the first point from which the next 2 km rise
    // 3.5% or more (the gentle approach through Caromb is not the Ventoux from Bédoin)
    const R = Math.max(4, Math.min(Math.round(2000 / STEP_M), Math.round(low * 0.4)));  // 2 km, less on a short climb
    while (low > R && hs[low - R] - hs[low] < 0.035 * R * STEP_M) low--;
    const gain = Math.round(hs[0] - hs[low]), len = low * STEP_M;
    if (gain < MIN_GAIN || len < MIN_LEN) continue;
    const foot = pts[low];
    if (found.some(a => metresBetween(a.foot, foot) < 2000)) continue;  // the same way up, reached from another town
    const near = [...(towns.get(Math.floor(foot[0]) + ',' + Math.floor(foot[1])) || [])].sort((a, b) => ground.km(foot, [a.lat, a.lon]) - ground.km(foot, [b.lat, b.lon]))[0];
    const from = near && ground.km(foot, [near.lat, near.lon]) < 15 ? near.name : town.name;
    const up = pts.slice(0, low + 1).reverse();  // foot to summit
    found.push({ from, foot, up, length: Math.round(len / 100) / 10, gain, grade: Math.round(gain / len * 1000) / 10,
      path: ground.encode(ground.simplify(up, 0.00005)) });
  }
  // a way up whose foot is partway up a longer one, along whose road it lies: only that one's top part (the road
  // went on another way at a junction), so it goes
  const along = (a, b) => a.up.filter(p => b.up.some(q => metresBetween(p, q) < 80)).length / a.up.length;
  const onRoad = (a, b) => b.up.some(q => metresBetween(a.foot, q) < 80);
  // and a way up that lies along a longer one for 80% of its length: the same road from a nearby start (two "from
  // Séez" a little apart), so it goes too
  const kept = found.sort((a, b) => b.length - a.length).filter((a, i, all) => !all.slice(0, i).some(b => (onRoad(a, b) && along(a, b) > 0.9) || along(a, b) > 0.8));
  // two ways up from the same town: told apart by the side of the climb they come up
  const side = f => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][
    Math.round(((Math.atan2(f[1] - top[1], f[0] - top[0]) * 180 / Math.PI + 360) % 360) / 45) % 8];
  const twice = new Set(kept.map(a => a.from).filter((f, i, all) => all.indexOf(f) !== i));
  kept.forEach(a => { if (twice.has(a.from)) a.from += ` (${side(a.foot)})`; });
  return { top: highest, ascents: kept.map(({ foot, up, ...a }) => a) };
}

// --- which ascents a ride took ---

// distance in metres from p to the nearest point of the ride, and that point's position along the ride
function onRide(p, ride) {
  let best = Infinity, at = -1;
  for (let j = 1; j < ride.length; j++) {
    const a = ride[j - 1], b = ride[j];
    if ((a[0] - p[0] > 0.01 && b[0] - p[0] > 0.01) || (p[0] - a[0] > 0.01 && p[0] - b[0] > 0.01)) continue;
    const k = Math.cos(p[0] * Math.PI / 180), m = 111320;
    const ax = (a[1] - p[1]) * k * m, ay = (a[0] - p[0]) * m, bx = (b[1] - p[1]) * k * m, by = (b[0] - p[0]) * m;
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) { best = d; at = j - 1 + t; }
  }
  return { d: best, at };
}

// For each of a climb's ascents (decoded and resampled once: `samples`), whether the ride took it
function ridden(ascents, ride) {
  return ascents.map((a, i) => {
    const s = a.samples, n = s.length;
    const last = s.slice(Math.max(0, n - Math.min(Math.round(LAST_M / STEP_M), Math.ceil(n / 2))));
    // where it differs from the climb's other ways up
    const own = s.filter(p => ascents.every((o, j) => j === i || o.samples.every(q => metresBetween(p, q) > 150)));
    const check = pts => {
      const hits = pts.map(p => onRide(p, ride));
      const on = hits.filter(h => h.d <= NEAR_M);
      return { share: pts.length ? on.length / pts.length : 1, first: on[0]?.at, last: on[on.length - 1]?.at };
    };
    const end = check(last);
    if (end.share < 0.85) return false;
    if (!(end.last > end.first)) return false;  // went down it, not up
    if (own.length) {  // the part only this way up has: ridden too, uphill, on the way to that last stretch
      const mine = check(own.slice(-Math.round(3000 / STEP_M)));
      if (mine.share < 0.7 || !(mine.last > mine.first) || mine.last > end.last) return false;
    }
    return true;
  });
}

module.exports = { ascentsOf, ridden, resample, decodePNG, heightAt, onRide, STEP_M };
