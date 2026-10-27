'use strict';
// Your times up the climbs. A ride's timed track (data/tracks/<id>.json.gz, written by imports/garmin.py: a point every
// 5 s with time, height, power and heart rate) gives when you passed a way up's foot and then its top; with your FTP
// and weight of that day (the ride's own FTP, Garmin's weigh-ins) come the power-to-weight and what your FTP would
// make of the climb. A model of riding up (the power to lift you and the bike, roll and push the air) gives the
// predicted times: yours at your FTP, and a top climber's.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ground = require('./ground');

const NEAR_M = 80;          // a track passes the foot or the top within this
const BIKE_KG = 8, G = 9.81, CRR = 0.005, CDA = 0.35, RHO = 1.05, DRIVETRAIN = 0.975;
const PRO = { label: 'a top climber (6 W/kg for an hour, 60 kg)', wkg: 6.0, kg: 60 };

// metres between two [lat, lon], on a plane (short distances)
const metres = (a, b) => Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180));

function tracks(folder) {
  const cache = new Map();
  return id => {
    if (!cache.has(id)) {
      let t = null;
      try {
        t = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(folder, `${id}.json.gz`))).toString());
        t.pts = ground.decode(t.path);
      } catch (_) { /* no track: a ride from before the tracks, or not from Garmin */ }
      cache.set(id, t);
    }
    return cache.get(id);
  };
}

// The times a track went up one way: [{ seconds, power, hr, startAt }] (a ride can go up twice)
function efforts(track, foot, top) {
  if (!track) return [];
  const pts = track.pts, out = [];
  let lastFoot = -1;
  for (let j = 0; j < pts.length; j++) {
    if (metres(pts[j], foot) < NEAR_M) lastFoot = j;
    if (lastFoot < 0 || metres(pts[j], top) >= NEAR_M) continue;
    // at the top after the foot: the nearest points to the foot (going back) and to the top (going on)
    let i = lastFoot, k = j;
    while (i > 0 && metres(pts[i - 1], foot) < metres(pts[i], foot)) i--;
    while (k + 1 < pts.length && metres(pts[k + 1], top) < metres(pts[k], top)) k++;
    const seconds = track.t[k] - track.t[i];
    if (seconds > 60 && seconds < 6 * 3600) {
      const avg = list => {
        const v = list.slice(i, k + 1).filter(x => x != null && x > 0);
        return v.length > (k - i + 1) * 0.8 ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
      };
      out.push({ seconds, power: avg(track.pw || []), hr: avg(track.hr || []), startAt: track.start + track.t[i], from: i, to: k });
    }
    lastFoot = -1;
    j = k;
  }
  return out;
}

// The climb a ride actually did to a top, from its own heights: from passing the top, back down the track as long as
// it keeps going down (a short rise of under 25 m on the way is part of it) and is not flat for long (the last 1.5 km
// before it dropped less than 1.5%): [{ from, to }] (track indexes), one per time the ride went up to that top
function waysUp(track, top) {
  if (!track || !track.alt || !track.pts) return [];
  const pts = track.pts, alt = track.alt, out = [];
  for (let k = 0; k < pts.length; k++) {
    if (metres(pts[k], top) >= NEAR_M || alt[k] == null) continue;
    while (k + 1 < pts.length && metres(pts[k + 1], top) < metres(pts[k], top)) k++;  // the nearest point to the top
    let i = k, low = k, along = 0;
    const back = [];  // [metres back from the top, height]
    while (i > 0 && alt[i - 1] != null) {
      along += metres(pts[i - 1], pts[i]);
      i--;
      back.push([along, alt[i]]);
      if (alt[i] < alt[low]) low = i;
      else if (alt[i] - alt[low] > 25) break;  // it climbed back: the foot was the low point
      const old = back.find(b => b[0] >= along - 1500);  // flat for 1.5 km: the climb started before
      if (along > 1500 && old && old[1] - alt[i] < 0.015 * (along - old[0])) break;
    }
    if (alt[k] - alt[low] >= 30 && track.t[k] - track.t[low] > 60) out.push({ from: low, to: k });
    while (k + 1 < pts.length && metres(pts[k + 1], top) < NEAR_M * 3) k++;  // past this passage
  }
  return out;
}

