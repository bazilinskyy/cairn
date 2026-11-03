'use strict';
// A trip's replay (🎬 on a trip's page): the trip drawn on a map as it happened, day by day, with the camera following
// along, the photos coming up where they were taken, and a title at the start and the numbers at the end; to watch,
// or to save as a video (the browser's own recorder: MP4 where it can, else WebM). Drawn on a canvas, with its own map
// tiles (OpenStreetMap or Esri, which allow it), so that the recorder can take it. Uses the page's globals (tripShown,
// allTrips, allActivities, allAirports, greatCircle, decodePath, flagOf, ...).

const REPLAY_STYLES = {
  dark: { label: 'Dark', url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, size: 256, max: 18,
    filter: 'grayscale(1) invert(1) contrast(0.82) brightness(0.62)', bg: '#16181d', credit: '© OpenStreetMap contributors' },
  satellite: { label: 'Satellite', url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, size: 256, max: 17,
    filter: 'brightness(0.62) saturate(0.9) contrast(1.05)', bg: '#06080c', credit: 'Imagery © Esri, Maxar, Earthstar Geographics' },
  light: { label: 'Light', url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, size: 256, max: 18,
    filter: 'saturate(0.55) contrast(0.92) brightness(1.04)', bg: '#eef0f2', credit: '© OpenStreetMap contributors', light: true }
};
const REPLAY_FORMATS = { wide: [1920, 1080, 'Landscape 16:9'], tall: [1080, 1920, 'Portrait 9:16'], square: [1440, 1440, 'Square'] };
// the colours and icons of the modes are the map's (TRAVEL_MODES, and the CSS variables of the map's tone: dark on the dark
// and satellite maps, light on the light one), set when the replay is made
let REPLAY_COLORS = {}, REPLAY_ICONS = {};
function replayColors(style) {
  REPLAY_ICONS = { ...Object.fromEntries(Object.entries(TRAVEL_MODES).map(([k, [icon]]) => [k, icon])), road: '🚗', move: '🚶' };
  const probe = Object.assign(document.createElement('div'), { hidden: true });
  probe.dataset.theme = style === 'light' ? 'light' : style === 'satellite' ? 'sat' : 'dark';
  document.body.append(probe);
  const css = getComputedStyle(probe), out = Object.fromEntries(Object.entries(TRAVEL_MODES).map(([k, [, v]]) => [k, css.getPropertyValue(v).trim()]));
  probe.remove();
  return { ...out, road: out.car, move: style === 'light' ? '#6b7a90' : '#aab4c3' };
}
const REPLAY_MAX_S = 110, REPLAY_INTRO = 3.2, REPLAY_OUTRO = 5, REPLAY_PHOTOS_A_DAY = 4, REPLAY_TILES_MAX = 1500;

// --- the map: Web Mercator, the world 0..1 across; a view is { x, y, z } (its centre and zoom) ---
const mercX = lon => (lon + 180) / 360;
const mercY = lat => { const s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const replayEase = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = t => Math.max(0, Math.min(1, t));
const kmBetween = (a, b) => {
  const r = Math.PI / 180, x = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};

// the view that shows these points (world coordinates) in a w × h frame, with a margin
function fitView(pts, w, h, margin = 0.22, maxZ = 15, minZ = 1.5) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  pts.forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
  const dx = Math.max(x1 - x0, 1e-7), dy = Math.max(y1 - y0, 1e-7);
  const z = Math.log2(Math.min(w * (1 - 2 * margin) / dx, h * (1 - 2 * margin) / dy) / 256);
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: Math.max(minZ, Math.min(maxZ, z)) };
}

