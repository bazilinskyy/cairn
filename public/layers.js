'use strict';
// The map besides flights and ground trips: stays and rental cars (from flightmail), photos and Google Timeline (from
// imports/), Strava activities and the map tiles they explored, the countries visited, trips, a time window over
// everything, and "where was I on" a day.
// Loaded before the page's own script; uses its globals (map, allFlights, allAirports, allTrips, ...) when called.

const COUNTRIES_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';

// --- settings (kept in this browser): units, and the exploration tiles ---

const PREFS_KEY = 'contrail-settings';
let prefs = { units: 'km', tileZoom: 14, grid: true };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch (_) {}
function savePrefs(p) {
  prefs = { ...prefs, ...p };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
  TILE_Z = prefs.tileZoom;
  TILES = 2 ** TILE_Z;
}

// Distances and heights as chosen; everything is kept in km and m
const MILE = 1.609344, FOOT = 0.3048;
const imperial = () => prefs.units === 'mi';
const dist = km => (imperial() ? km / MILE : km);
const DU = () => (imperial() ? 'mi' : 'km');
const fmtDist = (km, digits = 0) => `${(Math.round(dist(km) * 10 ** digits) / 10 ** digits).toLocaleString()} ${DU()}`;
const height = m => (imperial() ? m / FOOT : m);
const HU = () => (imperial() ? 'ft' : 'm');
const fmtHeight = m => `${Math.round(height(m)).toLocaleString()} ${HU()}`;
const stayLayer = L.layerGroup(), carLayer = L.layerGroup(), photoLayer = L.layerGroup();
const timelineLayer = L.layerGroup(), countryLayer = L.layerGroup(), activityLayer = L.layerGroup(), tileLayer = L.layerGroup();
const cityLayer = L.layerGroup();
// Activities by type: a legend row each; the activity layer draws the types whose row is on
const ACT_KINDS = { ride: '🚴 Cycling', run: '🏃 Running', walk: '🥾 Walks & hikes', sport: '🏅 Other sports' };
const kindLayer = Object.fromEntries(Object.keys(ACT_KINDS).map(k => [k, L.layerGroup()]));
const shownKinds = () => Object.keys(ACT_KINDS).filter(k => map.hasLayer(kindLayer[k]));
const canvasRenderer = L.canvas({ padding: 0.5 });  // photos and Timeline can be many thousands of marks

let allStays = [], allPhotos = [], allTimeline = { visits: [], paths: [] }, settings = { home_airports: [] };
let allActivities = [], stravaStatus = {}, explored = null, topCities = [], citiesAsked = '';
let journeys = [];               // trips: from leaving a home airport until coming back
let win = { from: '', to: '' };  // the period shown, 'YYYY-MM-DD' inclusive; empty: everything
let whereMarker = null, countryShapes = null, visitedCount = 0;