// One effort point by point, for the climb page's map and profile: { lat, lon, d (m from the foot), alt (m), t (s),
// speed (km/h), vam (m/h), grade (%), power (W), wkg, hr }, speed and VAM over the half minute around each point,
// gradient over the 100 m around it
function series(track, from, to, kg) {
  const pts = track.pts.slice(from, to + 1), t = track.t.slice(from, to + 1).map(x => x - track.t[from]);
  const alt = (track.alt || []).slice(from, to + 1), pw = (track.pw || []).slice(from, to + 1), hr = (track.hr || []).slice(from, to + 1);
  const d = [0];
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + metres(pts[i - 1], pts[i]));
  const around = (i, key, span) => {  // the points within span (s or m) either side of i
    let a = i, b = i;
    const v = key === 't' ? t : d;
    while (a > 0 && v[i] - v[a - 1] <= span) a--;
    while (b < pts.length - 1 && v[b + 1] - v[i] <= span) b++;
    return [a, b];
  };
  return pts.map((p, i) => {
    const [a, b] = around(i, 't', 15), [c, e] = around(i, 'd', 50);
    const dt = t[b] - t[a], dd = d[e] - d[c];
    const rise = alt[b] != null && alt[a] != null ? alt[b] - alt[a] : null;
    return { lat: p[0], lon: p[1], d: Math.round(d[i]), alt: alt[i], t: t[i],
      speed: dt ? Math.round((d[b] - d[a]) / dt * 36) / 10 : null,
      vam: dt && rise != null ? Math.round(rise / dt * 3600) : null,
      grade: dd && alt[e] != null && alt[c] != null ? Math.round((alt[e] - alt[c]) / dd * 1000) / 10 : null,
      power: pw[i] ?? null, wkg: pw[i] != null && kg ? Math.round(pw[i] / kg * 10) / 10 : null, hr: hr[i] ?? null };
  });
}

// The power you hold for a while, as a share of FTP (an hour): more for shorter, less for longer
const sustainable = seconds => Math.min(1.25, Math.max(0.8, (seconds / 3600) ** -0.07));

// Seconds to ride up length km and gain m at power W (for long enough, the power is what one holds that long)
function predict(lengthKm, gainM, ftpW, riderKg) {
  const m = riderKg + BIKE_KG, grade = gainM / (lengthKm * 1000), th = Math.atan(grade);
  const speedAt = p => {  // the speed where the power to climb, roll and push the air is p
    let lo = 0.1, hi = 30;
    for (let n = 0; n < 50; n++) {
      const v = (lo + hi) / 2;
      const need = (m * G * (Math.sin(th) + CRR * Math.cos(th)) * v + 0.5 * RHO * CDA * v ** 3) / DRIVETRAIN;
      if (need > p) hi = v; else lo = v;
    }
    return lo;
  };
  let seconds = 3600;
  for (let n = 0; n < 4; n++) seconds = lengthKm * 1000 / speedAt(ftpW * sustainable(seconds));
  return Math.round(seconds);
}

// The value on or before a day in [["YYYY-MM-DD", value], ...] (oldest first), else the first after it
function onDay(list, day) {
  let found = null;
  for (const [d, v] of list || []) {
    if (d <= day) found = v; else return found ?? v;
  }
  return found;
}

// The time, power and heart rate of a stretch of a track (indexes from..to)
function effortOf(track, from, to) {
  const avg = list => {
    const v = (list || []).slice(from, to + 1).filter(x => x != null && x > 0);
    return v.length > (to - from + 1) * 0.8 ? Math.round(v.reduce((a, x) => a + x, 0) / v.length) : null;
  };
  let km = 0;
  for (let i = from + 1; i <= to; i++) km += metres(track.pts[i - 1], track.pts[i]) / 1000;
  return { seconds: track.t[to] - track.t[from], power: avg(track.pw), hr: avg(track.hr), startAt: track.start + track.t[from], from, to,
    length: Math.round(km * 10) / 10, gain: track.alt[to] != null && track.alt[from] != null ? Math.round(track.alt[to] - track.alt[from]) : null };
}

module.exports = { tracks, efforts, waysUp, effortOf, series, predict, onDay, sustainable, PRO, metres };