// --- what happened, in order: the trip's lines, photos and nights as a timeline of shots ---
function replayStory(d, w, h) {
  const at = s => (s || '').replace(' ', 'T').slice(0, 16);
  const localUnix = (s, lon) => { const m = at(s); return m ? Date.parse(m.length === 10 ? m + 'T12:00:00Z' : m + ':00Z') / 1000 - Math.round((lon || 0) / 15) * 3600 : null; };
  const lineKm = pts => pts.reduce((n, p, i) => (i ? n + kmBetween(pts[i - 1], p) : 0), 0);
  const items = [];
  d.flights.forEach(f => {
    const a = allAirports[f.from], b = allAirports[f.to];
    if (!a || !b) return;
    const pts = greatCircle(a.lat, a.lon, b.lat, b.lon, 90), t0 = localUnix(f.date, a.lon), km = f.distance || lineKm(pts);
    items.push({ kind: 'flight', t0, t1: t0 + (km / 780 + 0.5) * 3600, pts, km, label: `${f.from_city || f.from} → ${f.to_city || f.to}` });
  });
  const gids = new Set(d.ground.map(g => String(g.id)));
  allTrips.filter(g => gids.has(String(g.id)) && g.from_lat != null && g.to_lat != null).forEach(g => {
    const pts = g.path ? decodePath(g.path) : [[+g.from_lat, +g.from_lon], [+g.to_lat, +g.to_lon]], t0 = localUnix(g.date, +g.from_lon);
    const t1 = g.arrival ? localUnix(g.arrival, +g.to_lon) : t0 + lineKm(pts) / 60 * 3600;
    items.push({ kind: ['train', 'bus', 'ferry', 'hitch', 'drive'].includes(g.mode) ? g.mode : 'bus', t0, t1: Math.max(t1, t0 + 600), pts, km: lineKm(pts), label: `${g.from} → ${g.to}` });
  });
  d.moves.forEach(m => {
    const pts = m.path ? decodePath(m.path) : [m.from, m.to];
    items.push({ kind: m.kind === 'drive' ? (m.by === 'scooter' ? 'scooter' : 'car') : m.path ? 'road' : 'move', by: m.by, t0: m.t0, t1: Math.max(m.t1, m.t0 + 60), pts, km: m.km || lineKm(pts),
      label: m.kind === 'drive' ? (m.by === 'scooter' ? 'By scooter' : 'Driving') : m.path ? 'By road' : '' });
  });
  const aids = new Set(d.activities.map(a => a.id)), names = new Map(d.activities.map(a => [a.id, a]));
  allActivities.filter(a => aids.has(a.id) && a.path).forEach(a => {
    const k = sportOf(a.sport), pts = decodePath(a.path);
    if (pts.length < 2) return;
    items.push({ kind: k === 'ride' || k === 'run' || k === 'walk' ? k : 'sport', t0: a.start, t1: a.start + (a.elapsed_time || a.moving_time || 3600), pts,
      km: a.distance || lineKm(pts), label: names.get(a.id)?.name || a.name || a.sport });
  });
  const lines = items.filter(x => x.t0 != null && x.pts.length).sort((a, b) => a.t0 - b.t0);
  // photos: a few a day, spread over it
  const byDay = {};
  (d.photos || []).forEach(p => { if (p[2] == null) return; const day = new Date((p[1] + Math.round(p[3] / 15) * 3600) * 1000).toISOString().slice(0, 10); (byDay[day] = byDay[day] || []).push(p); });
  const photos = Object.values(byDay).flatMap(list => {
    list.sort((a, b) => a[1] - b[1]);
    if (list.length <= REPLAY_PHOTOS_A_DAY) return list;
    return Array.from({ length: REPLAY_PHOTOS_A_DAY }, (_, i) => list[Math.round((i + 0.5) * list.length / REPLAY_PHOTOS_A_DAY - 0.5)]);
  }).filter(p => !p[4]).map(p => ({ kind: 'photo', t0: p[1], id: p[0], at: [p[2], p[3]] }));
  const nights = d.stays.filter(s => s.what !== 'car' && s.lat != null).map(s => ({ kind: 'stay', t0: localUnix(s.start + ' 20:00', +s.lon), at: [+s.lat, +s.lon], label: s.place || '' }));
  const events = [...lines, ...photos, ...nights].sort((a, b) => a.t0 - b.t0);

  // each its share of the screen time: lines by how far they went, a photo a moment, a night a breath
  const lengthOf = e => (e.kind === 'photo' ? 1.5 : e.kind === 'stay' ? 0.7 : e.kind === 'flight' ? 3.4 : Math.max(0.9, Math.min(4.2, 0.8 + 0.85 * Math.log10(1 + e.km))));
  let total = events.reduce((n, e) => n + lengthOf(e), 0);
  const days = d.dayList.map(x => x.day), dayCards = new Set();
  const scale = total + REPLAY_INTRO + REPLAY_OUTRO + days.length * 0.6 > REPLAY_MAX_S ? (REPLAY_MAX_S - REPLAY_INTRO - REPLAY_OUTRO - days.length * 0.6) / total : 1;
  let clock = REPLAY_INTRO;
  const shots = [];
  const world = p => [mercX(p[1]), mercY(p[0])];
  events.forEach(e => {
    const day = new Date((e.t0 + Math.round(((e.pts ? e.pts[0][1] : e.at[1]) || 0) / 15) * 3600) * 1000).toISOString().slice(0, 10);
    if (!dayCards.has(day) && day >= d.start && day <= d.end) { dayCards.add(day); shots.push({ kind: 'day', day, s0: clock, s1: clock + 0.6 }); clock += 0.6; }
    const len = Math.max(e.kind === 'photo' ? 1.1 : 0.45, lengthOf(e) * scale);
    const shot = { ...e, day, s0: clock, s1: clock + len };
    if (e.pts) {
      shot.w = e.pts.map(world);
      shot.cum = [0];
      for (let i = 1; i < shot.w.length; i++) shot.cum.push(shot.cum[i - 1] + Math.hypot(shot.w[i][0] - shot.w[i - 1][0], shot.w[i][1] - shot.w[i - 1][1]));
      const big = e.kind === 'flight' || e.km > 150;
      shot.view = fitView(shot.w, w, h, big ? 0.16 : 0.26, e.kind === 'move' ? 14 : 15);
    } else shot.w = [world(e.at)];
    shots.push(shot);
    clock += len;
  });
  const all = shots.flatMap(s => s.w || []);
  const overview = all.length ? fitView(all, w, h, 0.12, 13) : { x: 0.5, y: 0.5, z: 2 };
  // each shot's view: a line's own; a photo or a night where it is, as close as the line before
  let last = overview;
  shots.forEach(s => {
    if (s.kind === 'day') return;
    if (!s.view) s.view = { x: s.w[0][0], y: s.w[0][1], z: Math.max(Math.min(last.z, 14), 10) };
    last = s.view;
  });
  const end = clock;
  return { shots, overview, end, duration: end + REPLAY_OUTRO, days };
}