const day = d => (d || '').slice(0, 10);
const inWin = d => !d || ((!win.from || day(d) >= win.from) && (!win.to || day(d) <= win.to));
const overlapsWin = (a, b) => (!win.to || day(a) <= win.to) && (!win.from || day(b || a) >= win.from);
const addDays = (d, n) => new Date(new Date(day(d) + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const nights = s => Math.max(1, Math.round((new Date(s.end || s.start) - new Date(s.start)) / 864e5));

function fmtDate(d) {
  return new Date(day(d) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Legend rows of these layers: [label, layer, colour variable]
function extraLayers() {
  return {
    stay: ['🏨 Stays', stayLayer, '--stay'], car: ['🚗 Rental cars', carLayer, '--car'],
    photo: ['📷 Photos', photoLayer, '--photo'], timeline: ['🧭 Timeline', timelineLayer, '--timeline'],
    ...Object.fromEntries(Object.entries(ACT_KINDS).map(([k, label]) => ['act-' + k, [label, kindLayer[k], '--' + k]])),
    tile: ['🟩 Explored tiles', tileLayer, '--tile'],
    country: ['🌍 Countries', countryLayer, '--country'], city: ['🏙️ Cities', cityLayer, '--city']
  };
}

function extraCounts() {
  const shown = allStays.filter(s => s.lat != null && overlapsWin(s.start, s.end));
  return {
    stay: shown.filter(s => s.what !== 'car').length, car: shown.filter(s => s.what === 'car').length,
    photo: photoCells().reduce((n, c) => n + c.count, 0),
    timeline: allTimeline.visits.filter(v => overlapsWin(v.start, v.end)).length, country: visitedCount,
    ...Object.fromEntries(Object.keys(ACT_KINDS).map(k => ['act-' + k, allActivities.filter(a => a.kind === k && inWin(a.date)).length])),
    tile: explored?.tiles.size ? `${explored.tiles.size.toLocaleString()} · ▢${explored.square.size}` : 0,
    city: topCities.length
  };
}

function drawExtras() {
  drawStays();
  drawPhotos();
  drawTimeline();
  drawActivities();
  drawTiles();
  drawCountries();
  drawCities();
}

// --- stays and rental cars ---

function drawStays() {
  stayLayer.clearLayers();
  carLayer.clearLayers();
  allStays.filter(s => s.lat != null && overlapsWin(s.start, s.end)).forEach(s => {
    const car = s.what === 'car', n = nights(s), color = getCSSVar(car ? '--car' : '--stay');
    const what = car ? `${n} day${n !== 1 ? 's' : ''}` : `${n} night${n !== 1 ? 's' : ''}`;
    L.circleMarker([s.lat, s.lon], {
      radius: car ? 5 : Math.min(3 + Math.sqrt(n) * 1.5, 9), color, fillColor: color, fillOpacity: 0.85, weight: 1
    }).bindPopup(`<b>${car ? '🚗 Rental car' : '🏨 ' + escapeHTML(s.type || 'Stay')}, ${escapeHTML(s.place)}</b><br>` +
      `<small>${fmtDate(s.start)} – ${fmtDate(s.end || s.start)} · ${what}${s.price ? ' · ' + escapeHTML(s.price) : ''}` +
      `${s.provider ? ' · ' + escapeHTML(s.provider) : ''}</small>`, { maxWidth: 260 }).addTo(car ? carLayer : stayLayer);
  });
}

// --- photos ---

// The photo places of the period, years added up: a cell counts when one of its days falls in it
function photoCells() {
  const cells = {};
  allPhotos.forEach(c => {
    const days = (c.days || []).filter(d => inWin(d));
    if (!days.length) return;
    const k = c.lat + ',' + c.lon, cell = cells[k] = cells[k] || { lat: c.lat, lon: c.lon, count: 0, days: [] };
    cell.count += win.from || win.to ? Math.max(1, Math.round(c.count * days.length / c.days.length)) : c.count;
    cell.days.push(...days);
  });
  return Object.values(cells);
}

function drawPhotos() {
  photoLayer.clearLayers();
  const color = getCSSVar('--photo');
  photoCells().forEach(c => {
    const days = c.days.sort();
    L.circleMarker([c.lat, c.lon], {
      renderer: canvasRenderer, radius: Math.min(2 + Math.sqrt(c.count) * 0.6, 12), color, fillColor: color,
      fillOpacity: 0.45, weight: 0.5
    }).bindPopup(`<b>📷 ${c.count.toLocaleString()} photo${c.count !== 1 ? 's' : ''}</b><br>` +
      `<small>${days.length} day${days.length !== 1 ? 's' : ''}: ${fmtDate(days[0])}${days.length > 1 ? ' – ' + fmtDate(days[days.length - 1]) : ''}</small>`)
      .addTo(photoLayer);
  });
}

// --- Google Timeline ---

function drawTimeline() {
  timelineLayer.clearLayers();
  const color = getCSSVar('--timeline');
  allTimeline.paths.filter(p => inWin(p.date)).forEach(p => {
    L.polyline(decodePath(p.path), { renderer: canvasRenderer, color, weight: 1.5, opacity: 0.55, interactive: false })
      .addTo(timelineLayer);
  });
  allTimeline.visits.filter(v => overlapsWin(v.start, v.end)).forEach(v => {
    L.circleMarker([v.lat, v.lon], { renderer: canvasRenderer, radius: 2.5, color, fillColor: color, fillOpacity: 0.8, weight: 0 })
      .bindPopup(`<b>🧭 ${escapeHTML(v.name || 'Visit')}</b><br><small>${escapeHTML(v.start)} – ${escapeHTML(v.end.slice(day(v.end) === day(v.start) ? 11 : 0))}</small>`)
      .addTo(timelineLayer);
  });
}

// --- Strava activities and the tiles they explored ---
// Made for thousands of activities: they load after the rest of the map; each route is decoded once; routes and
// explored tiles are painted on canvas map tiles, only where the map is in view (never one map object per activity);
// and the explored tiles of each activity come worked out from Contrail.

const SPORTS = {
  ride: /Ride|Velomobile|Handcycle|Wheelchair/, run: /Run/, walk: /Walk|Hike|Snowshoe/
};
const sportOf = s => Object.keys(SPORTS).find(k => SPORTS[k].test(s || '')) || 'sport';
const sportEmoji = { ride: '🚴', run: '🏃', walk: '🥾', sport: '🏅' };
// Explored tiles are map tiles at zoom 14 (statshunters' tiles, ~1.5 km in the Netherlands) or 17 (squadratinhos,
// ~200 m), as chosen in the settings; packed as x * TILES + y
let TILE_Z = prefs.tileZoom, TILES = 2 ** TILE_Z;

// An activity's tiles at the chosen zoom: Contrail's (zoom 14), else from its route, once (a point every quarter tile)
function actTiles(a) {
  if (TILE_Z === 14 || !a.pts) return a.tiles || [];
  const key = 'tiles' + TILE_Z;
  if (!a[key]) {
    const out = new Set(), step = 360 / TILES / 4;
    for (let i = 0; i < a.pts.length; i += 2) {
      const j = Math.max(0, i - 2), la = a.pts[j], lo = a.pts[j + 1], lb = a.pts[i], ob = a.pts[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(lb - la, (ob - lo) * Math.cos(la * Math.PI / 180)) / step));
      for (let k = 1; k <= steps; k++) {
        const lat = la + (lb - la) * k / steps, lon = lo + (ob - lo) * k / steps;
        out.add(Math.floor(pxX(lon, TILE_Z) / 256) * TILES + Math.floor(pxY(lat, TILE_Z) / 256));
      }
    }
    a[key] = [...out];
  }
  return a[key];
}
const tileLat = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / TILES))) * 180 / Math.PI;
const tileLon = x => x / TILES * 360 - 180;
// Web Mercator pixels at zoom z, and back
const pxX = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
const pxY = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256 * 2 ** z; };
const lonAt = (x, z) => x / (256 * 2 ** z) * 360 - 180;
const latAt = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (256 * 2 ** z)))) * 180 / Math.PI;