// the camera at a moment: from shot to shot, flying out and back in when the way is long (van Wijk and Nuij's
// smooth zoom, simply)
function cameraAt(story, t) {
  const views = story.shots.filter(s => s.view);
  if (t <= REPLAY_INTRO * 0.55 || !views.length) return story.overview;
  let prev = story.overview, i = 0;
  while (i < views.length && views[i].s0 <= t) { prev = i ? views[i - 1].view : story.overview; i++; }
  if (t >= story.end) return glide(views[views.length - 1].view, story.overview, replayEase(clamp01((t - story.end) / 2.2)));
  if (i === 0) return glide(story.overview, views[0].view, replayEase(clamp01((t - REPLAY_INTRO * 0.55) / (REPLAY_INTRO * 0.45))));
  const s = views[i - 1], took = Math.min(1.6, (s.s1 - s.s0) * 0.55);
  return glide(prev, s.view, replayEase(clamp01((t - s.s0) / took)));
}
function glide(a, b, f) {
  const far = Math.hypot(b.x - a.x, b.y - a.y) * 256 * 2 ** Math.min(a.z, b.z) / 1200;  // how many frames away
  const out = far > 1 ? Math.min(Math.log2(far) + 0.6, Math.min(a.z, b.z) - 1.2) : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f - Math.max(0, out) * Math.sin(Math.PI * f) };
}