let actShown = [], actColors = {}, tileBuckets = new Map(), lastPopup = 0;

// Decode each route once into a flat array [lat, lon, lat, lon, ...] with its bounding box
function prepareActivities(list) {
  list.forEach(a => {
    a.kind = sportOf(a.sport);
    if (!a.path) return;
    const pts = decodePath(a.path), f = new Float64Array(pts.length * 2);
    let s = 90, w = 180, n = -90, e = -180;
    pts.forEach(([lat, lon], i) => {
      f[2 * i] = lat; f[2 * i + 1] = lon;
      if (lat < s) s = lat; if (lat > n) n = lat; if (lon < w) w = lon; if (lon > e) e = lon;
    });
    a.pts = f;
    a.bbox = [s, w, n, e];
  });
}

const ActivityCanvas = L.GridLayer.extend({
  createTile(coords) {
    const c = L.DomUtil.create('canvas'), size = this.getTileSize(), z = coords.z;
    c.width = size.x; c.height = size.y;
    const ctx = c.getContext('2d'), ox = coords.x * size.x, oy = coords.y * size.y, pad = 4;
    const west = lonAt(ox - pad, z), east = lonAt(ox + size.x + pad, z), north = latAt(oy - pad, z), south = latAt(oy + size.y + pad, z);
    ctx.lineWidth = z < 9 ? 1 : z < 13 ? 1.6 : 2.4;
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.globalAlpha = 0.75;
    for (const a of actShown) {
      const [s, w, n, e] = a.bbox;
      if (n < south || s > north || e < west || w > east) continue;
      ctx.strokeStyle = actColors[a.kind];
      ctx.beginPath();
      let lx = null, ly = 0;
      for (let i = 0; i < a.pts.length; i += 2) {
        const x = pxX(a.pts[i + 1], z) - ox, y = pxY(a.pts[i], z) - oy;
        if (lx === null) ctx.moveTo(x, y);
        else if (Math.abs(x - lx) + Math.abs(y - ly) < 0.8 && i < a.pts.length - 2) continue;  // under a pixel apart
        else ctx.lineTo(x, y);
        lx = x; ly = y;
      }
      ctx.stroke();
    }
    return c;
  }
});

// The explored tiles inside one map tile at zoom z (zoom 14 or less), grouped once per zoom
function bucketsAt(z) {
  if (!tileBuckets.has(z)) {
    const shift = TILE_Z - z, m = new Map();
    explored.tiles.forEach(k => {
      const x = Math.floor(k / TILES), y = k % TILES, key = (x >> shift) + ',' + (y >> shift);
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(k);
    });
    tileBuckets.set(z, m);
  }
  return tileBuckets.get(z);
}

// The grid of all tiles, as on statshunters, so the unexplored ones show: once the tiles are 6 pixels or more
function drawTileGrid(ctx, coords, size) {
  const z = coords.z;
  ctx.strokeStyle = getCSSVar('--tile');
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (z >= TILE_Z) {  // inside one tile: its west and north edges, when they run through this map tile
    const shift = z - TILE_Z;
    if (coords.x % 2 ** shift === 0) { ctx.moveTo(0.5, 0); ctx.lineTo(0.5, size.y); }
    if (coords.y % 2 ** shift === 0) { ctx.moveTo(0, 0.5); ctx.lineTo(size.x, 0.5); }
  } else {
    const n = 2 ** (TILE_Z - z), px = size.x / n;
    if (px < 6) return;
    for (let i = 0; i < n; i++) {
      ctx.moveTo(i * px + 0.5, 0); ctx.lineTo(i * px + 0.5, size.y);
      ctx.moveTo(0, i * px + 0.5); ctx.lineTo(size.x, i * px + 0.5);
    }
  }
  ctx.stroke();
}

const ExploredCanvas = L.GridLayer.extend({
  createTile(coords) {
    const c = L.DomUtil.create('canvas'), size = this.getTileSize(), z = coords.z;
    c.width = size.x; c.height = size.y;
    if (prefs.grid) drawTileGrid(c.getContext('2d'), coords, size);
    if (!explored?.tiles.size) return c;
    const ctx = c.getContext('2d'), color = getCSSVar('--tile');
    ctx.fillStyle = color;
    const fill = (k, x, y, w) => {
      ctx.globalAlpha = explored.cluster.has(k) ? 0.38 : 0.16;
      ctx.fillRect(x, y, w, w);
    };
    if (z >= TILE_Z) {  // the map tile lies inside one explored tile, or none
      const shift = z - TILE_Z, k = (coords.x >> shift) * TILES + (coords.y >> shift);
      if (explored.tiles.has(k)) fill(k, 0, 0, size.x);
      return c;
    }
    const shift = TILE_Z - z, px = size.x / 2 ** shift, gap = px > 6 ? 1 : 0;
    (bucketsAt(z).get(coords.x + ',' + coords.y) || []).forEach(k => {
      const x = Math.floor(k / TILES), y = k % TILES;
      fill(k, (x - (coords.x << shift)) * px, (y - (coords.y << shift)) * px, Math.max(px - gap, 1));
    });
    return c;
  }
});

const activityGrid = new ActivityCanvas({ pane: 'activities', updateWhenZooming: false, keepBuffer: 1 });
const exploredGrid = new ExploredCanvas({ pane: 'explored', updateWhenZooming: false, keepBuffer: 1 });
activityLayer.addLayer(activityGrid);
tileLayer.addLayer(exploredGrid);
const squareLayer = L.layerGroup().addTo(tileLayer);

// Panes of their own between the map and the lines (the map's own pane is colour-inverted in dark mode), and a
// click on a route opens it; called by initMap before the layers go on the map
function initExtraPanes() {
  map.createPane('explored').style.zIndex = 330;
  map.createPane('activities').style.zIndex = 340;
  ['explored', 'activities'].forEach(p => { map.getPane(p).style.pointerEvents = 'none'; });
  map.on('popupopen', () => { lastPopup = Date.now(); });
  addLocateControl();
  map.on('click', e => setTimeout(() => { if (Date.now() - lastPopup > 150) openActivityAt(e.latlng); }, 0));
}

// The route nearest a click, within 6 pixels
function openActivityAt(ll) {
  if (!map.hasLayer(activityLayer) || !actShown.length) return;
  const z = map.getZoom(), cx = pxX(ll.lng, z), cy = pxY(ll.lat, z), tol = 6, deg = tol / (256 * 2 ** z) * 360;
  let best = null, bestD = tol;
  for (const a of actShown) {
    const [s, w, n, e] = a.bbox;
    if (ll.lat < s - deg || ll.lat > n + deg || ll.lng < w - deg || ll.lng > e + deg) continue;
    let px = pxX(a.pts[1], z), py = pxY(a.pts[0], z);
    for (let i = 2; i < a.pts.length; i += 2) {
      const qx = pxX(a.pts[i + 1], z), qy = pxY(a.pts[i], z), dx = qx - px, dy = qy - py;
      const t = dx || dy ? Math.max(0, Math.min(1, ((cx - px) * dx + (cy - py) * dy) / (dx * dx + dy * dy))) : 0;
      const d = Math.hypot(cx - px - t * dx, cy - py - t * dy);
      if (d < bestD) { bestD = d; best = a; }
      px = qx; py = qy;
    }
  }
  if (best) activityPopup(best, ll);
}

// The activity's popup, and its route drawn over all the others (with a casing in the text colour) while it is open
let activityHighlight = null;
function activityPopup(a, ll) {
  if (activityHighlight) map.removeLayer(activityHighlight);
  const pts = [];
  for (let i = 0; i < a.pts.length; i += 2) pts.push([a.pts[i], a.pts[i + 1]]);
  activityHighlight = L.layerGroup([
    L.polyline(pts, { color: getCSSVar('--text'), weight: 7, opacity: 0.9, interactive: false }),
    L.polyline(pts, { color: getCSSVar('--' + a.kind), weight: 4, opacity: 1, interactive: false })
  ]).addTo(map);
  L.popup({ maxWidth: 260 }).setLatLng(ll).setContent(`<b>${sportEmoji[a.kind]} ${escapeHTML(a.name)}</b><br>` +
    `<small>${escapeHTML(a.sport)} · ${fmtDate(a.date)} · ${fmtDist(a.distance, 1)}` +
    `${a.elevation ? ` · ↑${fmtHeight(a.elevation)}` : ''}</small>`).on('remove', () => {
    if (activityHighlight) map.removeLayer(activityHighlight);
    activityHighlight = null;
  }).openOn(map);
}

let kindsDrawn = '';
function drawActivities() {
  const kinds = shownKinds();
  kindsDrawn = kinds.join();
  actShown = allActivities.filter(a => a.pts && inWin(a.date) && kinds.includes(a.kind));
  actColors = Object.fromEntries(Object.keys(ACT_KINDS).map(k => [k, getCSSVar('--' + k)]));
  if (kinds.length) activityLayer.addTo(map);
  else map.removeLayer(activityLayer);
  activityGrid.redraw();
}

// After the legend turned layers on or off: the activities and their tiles again when the types shown changed
function afterToggle() {
  if (shownKinds().join() === kindsDrawn) return;
  drawActivities();
  drawTiles();
}