// --- tiles: loaded once, a coarser one standing in while a finer one loads ---
const replayTiles = new Map();
function replayTile(style, z, x, y) {
  const n = 2 ** z, k = `${style}/${z}/${((x % n) + n) % n}/${y}`;
  let t = replayTiles.get(k);
  if (!t) {
    t = { img: new Image(), ok: false };
    t.img.crossOrigin = 'anonymous';
    t.done = new Promise(res => { t.img.onload = () => { t.ok = true; res(); }; t.img.onerror = () => res(); });
    t.img.src = REPLAY_STYLES[style].url(z, ((x % n) + n) % n, y);
    replayTiles.set(k, t);
  }
  return t;
}
function tilesFor(style, v, w, h) {
  const st = REPLAY_STYLES[style], tz = Math.max(1, Math.min(st.max, Math.round(v.z + Math.log2(256 / st.size) + 0.35)));
  const n = 2 ** tz, scale = 256 * 2 ** v.z, half = [w / 2 / scale, h / 2 / scale];
  const out = [];
  for (let ty = Math.max(0, Math.floor((v.y - half[1]) * n)); ty <= Math.min(n - 1, Math.floor((v.y + half[1]) * n)); ty++) {
    for (let tx = Math.floor((v.x - half[0]) * n); tx <= Math.floor((v.x + half[0]) * n); tx++) out.push([tz, tx, ty]);
  }
  return out;
}
function replayDrawTiles(ctx, style, v, w, h) {
  const st = REPLAY_STYLES[style], scale = 256 * 2 ** v.z;
  ctx.fillStyle = st.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.filter = st.filter;
  tilesFor(style, v, w, h).forEach(([z, x, y]) => {
    // the tile, or the nearest coarser one loaded, cut to its part
    for (let up = 0; up <= 6 && z - up >= 0; up++) {
      const pz = z - up, px = Math.floor(x / 2 ** up), py = Math.floor(y / 2 ** up), t = replayTile(style, pz, px, py);
      if (!t.ok) continue;
      const part = st.size / 2 ** up, sx = (x - px * 2 ** up) * part, sy = (y - py * 2 ** up) * part, size = scale / 2 ** z;
      ctx.drawImage(t.img, sx, sy, part, part, Math.floor((x / 2 ** z - v.x) * scale + w / 2), Math.floor((y / 2 ** z - v.y) * scale + h / 2), Math.ceil(size) + 1, Math.ceil(size) + 1);
      break;
    }
  });
  ctx.restore();
}