// The explored tiles of the period, from each activity's own; the cluster (tiles whose four neighbours are explored
// too, the biggest connected group of them) and the max square (the biggest square of explored tiles)
function computeExplored() {
  const tiles = new Set();
  const kinds = shownKinds();  // the tiles of the types shown: cycling alone, running alone, or together
  allActivities.forEach(a => { if (inWin(a.date) && kinds.includes(a.kind)) actTiles(a).forEach(k => tiles.add(k)); });
  const size = new Map();
  let square = { x: 0, y: 0, size: 0 };
  [...tiles].sort((p, q) => (p % TILES) - (q % TILES) || p - q).forEach(k => {  // row by row, west to east
    const n = 1 + Math.min(size.get(k - TILES) || 0, size.get(k - 1) || 0, size.get(k - TILES - 1) || 0);
    size.set(k, n);
    if (n > square.size) square = { x: Math.floor(k / TILES) - n + 1, y: k % TILES - n + 1, size: n };
  });
  const near = k => [k - TILES, k + TILES, k - 1, k + 1];
  const inner = new Set([...tiles].filter(k => near(k).every(m => tiles.has(m))));
  let cluster = new Set();
  const seen = new Set();
  inner.forEach(k => {
    if (seen.has(k)) return;
    const group = new Set([k]), todo = [k];
    seen.add(k);
    while (todo.length) near(todo.pop()).forEach(m => {
      if (inner.has(m) && !seen.has(m)) { seen.add(m); group.add(m); todo.push(m); }
    });
    if (group.size > cluster.size) cluster = group;
  });
  return { tiles, cluster, square };
}

function drawTiles() {
  explored = computeExplored();
  tileBuckets = new Map();
  exploredGrid.redraw();
  squareLayer.clearLayers();
  if (!explored.tiles.size) return;
  const { x, y, size } = explored.square;
  L.rectangle([[tileLat(y + size), tileLon(x)], [tileLat(y), tileLon(x + size)]], { color: getCSSVar('--text'), weight: 2, fill: false, dashArray: '6 4' })
    .bindPopup(`<b>🟩 Explored ${TILE_Z === 14 ? 'tiles' : 'squadratinhos'}</b><br><small>${explored.tiles.size.toLocaleString()} · max square ${size}×${size} · ` +
      `max cluster ${explored.cluster.size.toLocaleString()}</small>`).addTo(squareLayer);
}

// Strava's activities, after the rest of the map is up
async function loadStrava() {
  const list = await fetch('/api/activities').then(r => r.ok ? r.json() : []).catch(() => []);
  if (!list.length) return;
  allActivities = list;
  prepareActivities(allActivities);
  refreshYears();
  drawActivities();
  drawTiles();
  drawCountries();
  drawLegend();
  if (document.getElementById('tab-sports')?.classList.contains('active')) renderSports();
}

// --- where I am now ---

const LOCATE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
let meLayer = null;

// A button above the zoom buttons (bottom right): the map centres on where the browser says you are (it asks the first time)
function addLocateControl() {
  const Locate = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar');
      const a = L.DomUtil.create('a', 'map-locate', bar);
      a.href = '#';
      a.title = 'Centre on my location';
      a.setAttribute('role', 'button');
      a.setAttribute('aria-label', 'Centre on my location');
      a.innerHTML = LOCATE_ICON;
      L.DomEvent.on(a, 'click', e => { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); locateMe(); });
      return bar;
    }
  });
  new Locate().addTo(map);
}

function locateMe() {
  if (!navigator.geolocation) return toast('This browser cannot tell where you are', 'error');
  navigator.geolocation.getCurrentPosition(p => {
    const ll = [p.coords.latitude, p.coords.longitude], acc = Math.round(p.coords.accuracy), color = getCSSVar('--accent');
    if (meLayer) map.removeLayer(meLayer);
    meLayer = L.layerGroup([
      L.circle(ll, { radius: acc, color, weight: 1, fillOpacity: 0.08, interactive: false }),
      L.circleMarker(ll, { radius: 7, color: getCSSVar('--surface'), weight: 2, fillColor: color, fillOpacity: 1 })
        .bindPopup(`<b>You are here</b><br><small>to within ${acc.toLocaleString()} m</small>`)
    ]).addTo(map);
    map.setView(ll, Math.max(map.getZoom(), acc > 2000 ? 11 : 14));
  }, err => toast(err.code === 1 ? 'Location not allowed: allow it for this page in the browser' : 'Could not find where you are', 'error'),
  { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

// --- most visited cities ---

const flagOf = cc => /^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) + ' ' : '';

// Contrail counts the days per town (cities.js); asked again when the period changes, drawn when the answer comes
function drawCities() {
  const q = new URLSearchParams({ from: win.from, to: win.to }).toString();
  if (q === citiesAsked) return paintCities();
  citiesAsked = q;
  fetch('/api/cities?' + q).then(r => r.ok ? r.json() : []).catch(() => []).then(list => {
    if (q !== citiesAsked) return;  // the period changed again meanwhile
    topCities = list;
    paintCities();
    drawLegend();
  });
}

function paintCities() {
  cityLayer.clearLayers();
  const color = getCSSVar('--city'), most = topCities[0]?.days || 1;
  topCities.forEach((c, i) => {
    const m = L.circleMarker([c.lat, c.lon], {
      radius: 3 + 11 * Math.sqrt(c.days / most), color, weight: 1.5, fillColor: color, fillOpacity: 0.35
    }).bindPopup(`<b>🏙️ ${flagOf(c.country)}${escapeHTML(c.name)}</b> · #${i + 1}<br><small>${c.days} day${c.days !== 1 ? 's' : ''}, ` +
      `${c.visits} visit${c.visits !== 1 ? 's' : ''} · ${fmtDate(c.first)} – ${fmtDate(c.last)}</small>`);
    if (i < 10) m.bindTooltip(`${i + 1}. ${escapeHTML(c.name)}`, { permanent: true, direction: 'right', className: 'city-label', offset: [6, 0] });
    m.addTo(cityLayer);
  });
}

// --- countries visited ---

// Where you were in the period: the airports you arrived at (not only to change planes), the ends of trains, buses and
// ferries, stays, rental cars, photos and Timeline visits
function visitPoints() {
  const pts = [];
  const fl = allFlights.filter(f => f.date && allAirports[f.to]).sort((a, b) => a.date.localeCompare(b.date));
  fl.forEach((f, i) => {
    const next = fl[i + 1];
    const change = next && next.from === f.to && new Date(next.date.replace(' ', 'T')) - new Date(f.date.replace(' ', 'T')) < 864e5;
    if (!change && inWin(f.date)) pts.push({ at: [allAirports[f.to].lat, allAirports[f.to].lon], date: day(f.date) });
  });
  allTrips.forEach(t => {
    if (!inWin(t.date)) return;
    if (t.from_lat != null) pts.push({ at: [t.from_lat, t.from_lon], date: day(t.date) });
    if (t.to_lat != null) pts.push({ at: [t.to_lat, t.to_lon], date: day(t.date) });
  });
  allStays.forEach(s => { if (s.lat != null && overlapsWin(s.start, s.end)) pts.push({ at: [s.lat, s.lon], date: day(s.start) }); });
  photoCells().forEach(c => pts.push({ at: [c.lat, c.lon], date: c.days.sort()[0] }));
  allTimeline.visits.forEach(v => { if (overlapsWin(v.start, v.end)) pts.push({ at: [v.lat, v.lon], date: day(v.start) }); });
  allActivities.forEach(a => { if (a.at && inWin(a.date)) pts.push({ at: a.at, date: day(a.date) }); });
  return pts;
}

function ringsOf(g) {
  return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
}

const boxOf = pts => {
  let w = 180, s = 90, e = -180, n = -90;
  pts.forEach(([x, y]) => { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; });
  return [w, s, e, n];
};
const inBox = ([w, s, e, n], lat, lon) => lon >= w && lon <= e && lat >= s && lat <= n;

// Even-odd ray casting; a ring whose box does not hold the point cannot flip the result, so it is skipped (most of a
// country's outline parts are small islands far from the point)
function inShape(shape, lat, lon) {
  if (!inBox(shape.bbox, lat, lon)) return false;
  let inside = false;
  for (const { box, ring } of shape.rings) {
    if (!inBox(box, lat, lon)) continue;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// The country of a point, to about 5 km; a point just off the coast (a port, an airport on the shore) takes the one
// within about 10 km. The country found last is tried first: points come in runs from the same place.
const countryCache = new Map();
let lastCountry = null;
function countryAt(lat, lon) {
  const key = (Math.round(lat * 20) / 20) + ',' + (Math.round(lon * 20) / 20);
  if (!countryCache.has(key)) {
    const find = (y, x) => (lastCountry && inShape(lastCountry, y, x) && lastCountry) || countryShapes.find(c => inShape(c, y, x));
    let hit = find(lat, lon);
    for (const [dy, dx] of [[0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1], [0.07, 0.07], [-0.07, -0.07], [0.07, -0.07], [-0.07, 0.07]]) {
      if (hit) break;
      hit = find(lat + dy, lon + dx);
    }
    if (hit) lastCountry = hit;
    countryCache.set(key, hit || null);
  }
  return countryCache.get(key);
}

async function loadCountries() {
  const topo = await fetch(COUNTRIES_URL).then(r => r.json());
  countryShapes = topojson.feature(topo, topo.objects.countries).features.map(f => {
    const rings = ringsOf(f.geometry).flat().map(ring => ({ box: boxOf(ring), ring }));
    return { name: f.properties.name, feature: f, rings, bbox: boxOf(rings.map(r => r.box).flatMap(([w, s, e, n]) => [[w, s], [e, n]])) };
  });
}

function drawCountries() {
  countryLayer.clearLayers();
  if (!countryShapes) {
    if (typeof topojson !== 'undefined') loadCountries().then(() => { drawCountries(); drawLegend(); }).catch(e => console.warn('countries:', e));
    return;
  }
  const seen = new Map();  // shape -> { first, n }
  visitPoints().forEach(p => {
    const c = countryAt(p.at[0], p.at[1]);
    if (!c) return;
    const v = seen.get(c) || { first: p.date, n: 0 };
    v.n++;
    if (p.date && p.date < v.first) v.first = p.date;
    seen.set(c, v);
  });
  visitedCount = seen.size;
  const color = getCSSVar('--country');
  seen.forEach((v, c) => {
    L.geoJSON(c.feature, { style: { color, weight: 0.8, opacity: 0.6, fillColor: color, fillOpacity: 0.16 } })
      .bindPopup(`<b>🌍 ${escapeHTML(c.name)}</b><br><small>first visit${win.from || win.to ? ' in this period' : ''}: ${fmtDate(v.first)}</small>`)
      .addTo(countryLayer);
  });
  countryLayer.eachLayer(l => l.bringToBack());
}

// --- trips ---

// From leaving a home airport until landing at one again; named after the countries flown to
function computeJourneys() {
  const home = new Set(settings.home_airports || []);
  const homeCountries = new Set([...home].map(h => allAirports[h]?.country).filter(Boolean));
  const fl = allFlights.filter(f => f.date && f.from && f.to).sort((a, b) => a.date.localeCompare(b.date));
  const out = [];
  let cur = null;
  const close = end => { cur.end = end; out.push(cur); cur = null; };
  for (const f of fl) {
    if (cur && home.has(f.from) && cur.flights[cur.flights.length - 1].to !== f.from) close(addDays(cur.flights[cur.flights.length - 1].date, 1));
    if (!cur && home.has(f.from)) cur = { start: day(f.date), flights: [] };
    if (!cur) continue;
    cur.flights.push(f);
    if (home.has(f.to)) close(addDays(f.date, 1));  // an evening flight lands the next day
  }
  if (cur) close(addDays(cur.flights[cur.flights.length - 1].date, 1));
  journeys = out.map(j => {
    const names = [...new Set(j.flights.map(f => allAirports[f.to]?.country).filter(c => c && !homeCountries.has(c)))];
    return { ...j, name: names.slice(0, 3).join(' · ') + (names.length > 3 ? ' …' : '') || 'Trip' };
  }).reverse();
}

// The map's view of the period: its flights' airports, ground trips and stays
function windowBounds() {
  const pts = [];
  allFlights.filter(f => inWin(f.date)).forEach(f => [f.from, f.to].forEach(c => { if (allAirports[c]) pts.push([allAirports[c].lat, allAirports[c].lon]); }));
  allTrips.filter(t => inWin(t.date) && t.to_lat != null && t.from_lat != null).forEach(t => pts.push([t.from_lat, t.from_lon], [t.to_lat, t.to_lon]));
  allStays.filter(s => s.lat != null && overlapsWin(s.start, s.end)).forEach(s => pts.push([s.lat, s.lon]));
  return pts.length ? L.latLngBounds(pts) : null;
}

// --- the period control: years, a trip, a day ---

function years() {
  const ys = new Set();
  const add = d => { if (/^\d{4}/.test(d || '')) ys.add(+d.slice(0, 4)); };
  allFlights.forEach(f => add(f.date)); allTrips.forEach(t => add(t.date)); allStays.forEach(s => add(s.start));
  allPhotos.forEach(c => ys.add(c.year)); allTimeline.paths.forEach(p => add(p.date)); allActivities.forEach(a => add(a.date));
  return [...ys].sort();
}

// The year lists again, when Strava's activities arrive after the control was made
function refreshYears() {
  ['p-from', 'p-to'].forEach((id, i) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = `<option value="">${i ? 'last' : 'first'}</option>` + years().map(y => `<option value="${y}">${y}</option>`).join('');
    sel.value = keep;
  });
}

function addPeriodControl() {
  const Period = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-legend map-period');
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      const ys = years(), opt = (v, t) => `<option value="${v}">${t}</option>`;
      box.innerHTML =
        `<label>Years <select id="p-from">${opt('', 'first')}${ys.map(y => opt(y, y)).join('')}</select>` +
        `– <select id="p-to">${opt('', 'last')}${ys.map(y => opt(y, y)).join('')}</select></label>` +
        `<label>Trip <select id="p-trip">${opt('', 'all trips')}` +
        journeys.map((j, i) => opt(i, `${j.start.slice(0, 7)} · ${escapeHTML(j.name)}`)).join('') + `</select></label>` +
        `<label>Where on <input type="date" id="p-day"></label>` + stravaRow();
      return box;
    }
  });
  new Period().addTo(map);
  const $ = id => document.getElementById(id);
  const byYears = () => {
    $('p-trip').value = '';
    win = { from: $('p-from').value ? $('p-from').value + '-01-01' : '', to: $('p-to').value ? $('p-to').value + '-12-31' : '' };
    redrawMap();
  };
  $('p-from').addEventListener('change', byYears);
  $('p-to').addEventListener('change', byYears);
  $('p-trip').addEventListener('change', () => {
    const j = journeys[$('p-trip').value];
    $('p-from').value = $('p-to').value = '';
    win = j ? { from: j.start, to: j.end } : { from: '', to: '' };
    redrawMap();
    const b = j && windowBounds();
    if (b) map.fitBounds(b, { padding: [40, 40], maxZoom: 9 });
  });
  $('p-day').addEventListener('change', () => whereOn($('p-day').value));
  $('p-strava')?.addEventListener('click', e => {
    if (!e.target.dataset.sync) return;
    e.preventDefault();
    fetch('/api/strava/sync', { method: 'POST' }).then(() => toast('Strava: fetching activities; reload in a minute'));
  });
}