// --- one frame ---
function drawReplay(ctx, story, t, o) {
  const { w, h, style } = o, st = REPLAY_STYLES[style], k = Math.min(w, h) / 1080;
  const v = cameraAt(story, t), scale = 256 * 2 ** v.z;
  const px = p => [(p[0] - v.x) * scale + w / 2, (p[1] - v.y) * scale + h / 2];
  replayDrawTiles(ctx, style, v, w, h);
  // a soft vignette, and the trip's whole way faintly, as a promise
  const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.62);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, st.light ? 'rgba(20,30,40,0.28)' : 'rgba(0,0,0,0.6)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
  const path = pts => {
    ctx.beginPath();
    let prev = null;
    for (let i = 0; i < pts.length; i++) {
      const p = px(pts[i]);
      if (!prev || Math.abs(p[0] - prev[0]) > w * 2) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      prev = p;
    }
  };
  const lines = story.shots.filter(s => s.cum);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  lines.forEach(s => {
    if (s.s0 <= t) return;
    path(s.w); ctx.strokeStyle = st.light ? 'rgba(30,40,60,0.22)' : 'rgba(255,255,255,0.22)'; ctx.lineWidth = 2.4 * k; ctx.setLineDash(s.kind === 'flight' ? [6 * k, 8 * k] : []); ctx.stroke();
  });
  ctx.setLineDash([]);
  // the way gone, glowing; the line being drawn up to where you are
  let head = null, now = null;
  lines.forEach(s => {
    if (s.s0 > t) return;
    const f = replayEase(clamp01((t - s.s0) / (s.s1 - s.s0))), color = REPLAY_COLORS[s.kind] || '#fff';
    let pts = s.w;
    if (f < 1) {
      const want = f * s.cum[s.cum.length - 1];
      let i = 1;
      while (i < s.cum.length - 1 && s.cum[i] < want) i++;
      const a = s.w[i - 1], b = s.w[i], g = (want - s.cum[i - 1]) / Math.max(1e-12, s.cum[i] - s.cum[i - 1]);
      const p = [a[0] + (b[0] - a[0]) * g, a[1] + (b[1] - a[1]) * g];
      pts = [...s.w.slice(0, i), p];
      head = p; now = s;
    }
    const fresh = f < 1 || t - s.s1 < 0.8;
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = (fresh ? 22 : 10) * k;
    ctx.strokeStyle = color; ctx.globalAlpha = fresh ? 1 : 0.78;
    ctx.lineWidth = (s.kind === 'move' ? 2.2 : s.kind === 'flight' ? 3.4 : 4.6) * k * (fresh ? 1.25 : 1);
    ctx.setLineDash(s.kind === 'move' ? [2 * k, 7 * k] : s.kind === 'flight' ? [10 * k, 9 * k] : []);
    path(pts); ctx.stroke();
    ctx.restore();
  });
  // the nights: a small moon where you slept
  story.shots.filter(s => s.kind === 'stay' && s.s0 <= t).forEach(s => {
    const p = px(s.w[0]), a = clamp01((t - s.s0) / 0.5);
    ctx.save(); ctx.globalAlpha = a;
    ctx.fillStyle = st.light ? 'rgba(255,255,255,0.9)' : 'rgba(10,14,24,0.85)';
    ctx.beginPath(); ctx.arc(p[0], p[1], 15 * k * (0.6 + 0.4 * a), 0, 7); ctx.fill();
    ctx.font = `${17 * k}px system-ui, "Apple Color Emoji", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🌙', p[0], p[1] + 1); ctx.restore();
  });
  // where you are: a bright dot with a ring that breathes, and how you are moving
  const current = story.shots.filter(s => s.s0 <= t && s.kind !== 'day').pop();
  if (!head && current) head = current.cum ? current.w[current.w.length - 1] : current.w[0];
  if (head && t > REPLAY_INTRO * 0.6 && t < story.end + 1.2) {
    const p = px(head), color = REPLAY_COLORS[now?.kind] || '#ffffff', pulse = (t * 1.6) % 1;
    ctx.save();
    ctx.strokeStyle = color; ctx.globalAlpha = 1 - pulse; ctx.lineWidth = 3 * k;
    ctx.beginPath(); ctx.arc(p[0], p[1], (12 + 26 * pulse) * k, 0, 7); ctx.stroke();
    ctx.globalAlpha = 1; ctx.shadowColor = color; ctx.shadowBlur = 24 * k; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(p[0], p[1], 9 * k, 0, 7); ctx.fill();
    ctx.shadowBlur = 0; ctx.lineWidth = 4 * k; ctx.strokeStyle = color; ctx.stroke();
    if (now) {
      const icon = REPLAY_ICONS[now.kind];
      ctx.font = `${34 * k}px system-ui, "Apple Color Emoji", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(icon || '', p[0], p[1] - 16 * k);
    }
    ctx.restore();
  }
  // the photo of the moment, as a print laid on the map
  const photo = story.shots.filter(s => s.kind === 'photo' && s.s0 <= t && t < s.s1 + 0.4).pop();
  if (photo) {
    const img = o.photos.get(photo.id);
    if (img && img.complete && img.naturalWidth) {
      const life = (t - photo.s0) / (photo.s1 + 0.4 - photo.s0), a = Math.min(clamp01(life * 6), clamp01((1 - life) * 6));
      const side = Math.min(w, h) * 0.36, r = img.naturalWidth / img.naturalHeight, iw = r >= 1 ? side : side * r, ih = r >= 1 ? side / r : side;
      const pad = 14 * k, cx = w - iw / 2 - pad - 56 * k, cy = h - ih / 2 - pad - 150 * k + (1 - a) * 40 * k;
      const p = px(photo.w[0]);
      ctx.save(); ctx.globalAlpha = a;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2 * k; ctx.setLineDash([3 * k, 5 * k]);
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(cx, cy); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p[0], p[1], 6 * k, 0, 7); ctx.fill();
      ctx.translate(cx, cy); ctx.rotate((photo.id % 7 - 3) * 0.006);
      ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 30 * k; ctx.shadowOffsetY = 10 * k;
      ctx.fillStyle = '#fbfaf7'; roundRect(ctx, -iw / 2 - pad, -ih / 2 - pad, iw + 2 * pad, ih + 2 * pad + 30 * k, 6 * k); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
      ctx.fillStyle = '#555'; ctx.font = `500 ${17 * k}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(new Date((photo.t0 + Math.round(photo.at[1] / 15) * 3600) * 1000).toISOString().slice(11, 16), 0, ih / 2 + pad + 14 * k);
      ctx.restore();
    }
  }
  drawHud(ctx, story, t, o, k, current);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// the words on the film: the title at the start, the day and the towns as it goes, the km so far, the numbers at the end
function drawHud(ctx, story, t, o, k, current) {
  const { w, h, trip, style } = o, light = REPLAY_STYLES[style].light, ink = light ? '#15181f' : '#ffffff', soft = light ? 'rgba(21,24,31,0.65)' : 'rgba(255,255,255,0.72)';
  const font = (wt, px) => `${wt} ${px * k}px -apple-system, "SF Pro Display", system-ui, "Segoe UI", sans-serif`;
  const flags = trip.countries.map(c => flagOf(c.cc).trim()).join(' ');
  const fmt = (d, opt) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', opt);
  const shade = (y0, y1, top) => {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    const c = light ? '238,240,242' : '0,0,0';
    g.addColorStop(top ? 0 : 1, `rgba(${c},${light ? 0.85 : 0.7})`); g.addColorStop(top ? 1 : 0, `rgba(${c},0)`);
    ctx.fillStyle = g; ctx.fillRect(0, y0, w, y1 - y0);
  };
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  if (t < REPLAY_INTRO + 0.4) {  // the title
    const a = Math.min(clamp01(t / 0.7), clamp01((REPLAY_INTRO + 0.4 - t) / 0.8));
    ctx.globalAlpha = a;
    shade(h * 0.42, h, false);
    ctx.fillStyle = ink; ctx.textAlign = 'center';
    ctx.font = font(400, 54); ctx.fillText(flags, w / 2, h * 0.66);
    ctx.font = font(800, Math.min(92, 1700 / Math.max(10, trip.name.length))); ctx.fillText(trip.name, w / 2, h * 0.66 + 100 * k);
    ctx.font = font(500, 32); ctx.fillStyle = soft;
    ctx.fillText(`${fmt(trip.start, { day: 'numeric', month: 'long' })} – ${fmt(trip.end, { day: 'numeric', month: 'long', year: 'numeric' })} · ${trip.days} days`, w / 2, h * 0.66 + 156 * k);
    ctx.restore();
    return;
  }
  if (t > story.end + 0.6) {  // the numbers
    const a = clamp01((t - story.end - 0.6) / 0.9);
    ctx.globalAlpha = a;
    shade(h * 0.38, h, false);
    const km = story.shots.filter(s => s.cum).reduce((n, s) => n + (s.km || 0), 0);
    const items = [[trip.days, 'days'], [trip.countries.length, trip.countries.length === 1 ? 'country' : 'countries'], [trip.towns.length + (trip.towns.length >= 6 ? '+' : ''), 'towns'],
      [Math.round(dist(km)).toLocaleString(), DU()], [(trip.photo_ids || []).length.toLocaleString(), 'photos']].filter(([n]) => n && n !== '0');
    ctx.textAlign = 'center'; ctx.fillStyle = ink;
    ctx.font = font(800, 60); ctx.fillText(`${flags}  ${trip.name}`, w / 2, h * 0.6, w * 0.9);
    const col = Math.min(w * 0.9 / items.length, 300 * k);
    items.forEach(([n, l], i) => {
      const x = w / 2 + (i - (items.length - 1) / 2) * col;
      ctx.fillStyle = ink; ctx.font = font(800, 64); ctx.fillText(String(n), x, h * 0.6 + 120 * k);
      ctx.fillStyle = soft; ctx.font = font(500, 26); ctx.fillText(l, x, h * 0.6 + 160 * k);
    });
    ctx.restore();
    return;
  }
  // as it goes: the trip at the top, the day below
  shade(0, 190 * k, true); shade(h - 260 * k, h, false);
  const day = (current?.day && current.day >= trip.start && current.day <= trip.end) ? current.day : story.shots.filter(s => s.kind === 'day' && s.s0 <= t).pop()?.day || trip.start;
  const n = Math.round((Date.parse(day) - Date.parse(trip.start)) / 864e5) + 1;
  const x0 = 64 * k;
  ctx.textAlign = 'left'; ctx.fillStyle = ink;
  ctx.font = font(700, 36); ctx.fillText(`${flags}  ${trip.name}`, x0, 86 * k, w - 2 * x0);
  ctx.fillStyle = soft; ctx.font = font(500, 22);
  ctx.fillText(`${fmt(trip.start, { day: 'numeric', month: 'short' })} – ${fmt(trip.end, { day: 'numeric', month: 'short', year: 'numeric' })}`, x0, 122 * k);
  // the day, as a card that comes in when it starts
  const card = story.shots.filter(s => s.kind === 'day' && s.s0 <= t).pop(), pop = card ? replayEase(clamp01((t - card.s0) / 0.45)) : 1;
  const towns = (tripShown.dayList.find(x => x.day === day)?.towns || []).slice(0, 2).map(c => c.name).join(' · ');
  ctx.save(); ctx.globalAlpha = pop; ctx.translate(0, (1 - pop) * 24 * k);
  ctx.fillStyle = REPLAY_COLORS[current?.kind] || (light ? '#2a6df4' : '#5ec8ff');
  ctx.font = font(800, 26); ctx.fillText(`DAY ${n}`, x0, h - 150 * k);
  ctx.fillStyle = ink; ctx.font = font(700, 50); ctx.fillText(towns || fmt(day, { weekday: 'long' }), x0, h - 96 * k, w * 0.62);
  ctx.fillStyle = soft; ctx.font = font(500, 26); ctx.fillText(`${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}${current?.label ? `  ·  ${current.label}` : ''}`, x0, h - 56 * k, w * 0.7);
  ctx.restore();
  // the distance so far, top right
  const km = story.shots.filter(s => s.cum && s.s0 <= t).reduce((m, s) => m + (s.km || 0) * clamp01((t - s.s0) / (s.s1 - s.s0)), 0);
  ctx.textAlign = 'right'; ctx.fillStyle = ink; ctx.font = font(700, 40);
  ctx.fillText(`${Math.round(dist(km)).toLocaleString()} ${DU()}`, w - x0, 86 * k);
  ctx.fillStyle = soft; ctx.font = font(500, 20); ctx.fillText('travelled', w - x0, 116 * k);
  // the progress, with a tick a day
  const y = h - 22 * k, x1 = w - x0, f = clamp01((t - REPLAY_INTRO) / (story.end - REPLAY_INTRO));
  ctx.fillStyle = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.18)'; ctx.fillRect(x0, y, x1 - x0, 4 * k);
  ctx.fillStyle = ink; ctx.fillRect(x0, y, (x1 - x0) * f, 4 * k);
  ctx.textAlign = 'right'; ctx.fillStyle = soft; ctx.font = font(400, 14);
  ctx.fillText(REPLAY_STYLES[style].credit, x1, y - 10 * k);
  ctx.restore();
}

// --- the player: an overlay with the canvas and its controls ---
let replay = null;
async function openReplay() {
  const trip = tripShown;
  if (!trip) return;
  let box = document.getElementById('replay');
  if (!box) {
    box = document.createElement('div');
    box.id = 'replay'; box.className = 'replay';
    box.innerHTML = '<div class="replay-stage"><canvas></canvas><div class="replay-wait" hidden></div></div><div class="replay-bar">' +
      '<button class="btn btn-primary" data-play>▶ Play</button>' +
      `<select data-style aria-label="Map">${Object.entries(REPLAY_STYLES).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join('')}</select>` +
      `<select data-format aria-label="Format">${Object.entries(REPLAY_FORMATS).map(([k, f]) => `<option value="${k}">${f[2]}</option>`).join('')}</select>` +
      '<input type="range" data-seek min="0" max="1000" value="0" aria-label="Time">' +
      '<button class="btn btn-ghost" data-save title="Plays it once from the start and saves it as a video">⬇️ Save video</button>' +
      '<button class="btn btn-ghost" data-close aria-label="Close">✕</button></div>';
    document.body.appendChild(box);
    box.querySelector('[data-close]').addEventListener('click', closeReplay);
    box.querySelector('[data-play]').addEventListener('click', () => (replay?.playing ? pauseReplay() : playReplay()));
    box.querySelector('[data-save]').addEventListener('click', saveReplay);
    box.querySelector('[data-seek]').addEventListener('input', e => { if (!replay || replay.recording) return; pauseReplay(); replay.t = e.target.value / 1000 * replay.story.duration; frame(); });
    ['style', 'format'].forEach(k => box.querySelector(`[data-${k}]`).addEventListener('change', () => { if (!replay?.recording) setupReplay(); }));
    document.addEventListener('keydown', e => {
      if (!replay || box.hidden) return;
      if (e.key === 'Escape') closeReplay();
      if (e.key === ' ' && e.target.tagName !== 'SELECT') { e.preventDefault(); replay.playing ? pauseReplay() : playReplay(); }
    });
  }
  box.hidden = false;
  document.body.style.overflow = 'hidden';
  try { box.querySelector('[data-style]').value = localStorage.getItem('cairn-replay-style') || 'dark'; box.querySelector('[data-format]').value = localStorage.getItem('cairn-replay-format') || 'wide'; } catch (_) {}
  setupReplay();
  playReplay();
}

function setupReplay() {
  const box = document.getElementById('replay'), style = box.querySelector('[data-style]').value, format = box.querySelector('[data-format]').value;
  try { localStorage.setItem('cairn-replay-style', style); localStorage.setItem('cairn-replay-format', format); } catch (_) {}
  const [w, h] = REPLAY_FORMATS[format], canvas = box.querySelector('canvas');
  REPLAY_COLORS = replayColors(style);
  canvas.width = w; canvas.height = h;
  const story = replayStory(tripShown, w, h);
  const photos = new Map();
  story.shots.filter(s => s.kind === 'photo').forEach(s => { const img = new Image(); img.src = `/api/photos/${s.id}/full`; photos.set(s.id, img); });
  const was = replay;
  replay = { story, photos, style, w, h, trip: tripShown, ctx: canvas.getContext('2d'), t: was ? Math.min(was.t, story.duration) : 0, playing: false };
  if (was?.playing) playReplay(); else frame();
}

function frame() {
  if (!replay) return;
  drawReplay(replay.ctx, replay.story, replay.t, replay);
  const seek = document.querySelector('#replay [data-seek]');
  if (seek && !replay.recording) seek.value = Math.round(replay.t / replay.story.duration * 1000);
}
function playReplay() {
  if (!replay) return;
  if (replay.t >= replay.story.duration) replay.t = 0;
  replay.playing = true;
  document.querySelector('#replay [data-play]').textContent = '⏸ Pause';
  let last = performance.now();
  const step = now => {
    if (!replay?.playing) return;
    replay.t = Math.min(replay.story.duration, replay.t + (now - last) / 1000);
    last = now;
    frame();
    if (replay.t >= replay.story.duration) { pauseReplay(); replay.onEnd?.(); return; }
    replay.raf = requestAnimationFrame(step);
  };
  replay.raf = requestAnimationFrame(step);
}
function pauseReplay() {
  if (!replay) return;
  replay.playing = false;
  cancelAnimationFrame(replay.raf);
  const b = document.querySelector('#replay [data-play]');
  if (b) b.textContent = '▶ Play';
}
function closeReplay() {
  if (replay?.recording) replay.recorder?.stop();
  pauseReplay();
  replay = null;
  const box = document.getElementById('replay');
  if (box) box.hidden = true;
  document.body.style.overflow = '';
}

// every tile the camera will need, loaded before recording (a missing one would show as a blur in the film)
async function preloadReplay(onProgress) {
  const { story, style, w, h } = replay, keys = new Map();
  for (let t = 0; t <= story.duration; t += 1 / 8) {
    tilesFor(style, cameraAt(story, t), w, h).forEach(([z, x, y]) => keys.set(`${z}/${x}/${y}`, [z, x, y]));
    if (keys.size > REPLAY_TILES_MAX) break;
  }
  const list = [...keys.values()];
  let done = 0;
  for (let i = 0; i < list.length; i += 12) {
    await Promise.all(list.slice(i, i + 12).map(([z, x, y]) => replayTile(style, z, x, y).done.then(() => { done++; })));
    onProgress(done / list.length);
  }
  await Promise.all([...replay.photos.values()].map(img => (img.complete ? null : new Promise(r => { img.onload = img.onerror = r; }))));
}

async function saveReplay() {
  if (!replay || replay.recording) return;
  const types = ['video/mp4;codecs=avc1.640033', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const type = window.MediaRecorder && types.find(t => MediaRecorder.isTypeSupported(t));
  if (!type) return toast('This browser cannot record video', 'error');
  pauseReplay();
  const box = document.getElementById('replay'), wait = box.querySelector('.replay-wait');
  wait.hidden = false; wait.textContent = 'Loading the map…';
  await preloadReplay(f => { wait.textContent = `Loading the map… ${Math.round(f * 100)}%`; });
  if (!replay) return;
  wait.textContent = 'Recording: keep this window in front until it ends';
  setTimeout(() => { wait.hidden = true; }, 1800);
  const canvas = box.querySelector('canvas'), stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: replay.w * replay.h > 2e6 ? 16e6 : 10e6 }), chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm', blob = new Blob(chunks, { type: type.split(';')[0] });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${tripShown.start} ${tripShown.name}`.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.' + ext;
    if (chunks.length) { a.click(); toast(`Saved ${a.download}`); }
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    if (replay) { replay.recording = false; replay.onEnd = null; }
    box.querySelectorAll('select, [data-save], [data-seek]').forEach(el => { el.disabled = false; });
  };
  replay.recording = true; replay.recorder = rec;
  box.querySelectorAll('select, [data-save], [data-seek]').forEach(el => { el.disabled = true; });
  replay.t = 0; frame();
  rec.start(1000);
  replay.onEnd = () => setTimeout(() => rec.state !== 'inactive' && rec.stop(), 400);
  playReplay();
}