// Where the sports activities come from, in the period box: Garmin (its last sync, or why it failed), and Strava
// when it is set up (connect, or fetch new ones now)
function stravaRow() {
  const g = stravaStatus.garmin || {}, s = stravaStatus.strava || {};
  const ago = t => { const h = (Date.now() - Date.parse(t)) / 36e5; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : fmtDate(t); };
  const rows = [];
  if (g.count || g.error) rows.push(`<span title="${escapeHTML(g.error || '')}">Garmin: ${g.count.toLocaleString()} activities` +
    `${g.last_sync ? ` · synced ${ago(g.last_sync)}` : ''}${g.error ? ` · ⚠️ sync failed ${ago(g.error_at)}` : ''}</span>`);
  if (s.configured && !s.connected) rows.push(`<a href="/auth/strava">Connect Strava</a>`);
  else if (s.connected) rows.push(`<span title="${escapeHTML(s.error || 'last fetched ' + (s.last_sync || 'never'))}">Strava: ` +
    `${s.count.toLocaleString()} activities${s.error ? ' ⚠️' : ''} · <a href="#" data-sync="1">fetch now</a></span>`);
  return rows.length ? `<div id="p-strava">${rows.join('<br>')}</div>` : '';
}

// --- where was I on a day ---

function whereOn(d) {
  if (whereMarker) map.removeLayer(whereMarker);
  whereMarker = null;
  if (!d) return;
  const lines = [], spots = [];
  allFlights.filter(f => day(f.date) === d).sort((a, b) => a.date.localeCompare(b.date)).forEach(f => {
    lines.push(`✈️ ${escapeHTML(f.flight_number || '')} ${escapeHTML(f.from)} → ${escapeHTML(f.to)}`);
    if (allAirports[f.to]) spots.push([allAirports[f.to].lat, allAirports[f.to].lon]);
  });
  allTrips.filter(t => day(t.date) === d).sort((a, b) => a.date.localeCompare(b.date)).forEach(t => {
    lines.push(`${(groundModes[t.mode] || '🚌').split(' ')[0]} ${escapeHTML(t.from)} → ${escapeHTML(t.to)}`);
    if (t.to_lat != null) spots.push([t.to_lat, t.to_lon]);
  });
  const sleeping = allStays.filter(s => s.what !== 'car' && day(s.start) <= d && d < day(s.end || s.start));
  allStays.filter(s => s.what === 'car' && day(s.start) <= d && d <= day(s.end || s.start))
    .forEach(s => lines.push(`🚗 rental car from ${escapeHTML(s.place)}`));
  sleeping.forEach(s => lines.push(`🏨 ${escapeHTML(s.type || 'stay')} in ${escapeHTML(s.place)}`));
  allTimeline.visits.filter(v => day(v.start) <= d && d <= day(v.end)).slice(0, 6).forEach(v => {
    lines.push(`🧭 ${escapeHTML(v.name || 'a place')} ${escapeHTML(v.start.slice(11))}`);
    spots.push([v.lat, v.lon]);
  });
  allActivities.filter(a => day(a.date) === d).forEach(a => {
    lines.push(`${sportEmoji[a.kind]} ${escapeHTML(a.name)}, ${fmtDist(a.distance, 1)}`);
    if (a.at) spots.push(a.at);
  });
  const shots = allPhotos.filter(c => (c.days || []).includes(d));
  if (shots.length) lines.push(`📷 photos in ${shots.length} place${shots.length !== 1 ? 's' : ''}`);
  shots.forEach(c => spots.push([c.lat, c.lon]));
  const bed = sleeping.find(s => s.lat != null);
  let spot = bed ? [bed.lat, bed.lon] : spots[spots.length - 1];
  if (!spot) {  // nothing that day: the last place known before it
    const before = [];
    allFlights.forEach(f => { if (day(f.date) < d && allAirports[f.to]) before.push([day(f.date), [allAirports[f.to].lat, allAirports[f.to].lon], `✈️ landed in ${escapeHTML(allAirports[f.to].city)}`]); });
    allTrips.forEach(t => { if (day(t.date) < d && t.to_lat != null) before.push([day(t.date), [t.to_lat, t.to_lon], `arrived in ${escapeHTML(t.to)}`]); });
    allStays.forEach(s => { if (s.what !== 'car' && day(s.start) < d && s.lat != null) before.push([day(s.start), [s.lat, s.lon], `stayed in ${escapeHTML(s.place)}`]); });
    allTimeline.visits.forEach(v => { if (day(v.end) < d) before.push([day(v.end), [v.lat, v.lon], escapeHTML(v.name || 'a place')]); });
    const last = before.sort((a, b) => a[0].localeCompare(b[0])).pop();
    if (!last) return toast('Nothing known before that day', 'error');
    spot = last[1];
    lines.push(`<small>nothing that day; last known: ${last[2]} on ${fmtDate(last[0])}</small>`);
  }
  whereMarker = L.circleMarker(spot, { radius: 9, color: getCSSVar('--text'), weight: 2, fillColor: getCSSVar('--accent2'), fillOpacity: 0.9 })
    .bindPopup(`<b>${fmtDate(d)}</b><br>${lines.join('<br>')}`, { maxWidth: 280 }).addTo(map);
  map.setView(spot, Math.max(map.getZoom(), 6));
  whereMarker.openPopup();
}
