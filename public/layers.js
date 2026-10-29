'use strict';
// The map besides flights and ground trips: stays and rental cars (from tripmail), photos and Google Timeline (from
// imports/), Strava activities and the map tiles they explored, the countries visited, trips, a time window over
// everything, and "where was I on" a day.
// Loaded before the page's own script; uses its globals (map, allFlights, allAirports, allTrips, ...) when called.

// --- settings (kept in this browser): units, and the exploration tiles ---

const PREFS_KEY = 'contrail-settings';
let prefs = { units: 'km', tileZoom: 14, grid: true, countries: 'iso', basemap: 'auto', lines: 'standard', photos: 'clusters' };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch (_) {}
function savePrefs(p) {
  prefs = { ...prefs, ...p };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
  TILE_Z = prefs.tileZoom;
  TILES = 2 ** TILE_Z;
}

// --- how the map looks: the base map, and how strong lines and markers are drawn ---

const OSM = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'];
// filter: how the tiles are tinted (#map[data-basemap] in the page's styles); auto follows the light or dark theme
const BASEMAPS = {
  auto: { label: 'Follow the theme (dark or light)', tiles: OSM },
  grey: { label: 'Light grey: lines and markers stand out, as on statshunters', tiles: OSM, tone: 'light' },
  'grey-dark': { label: 'Dark grey', tiles: OSM, tone: 'dark' },
  colour: { label: 'OpenStreetMap in colour', tiles: OSM, tone: 'light' },
  topo: { label: 'Topographic (OpenTopoMap)', tone: 'light', tiles: ['https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM; style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)', 17] },
  satellite: { label: 'Satellite (Esri)', tone: 'sat', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community'] }
};
// Lines and markers take the colours of the map's tone, not of the page's theme: dark on a light map, light on a dark
// one, vivid with an outline on the satellite (data-theme on the map's panes; its popups and controls follow the page)
const mapTone = () => (BASEMAPS[prefs.basemap] || BASEMAPS.auto).tone || document.documentElement.dataset.theme || 'dark';
const toneProbes = {};
function mapVar(name) {
  const tone = mapTone();
  if (!toneProbes[tone]) {
    toneProbes[tone] = Object.assign(document.createElement('div'), { hidden: true });
    toneProbes[tone].dataset.theme = tone;
    document.body.append(toneProbes[tone]);
  }
  return getComputedStyle(toneProbes[tone]).getPropertyValue(name).trim() || getCSSVar(name);
}
function toneMap(m) {
  if (!m) return;
  const tone = mapTone();
  Object.entries(m.getPanes()).forEach(([name, pane]) => {
    if (!['mapPane', 'tilePane', 'popupPane'].includes(name)) pane.dataset.theme = tone;
  });
}

let baseLayer = null;
function setBasemap() {
  const b = BASEMAPS[prefs.basemap] || BASEMAPS.auto, [url, attribution, maxZoom = 19] = b.tiles;
  if (!baseLayer || baseLayer._url !== url) {
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = L.tileLayer(url, { attribution, maxZoom }).addTo(map);
  }
  document.getElementById('map').dataset.basemap = BASEMAPS[prefs.basemap] ? prefs.basemap : 'auto';
}

// Lines and markers: w scales line widths, o their opacity, r the size of markers. Applied to every line and marker
// as it is made (and to the activity routes drawn on canvas), so a change needs the map drawn again.
const LINE_STYLES = {
  standard: { label: 'Standard', w: 1, o: 1, r: 1 },
  bold: { label: 'Bold: thicker, solid lines and bigger markers (best on a grey map)', w: 1.8, o: 1.5, r: 1.35 },
  fine: { label: 'Fine: thin and faint, the map shows through', w: 0.6, o: 0.75, r: 0.8 }
};
const lineStyle = () => LINE_STYLES[prefs.lines] || LINE_STYLES.standard;
L.Path.addInitHook(function () {
  const st = lineStyle(), o = this.options;
  if (st === LINE_STYLES.standard) return;
  if (o.weight) o.weight *= st.w;
  if (o.opacity) o.opacity = Math.min(1, o.opacity * st.o);
  if (this instanceof L.CircleMarker && !(this instanceof L.Circle)) {  // markers (not areas such as countries)
    if (o.fillOpacity) o.fillOpacity = Math.min(1, o.fillOpacity * st.o);
    o.radius *= st.r;
    this._radius = o.radius;
  }
});

// Distances and heights as chosen; everything is kept in km and m
const MILE = 1.609344, FOOT = 0.3048;
const imperial = () => prefs.units === 'mi';
const dist = km => (imperial() ? km / MILE : km);
const DU = () => (imperial() ? 'mi' : 'km');
const fmtDist = (km, digits = 0) => `${(Math.round(dist(km) * 10 ** digits) / 10 ** digits).toLocaleString()} ${DU()}`;
const height = m => (imperial() ? m / FOOT : m);
const HU = () => (imperial() ? 'ft' : 'm');
const fmtHeight = m => `${Math.round(height(m)).toLocaleString()} ${HU()}`;
// The weather on a ride (weather.js on the server, Open-Meteo's history): loaded once, the first time it is wanted
let allWeather = null, weatherAsked = null;
function loadWeather() {
  return weatherAsked = weatherAsked || fetch('/api/weather').then(r => (r.ok ? r.json() : {})).catch(() => ({})).then(w => (allWeather = w));
}
const SKY = [[0, '☀️', 'clear'], [2, '🌤️', 'partly cloudy'], [3, '☁️', 'overcast'], [48, '🌫️', 'fog'], [57, '🌦️', 'drizzle'], [67, '🌧️', 'rain'],
  [77, '🌨️', 'snow'], [82, '🌧️', 'showers'], [86, '🌨️', 'snow showers'], [99, '⛈️', 'thunderstorm']];
const skyOf = code => (code == null ? ['', ''] : (SKY.find(([max]) => code <= max) || SKY[SKY.length - 1]).slice(1));
const fmtTemp = c => (imperial() ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`);
const fmtWind = kmh => (imperial() ? `${Math.round(kmh / MILE)} mph` : `${Math.round(kmh)} km/h`);
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
// "🌤️ 18°C · wind 14 km/h from the SW, gusts 30 · rain 1.2 mm" (short: icon, temperature, wind)
function weatherText(w, short = false) {
  if (!w) return '';
  const [icon, word] = skyOf(w.code);
  const from = w.dir != null ? ` ${short ? '' : 'from the '}${COMPASS[Math.round(w.dir / 45) % 8]}` : '';
  if (short) return `<span title="${word}, ${fmtTemp(w.tmin)} to ${fmtTemp(w.tmax)}, wind ${fmtWind(w.wind)}${from}${w.rain ? `, rain ${w.rain} mm` : ''}">${icon} ${fmtTemp(w.temp)} · 💨 ${fmtWind(w.wind)}${from}</span>`;
  return `${icon} ${word}, ${fmtTemp(w.temp)}${w.tmax - w.tmin >= 2 ? ` (${fmtTemp(w.tmin)}–${fmtTemp(w.tmax)})` : ''} · wind ${fmtWind(w.wind)}${from}` +
    `${w.gust ? `, gusts ${fmtWind(w.gust)}` : ''}${w.rain ? ` · rain ${w.rain} mm` : ''}`;
}

// Stays by kind of bed (/api/stays gives each its kind, stats.js): a legend row each, under Stays; [kind, label, colour,
// ring]: three shades of one family, a bed you paid for filled, a free one (with friends, hosts, in a tent) a ring
const STAY_KINDS = { hotel: ['Hotel and other', '🏨 Hotels and other', '--stay'], friend: ["Friend's place", "🛋️ Friends' places", '--stay', true],
  family: ['Family', '👪 Family', '--stay', true], hostel: ['Hostel', '🛏️ Hostels', '--stay2'], couchsurfing: ['Couchsurfing', '🏄 Couchsurfing', '--stay2', true],
  bewelcome: ['BeWelcome', '🤝 BeWelcome', '--stay2', true], trustroots: ['Trustroots', '🌳 Trustroots', '--stay2', true], airbnb: ['Airbnb', '🏠 Airbnb', '--stay3'], camping: ['Camping', '🏕️ Camping', '--stay3', true] };
const stayKindOf = s => Object.keys(STAY_KINDS).find(k => STAY_KINDS[k][0] === s.kind) || 'hotel';
const stayLayers = Object.fromEntries(Object.keys(STAY_KINDS).map(k => [k, L.layerGroup()]));
const carLayer = L.layerGroup(), photoLayer = L.layerGroup();
const timelineLayer = L.layerGroup(), countryLayer = L.layerGroup(), activityLayer = L.layerGroup(), tileLayer = L.layerGroup();
const climbLayer = L.layerGroup();
let allClimbs = [];  // famous cycling climbs and the rides over them (/api/climbs); none without rides
const cityLayer = L.layerGroup();
const homeLayer = L.layerGroup();  // your places: hometown, where you live, where you work
const checkinLayer = L.layerGroup();  // check-ins, posts with a place, reviews and rides from data downloads
let allCheckins = [];
// Activities by type: a legend row each; the activity layer draws the types whose row is on
const ACT_KINDS = { ride: '🚴 Cycling', run: '🏃 Running', walk: '🥾 Walks & hikes', sport: '🏅 Other sports' };
const kindLayer = Object.fromEntries(Object.keys(ACT_KINDS).map(k => [k, L.layerGroup()]));
const shownKinds = () => Object.keys(ACT_KINDS).filter(k => map.hasLayer(kindLayer[k]));
const canvasRenderer = L.canvas({ padding: 0.5 });  // photos and Timeline can be many thousands of marks

let allStays = [], allPhotos = [], allTimeline = { visits: [], paths: [] }, settings = { home_airports: [] };
let allActivities = [], stravaStatus = {}, explored = null, topCities = [], citiesAsked = '';
let journeys = [];               // trips: from leaving a home airport until coming back
let win = { from: '', to: '' };  // the period shown, 'YYYY-MM-DD' inclusive; empty: everything
let whereMarker = null, visitedCount = 0;

const day = d => (d || '').slice(0, 10);
const inWin = d => !d || ((!win.from || day(d) >= win.from) && (!win.to || day(d) <= win.to));
const overlapsWin = (a, b) => (!win.to || day(a) <= win.to) && (!win.from || day(b || a) >= win.from);
const addDays = (d, n) => new Date(new Date(day(d) + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const nights = s => Math.max(1, Math.round((new Date(s.end || s.start) - new Date(s.start)) / 864e5));

function fmtDate(d) {
  return new Date(day(d) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Legend rows of these layers: [label, layer, colour variable, swatch: a line, or 'dot' for markers, 'area' for areas]
function extraLayers() {
  return {
    ...Object.fromEntries(Object.entries(STAY_KINDS).map(([k, [, label, color, ring]]) => ['stay-' + k, [label, stayLayers[k], color, ring ? 'ring' : 'dot']])),
    car: ['🚗 Rental cars', carLayer, '--car', 'dot'],
    photo: ['📷 Photos', photoLayer, '--photo', 'dot'], timeline: ['🧭 Timeline', timelineLayer, '--timeline', 'dot'],
    ...Object.fromEntries(Object.entries(ACT_KINDS).map(([k, label]) => ['act-' + k, [label, kindLayer[k], '--' + k]])),
    tile: ['🟩 Explored tiles', tileLayer, '--tile', 'area'], climb: ['⛰️ Climbs', climbLayer, '--climb', 'dot'],
    country: ['🌍 Countries', countryLayer, '--country', 'area'], city: ['🏙️ Cities', cityLayer, '--city', 'dot'],
    checkin: ['📍 Check-ins', checkinLayer, '--checkin', 'dot'], home: ['🌱 Your places', homeLayer, '--home', 'dot']
  };
}

function extraCounts() {
  const shown = allStays.filter(s => s.lat != null && overlapsWin(s.start, s.end));
  return {
    stays: shown.filter(s => s.what !== 'car').length, car: shown.filter(s => s.what === 'car').length,
    ...Object.fromEntries(Object.keys(STAY_KINDS).map(k => ['stay-' + k, shown.filter(s => s.what !== 'car' && stayKindOf(s) === k).length])),
    photo: allPhotoPoints?.length && (prefs.photos || 'clusters') !== 'places' ? shownPhotoPoints().length : photoCells().reduce((n, c) => n + c.count, 0),
    timeline: allTimeline.visits.filter(v => overlapsWin(v.start, v.end)).length, country: visitedCount ? `${visitedCount} / ${countryTotal}` : 0,
    ...Object.fromEntries(Object.keys(ACT_KINDS).map(k => ['act-' + k, allActivities.filter(a => a.kind === k && inWin(a.date)).length])),
    tile: explored?.tiles.size ? `${explored.tiles.size.toLocaleString()} · ▢${explored.square.size}` : 0,
    city: topCities.length,
    home: Object.values(settings.home || {}).filter(Boolean).length,
    checkin: allCheckins.filter(c => inWin(new Date(c.t * 1000).toISOString())).length,
    climb: allClimbs.length ? `${allClimbs.filter(climbDone).length} / ${allClimbs.length}` : 0
  };
}

function drawExtras() {
  drawStays();
  drawPhotos();
  drawTimeline();
  drawCheckins();
  drawActivities();
  drawTiles();
  drawCountries();
  drawCities();
  drawClimbs();
  drawHome();
  if (typeof map3d !== 'undefined' && map3d && !document.getElementById('map3d').hidden) refresh3D();  // the 3D view follows
}

// --- long tables: the first rows, and a button for more ---

// Tables under root with headings marked <th data-sort="num"> or "text": a click on one sorts the rows by that column,
// numbers and dates biggest or latest first, text from A, empty cells last; a second click turns it round. A cell's
// data-v is what it is sorted by, else its text. Tables that are also paginated are paginated again from the top.
function sortableTables(root) {
  (typeof root === 'string' ? document.getElementById(root) : root)?.querySelectorAll('table.sp-table').forEach(t => {
    t.querySelectorAll('thead th[data-sort]').forEach(th => th.addEventListener('click', () => {
      const col = [...th.parentNode.children].indexOf(th), num = th.dataset.sort === 'num';
      const desc = th.classList.contains('sort-desc') ? false : th.classList.contains('sort-asc') ? true : num;
      const val = r => { const c = r.cells[col]; const v = c ? (c.dataset.v ?? c.textContent.trim()) : ''; return num ? (v === '' ? NaN : parseFloat(v)) : v; };
      const rows = [...t.tBodies[0].rows].sort((a, b) => {
        const x = val(a), y = val(b), ex = num ? isNaN(x) : !x, ey = num ? isNaN(y) : !y;
        if (ex || ey) return ex - ey;
        const d = num ? x - y : String(x).localeCompare(String(y));
        return desc ? -d : d;
      });
      rows.forEach(r => t.tBodies[0].appendChild(r));
      t.querySelectorAll('thead th').forEach(h => { h.classList.remove('sort-asc', 'sort-desc'); h.removeAttribute('aria-sort'); });
      th.classList.add(desc ? 'sort-desc' : 'sort-asc');
      th.setAttribute('aria-sort', desc ? 'descending' : 'ascending');
      if (t.parentElement.querySelector(':scope > .sp-more')) paginateTables(t.parentElement);
    }));
  });
}

// Every table under root with more than `first` rows shows `first`, then a button that shows `step` more at a time
function paginateTables(root, first = 20, step = 20) {
  (typeof root === 'string' ? document.getElementById(root) : root)?.querySelectorAll('table.sp-table').forEach(t => {
    const rows = [...t.tBodies[0]?.rows || []];
    t.parentElement.querySelectorAll(':scope > .sp-more').forEach(b => b.remove());
    if (rows.length <= first + 5) return;
    let shown = first;
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost sp-more';
    const update = () => {
      rows.forEach((r, i) => { r.hidden = i >= shown; });
      btn.textContent = `Show ${Math.min(step, rows.length - shown)} more (${rows.length - shown} left)`;
      btn.hidden = shown >= rows.length;
    };
    btn.addEventListener('click', () => { shown += step; update(); });
    t.insertAdjacentElement('afterend', btn);
    update();
  });
}

// --- famous cycling climbs ---

// Done in the period shown: a ride over its summit then (all climbs come with the newest 20 of their rides)
const climbDone = c => c.times > 0 && (!win.from && !win.to || c.rides.some(r => inWin(r.date)));

async function loadClimbs() {
  allClimbs = await fetch('/api/climbs').then(r => (r.ok ? r.json() : [])).catch(() => []);
  drawClimbs();
  drawLegend();
  if (document.getElementById('tab-sports')?.classList.contains('active')) renderSports();
  refreshPages();
}

// A trip's or a town's page that opened before the activities and climbs had loaded: drawn again with them
function refreshPages() {
  const open = id => document.getElementById(id)?.classList.contains('active');
  if (open('tab-trip') && typeof tripShown !== 'undefined' && tripShown) renderTrip();
  if (open('tab-city') && typeof cityShown !== 'undefined' && cityShown) renderCityReport();
}

function drawClimbs() {
  climbLayer.clearLayers();
  const color = mapVar('--climb'), ring = mapVar('--surface');
  // the ones not done first, so the done ones are drawn over them
  [...allClimbs].sort((a, b) => climbDone(a) - climbDone(b)).forEach(c => {
    const done = climbDone(c);
    const link = r => `<a href="#" onclick="event.preventDefault(); showActivityOnMap(${r.id})">${fmtDate(r.date)}</a>`;
    const ridden = list => list.filter(r => inWin(r.date));
    // each way up: ✓ with the rides up it, or ✗; then ways up that are not among them ("via Sault")
    const ways = (c.ascents || []).map(a => {
      const r = ridden(a.rides);
      return `${r.length ? '✓' : '✗'} from ${escapeHTML(a.from)} · ${fmtDist(a.length, 1)} · ${fmtHeight(a.gain)} · ${a.grade}%` +
        (r.length ? ` · ${r.length}× ${r.slice(0, 3).map(link).join(', ')}` : '');
    }).concat((c.other || []).map(o => `✓ ${escapeHTML(o.via)}${o.best?.length ? ` · ${fmtDist(o.best.length, 1)}${o.best.gain ? ' · ' + fmtHeight(o.best.gain) : ''}` : ''}` +
      ` · ${ridden(o.rides).length}× ${ridden(o.rides).slice(0, 3).map(link).join(', ')}`));
    const summary = done
      ? `climbed ${c.times} time${c.times !== 1 ? 's' : ''}` + (c.times > 1 ? `, first ${fmtDate(c.first)}` : '') +
        (ways.length ? '' : '<br>' + ridden(c.rides).slice(0, 5).map(r => `${link(r)} · ${escapeHTML(r.name || 'ride')}`).join('<br>'))
      : 'not climbed yet';
    L.circleMarker([c.lat, c.lon], done
      ? { radius: 5.5, color: ring, weight: 1.5, fillColor: color, fillOpacity: 0.95 }
      : { radius: 3.5, color, weight: 1.3, opacity: 0.6, fillOpacity: 0 }
    ).bindPopup(`<b>⛰️ ${flagOf(c.country)}${escapeHTML(c.name)}</b>${c.ele ? ` · ${fmtHeight(c.ele)}` : ''}<br><small>${summary}` +
      (ways.length ? '<br>' + ways.join('<br>') : '') +
      `<br><a href="#climb=${c.id}" class="popup-link" onclick="event.preventDefault(); openClimb('${c.id}')">Open climb page →</a>` + '</small>', { maxWidth: 320 })
      .addTo(climbLayer);
    // the ways up you rode, as lines: the worked-out ones, and your own (from your track) for the others
    (c.ascents || []).filter(a => ridden(a.rides).length).forEach(a => {
      L.polyline(decodePath(a.path), { color, weight: 4, opacity: 0.85, interactive: false }).addTo(climbLayer);
    });
    (c.other || []).filter(o => o.path && ridden(o.rides).length).forEach(o => {
      L.polyline(decodePath(o.path), { color, weight: 4, opacity: 0.85, interactive: false }).addTo(climbLayer);
    });
  });
}

// --- stays and rental cars ---

// Stays of one kind at the same spot are one marker (a booking email gives only the town, so every hotel in Brussels lands on
// Brussels): its size follows the nights there, its popup lists each stay, newest first
function drawStays() {
  Object.values(stayLayers).forEach(l => l.clearLayers());
  carLayer.clearLayers();
  const spots = new Map();
  allStays.filter(s => s.lat != null && overlapsWin(s.start, s.end)).forEach(s => {
    const key = `${s.what === 'car' ? 'car' : stayKindOf(s)}|${s.lat.toFixed(4)},${s.lon.toFixed(4)}`;
    if (!spots.has(key)) spots.set(key, []);
    spots.get(key).push(s);
  });
  spots.forEach(list => {
    list.sort((a, b) => b.start.localeCompare(a.start));
    const s = list[0], car = s.what === 'car', [, , shade, ring] = car ? [] : STAY_KINDS[stayKindOf(s)], color = mapVar(car ? '--car' : shade);
    const total = list.reduce((t, x) => t + nights(x), 0);
    const count = n => (car ? `${n} day${n !== 1 ? 's' : ''}` : `${n} night${n !== 1 ? 's' : ''}`);
    const line = x => `${fmtDate(x.start)} – ${fmtDate(x.end || x.start)} · ${count(nights(x))}` +
      `${x.hotel ? ' · ' + escapeHTML(x.hotel) : ''}${!car && x.type ? ' · ' + escapeHTML(x.type) : ''}${x.price ? ' · ' + escapeHTML(x.price) : ''}${x.provider ? ' · ' + escapeHTML(x.provider) : ''}`;
    const head = list.length > 1
      ? `${car ? '🚗 Rental cars' : '🏨 Stays'}, ${escapeHTML(s.place)}</b><br><small>${list.length} ${car ? 'rentals' : 'stays'}, ${count(total)}</small>`
      : `${car ? '🚗 Rental car' : '🏨 ' + escapeHTML(s.type || 'Stay')}, ${escapeHTML(s.place)}</b>`;
    const lines = list.slice(0, 20).map(line).join('<br>') + (list.length > 20 ? `<br>and ${list.length - 20} more` : '');
    L.circleMarker([s.lat, s.lon], {
      // small and half see-through, so routes and places show through; an invisible ring keeps them easy to click (a
      // free bed's ring is drawn, a little bigger so it reads as one)
      radius: car ? Math.min(3 + (list.length - 1) * 0.5, 5) : Math.min(2.5 + Math.sqrt(total) * 0.8, 7) + (ring ? 1 : 0),
      color, opacity: ring ? 0.9 : 0, weight: ring ? 2 : 8, fillColor: color, fillOpacity: ring ? 0.08 : 0.55
    }).bindPopup(`<b>${head}<br><small>${lines}</small>`, { maxWidth: 300 }).addTo(car ? carLayer : stayLayers[stayKindOf(s)]);
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

// Every photo (/api/photos/points: [id, unix time, lat, lon, video]), loaded once when the layer is first drawn.
// As chosen in the settings: grouped into clusters (a photo: its thumbnail, a click away from the whole photo), a
// heatmap, or the older places (counts per place, from the photo places import). Without the index: the places.
let allPhotoPoints = null, photoPointsAsked = null;
const photoDay = p => new Date(p[1] * 1000).toISOString().slice(0, 10);

// the photo index, asked once; resolves when it is there
function loadPhotoPoints() {
  return photoPointsAsked = photoPointsAsked || fetch('/api/photos/points').then(r => (r.ok ? r.json() : [])).catch(() => []).then(list => {
    allPhotoPoints = list;
    drawPhotos();
    drawLegend();
  });
}

// p: [id, time, lat, lon, video, how] (how: 'a' placed by its album, 'y' and only its year known)
function photoPopup(p) {
  const when = new Date(p[1] * 1000);
  const date = p[5] === 'y' ? `${when.getUTCFullYear()}` : `${fmtDate(photoDay(p))} ${when.toISOString().slice(11, 16)} UTC`;
  return `<div class="photo-pop"><a href="/api/photos/${p[0]}/full" target="_blank" rel="noopener" title="Open the whole ${p[4] ? 'video' : 'photo'}">` +
    `<img src="/api/photos/${p[0]}/thumb" alt="" loading="lazy" width="240"></a><br><small>${p[4] ? '🎬 ' : '📷 '}` +
    `${date}${p[5] ? ' · placed by its album' : ''} · <a href="/api/photos/${p[0]}/full" target="_blank" rel="noopener">open ${p[4] ? 'video' : 'full size'}</a></small></div>`;
}

let heatLoading = null;
function loadHeat() {  // leaflet.heat, the first time a heatmap is drawn
  if (window.L?.heatLayer) return Promise.resolve();
  return heatLoading = heatLoading || new Promise(resolve => {
    const js = document.createElement('script');
    js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.heat/0.2.0/leaflet-heat.js';
    js.onload = resolve;
    document.head.appendChild(js);
  });
}

function shownPhotoPoints() {
  return (allPhotoPoints || []).filter(p => inWin(photoDay(p)));
}

function drawPhotos() {
  photoLayer.clearLayers();
  const color = mapVar('--photo'), mode = prefs.photos || 'clusters';
  if (mode !== 'places' && allPhotoPoints === null) loadPhotoPoints();
  if (mode === 'places' || !allPhotoPoints?.length) {  // counts per place (imports/photos.py without --points)
    photoCells().forEach(c => {
      const days = c.days.sort();
      L.circleMarker([c.lat, c.lon], {
        renderer: canvasRenderer, radius: Math.min(2 + Math.sqrt(c.count) * 0.6, 12), color, fillColor: color,
        fillOpacity: 0.45, weight: 0.5
      }).bindPopup(`<b>📷 ${c.count.toLocaleString()} photo${c.count !== 1 ? 's' : ''}</b><br>` +
        `<small>${days.length} day${days.length !== 1 ? 's' : ''}: ${fmtDate(days[0])}${days.length > 1 ? ' – ' + fmtDate(days[days.length - 1]) : ''}</small>`)
        .addTo(photoLayer);
    });
    return;
  }
  const pts = shownPhotoPoints();
  if (mode === 'heat') {
    loadHeat().then(() => {
      if ((prefs.photos || 'clusters') !== 'heat') return;
      photoLayer.clearLayers();
      L.heatLayer(pts.map(p => [p[2], p[3], 1]), { radius: 14, blur: 18, minOpacity: 0.35, maxZoom: 12,
        gradient: { 0.2: '#0e7490', 0.5: '#22d3ee', 0.8: '#a5f3fc', 1: '#ffffff' } }).addTo(photoLayer);
    });
    return;
  }
  // clusters: a number per group, photos one by one when zoomed in; added in chunks so 80,000 do not stall the page
  const group = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false, maxClusterRadius: 45,
    iconCreateFunction: c => L.divIcon({ html: `<span>${c.getChildCount().toLocaleString()}</span>`, className: 'photo-cluster', iconSize: [34, 34] }) });
  const icon = L.divIcon({ className: 'photo-dot', iconSize: [10, 10] });
  group.addLayers(pts.map(p => L.marker([p[2], p[3]], { icon }).bindPopup(() => photoPopup(p), { maxWidth: 260, minWidth: 240 })));
  photoLayer.addLayer(group);
}

// --- Google Timeline ---

function drawTimeline() {
  timelineLayer.clearLayers();
  const color = mapVar('--timeline');
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

// Places you were at a known time from your data downloads (imports/checkins.py): Facebook and VK check-ins and
// posts, Instagram posts, Google Maps reviews, Uber and Bolt pick-ups and drop-offs
const CHECKIN_ICON = { facebook: '📘', instagram: '📸', vk: '💬', 'google reviews': '⭐', uber: '🚕', bolt: '🚕' };
function drawCheckins() {
  checkinLayer.clearLayers();
  const color = mapVar('--checkin');
  allCheckins.filter(c => inWin(new Date(c.t * 1000).toISOString())).forEach(c => {
    const when = new Date(c.t * 1000);
    L.circleMarker([c.lat, c.lon], { renderer: canvasRenderer, radius: 4, color: mapVar('--surface'), weight: 1, fillColor: color, fillOpacity: 0.9 })
      .bindPopup(`<b>${CHECKIN_ICON[c.source] || '📍'} ${escapeHTML(c.name || (c.kind === 'ride' ? 'Ride' : 'Here'))}</b><br><small>${escapeHTML(c.source)} ${escapeHTML(c.kind || '')} · ` +
        `${fmtDate(when.toISOString())} ${when.toISOString().slice(11, 16)} UTC</small>`)
      .addTo(checkinLayer);
  });
}

// --- Strava activities and the tiles they explored ---
// Made for thousands of activities: they load after the rest of the map; each route is decoded once; routes and
// explored tiles are painted on canvas map tiles, only where the map is in view (never one map object per activity);
// and the explored tiles of each activity come worked out from Cairn.

const SPORTS = {
  ride: /Ride|Velomobile|Handcycle|Wheelchair/, run: /Run/, walk: /Walk|Hike|Snowshoe/
};
const sportOf = s => Object.keys(SPORTS).find(k => SPORTS[k].test(s || '')) || 'sport';
const sportEmoji = { ride: '🚴', run: '🏃', walk: '🥾', sport: '🏅' };
// Explored tiles are map tiles at zoom 14 (statshunters' tiles, ~1.5 km in the Netherlands) or 17 (squadratinhos,
// ~200 m), as chosen in the settings; packed as x * TILES + y
let TILE_Z = prefs.tileZoom, TILES = 2 ** TILE_Z;

// An activity's tiles at the chosen zoom: Cairn's (zoom 14), else from its route, once (a point every quarter tile)
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
    ctx.lineWidth = (z < 9 ? 1 : z < 13 ? 1.6 : 2.4) * lineStyle().w;
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.globalAlpha = Math.min(1, 0.75 * lineStyle().o);
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
  ctx.strokeStyle = mapVar('--tile');
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
    const ctx = c.getContext('2d'), color = mapVar('--tile');
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
  add3DControl();
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
    L.polyline(pts, { color: mapVar('--text'), weight: 7, opacity: 0.9, interactive: false }),
    L.polyline(pts, { color: mapVar('--' + a.kind), weight: 4, opacity: 1, interactive: false })
  ]).addTo(map);
  if (!allWeather && a.kind === 'ride') loadWeather().then(w => {  // the first ride clicked: its weather when it comes
    const el = document.querySelector('.leaflet-popup .act-weather');
    if (el && w[a.id]) el.innerHTML = '<br>' + weatherText(w[a.id]);
  });
  L.popup({ maxWidth: 260 }).setLatLng(ll).setContent(`<b>${sportEmoji[a.kind]} ${escapeHTML(a.name)}</b><br>` +
    `<small>${escapeHTML(a.sport)} · ${fmtDate(a.date)} · ${fmtDist(a.distance, 1)}` +
    `${a.elevation ? ` · ↑${fmtHeight(a.elevation)}` : ''}</small><small class="act-weather">${allWeather?.[a.id] ? '<br>' + weatherText(allWeather[a.id]) : ''}</small>`).on('remove', () => {
    if (activityHighlight) map.removeLayer(activityHighlight);
    activityHighlight = null;
  }).openOn(map);
}

let kindsDrawn = '';
function drawActivities() {
  const kinds = shownKinds();
  kindsDrawn = kinds.join();
  actShown = allActivities.filter(a => a.pts && inWin(a.date) && kinds.includes(a.kind));
  actColors = Object.fromEntries(Object.keys(ACT_KINDS).map(k => [k, mapVar('--' + k)]));
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
  // the tiles of the types shown: cycling alone, running alone, or together; with no type shown, of them all (the tiles
  // without the lines)
  const kinds = shownKinds().length ? shownKinds() : Object.keys(ACT_KINDS);
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
  L.rectangle([[tileLat(y + size), tileLon(x)], [tileLat(y), tileLon(x + size)]], { color: mapVar('--text'), weight: 2, fill: false, dashArray: '6 4' })
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
  loadClimbs();
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
    const ll = [p.coords.latitude, p.coords.longitude], acc = Math.round(p.coords.accuracy), color = mapVar('--accent');
    if (meLayer) map.removeLayer(meLayer);
    meLayer = L.layerGroup([
      L.circle(ll, { radius: acc, color, weight: 1, fillOpacity: 0.08, interactive: false }),
      L.circleMarker(ll, { radius: 7, color: mapVar('--surface'), weight: 2, fillColor: color, fillOpacity: 1 })
        .bindPopup(`<b>You are here</b><br><small>to within ${acc.toLocaleString()} m</small>`)
    ]).addTo(map);
    map.setView(ll, Math.max(map.getZoom(), acc > 2000 ? 11 : 14));
  }, err => toast(err.code === 1 ? 'Location not allowed: allow it for this page in the browser' : 'Could not find where you are', 'error'),
  { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

// --- most visited cities ---

const flagOf = cc => /^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) + ' ' : '';

// Cairn counts the days per town (cities.js); asked again when the period changes, drawn when the answer comes
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
  const color = mapVar('--city'), most = topCities[0]?.days || 1;
  topCities.forEach((c, i) => {
    const m = L.circleMarker([c.lat, c.lon], {
      radius: 3 + 11 * Math.sqrt(c.days / most), color, weight: 1.5, fillColor: color, fillOpacity: 0.35
    }).bindPopup(`<b>🏙️ ${flagOf(c.country)}${escapeHTML(c.name)}</b> · #${i + 1}<br><small>${c.days} day${c.days !== 1 ? 's' : ''}, ` +
      `${c.visits} visit${c.visits !== 1 ? 's' : ''} · ${fmtDate(c.first)} – ${fmtDate(c.last)}</small>` +
      (c.id ? `<br><a href="#city=${c.id}" class="popup-link" onclick="event.preventDefault(); openCityReport(${c.id})">Open report →</a>` : ''));
    if (i < 10 && !homeIds().has(c.id)) m.bindTooltip(`${i + 1}. ${escapeHTML(c.name)}`, { permanent: true, direction: 'right', className: 'city-label', offset: [6, 0] });
    m.addTo(cityLayer);
  });
}

// --- picking a town by name ---

// Suggestions as you type a town's name (GeoNames, the biggest first) in a list after the input (made if missing);
// onPick(town { id, name, cc, lat, lon, pop }) when one is chosen (click or Enter), onType() on every key typed
function attachTownPicker(input, { onPick, onType = () => {} }) {
  let list = input.nextElementSibling;
  if (!list || !list.classList.contains('place-list')) {
    list = Object.assign(document.createElement('div'), { className: 'place-list', hidden: true });
    input.insertAdjacentElement('afterend', list);
    input.parentElement.classList.add('place-pick');
  }
  let found = [], on = -1, timer = null, asked = '';
  const paint = () => {
    list.innerHTML = found.map((t, i) => `<div data-i="${i}" class="${i === on ? 'on' : ''}">${flagOf(t.cc)}${escapeHTML(t.name)}, ${t.cc}` +
      `<small>${t.pop >= 1e6 ? (t.pop / 1e6).toFixed(1) + 'M' : t.pop >= 1e3 ? Math.round(t.pop / 1e3) + 'k' : t.pop}</small></div>`).join('');
    list.hidden = !found.length;
  };
  const pick = t => { input.value = `${t.name}, ${t.cc}`; found = []; paint(); onPick(t); };
  input.addEventListener('input', () => {
    onType();
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { found = []; return paint(); }
    timer = setTimeout(async () => {
      asked = q;
      const got = await fetch('/api/towns?q=' + encodeURIComponent(q)).then(r => (r.ok ? r.json() : [])).catch(() => []);
      if (asked !== input.value.trim()) return;  // typed on meanwhile
      found = got; on = got.length ? 0 : -1; paint();
    }, 150);
  });
  input.addEventListener('keydown', e => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); on = (on + (e.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length; paint(); }
    else if (e.key === 'Enter' && found[on]) { e.preventDefault(); pick(found[on]); }
    else if (e.key === 'Escape') { e.stopPropagation(); found = []; paint(); }
  });
  list.addEventListener('mousedown', e => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); pick(found[+d.dataset.i]); } });
  input.addEventListener('blur', () => { found = []; paint(); });
}

// --- your places ---

// The hometown, where you live and where you work (set in the settings), above everything else: the hometown
// bigger, with a halo; one town in several roles gets one mark
const HOME_ROLE = { hometown: ['🌱', 'Hometown', 'Your hometown'], residence: ['🏠', 'Home', 'Where you live'], work: ['💼', 'Work', 'Where you work'] };
const homeIds = () => new Set(Object.values(settings.home || {}).filter(Boolean).map(t => t.id));  // their town keeps only this label
function drawHome() {
  homeLayer.clearLayers();
  if (!map.getPane('home')) map.createPane('home').style.zIndex = 640;  // over the markers, under the popups
  map.getPane('home').dataset.theme = mapTone();
  const byTown = new Map();
  Object.entries(settings.home || {}).forEach(([role, t]) => {
    if (!t || !HOME_ROLE[role]) return;
    if (!byTown.has(t.id)) byTown.set(t.id, { town: t, roles: [] });
    byTown.get(t.id).roles.push(role);
  });
  byTown.forEach(({ town, roles }) => {
    const size = 28, wide = size + (roles.length - 1) * 18;  // one emoji a role
    const icon = L.divIcon({ className: '', iconSize: [wide, size], iconAnchor: [wide / 2, size / 2],
      html: `<div class="home-pin" style="width:${wide}px">${roles.map(r => HOME_ROLE[r][0]).join('')}</div>` });
    L.marker([town.lat, town.lon], { icon, pane: 'home', zIndexOffset: 1000, keyboard: false })
      .bindTooltip(`${roles.map(r => HOME_ROLE[r][1]).join(' · ')}: ${escapeHTML(town.name)}`, { permanent: true, direction: 'right', offset: [wide / 2 + 2, 0], className: 'home-label', pane: 'home' })
      .bindPopup(`<b>${roles.map(r => HOME_ROLE[r][0]).join('')} ${flagOf(town.cc)}${escapeHTML(town.name)}</b><br><small>${roles.map(r => HOME_ROLE[r][2]).join(', ')}</small>` +
        `<br><a href="#city=${town.id}" class="popup-link" onclick="event.preventDefault(); openCityReport(${town.id})">Open report →</a>`)
      .addTo(homeLayer);
  });
}

// --- countries visited ---

// The countries of the list chosen in the settings (ISO codes, sovereign countries, or the Travelers' Century Club's
// 330 places) you were in during the period, by any source. The server puts each place in its state or province
// (regions.js), so islands and parts of countries count as the list has them.
const COUNTRY_LISTS = { iso: 'ISO countries and territories', un: 'Sovereign countries', tcc: "Travelers' Century Club" };
const countryData = new Map();  // address -> the server's answer, or the request for it
let countryTotal = 0;
const countryUrl = () => `/api/regions?scheme=${prefs.countries}&from=${win.from}&to=${win.to}`;

function drawCountries() {
  const url = countryUrl(), got = countryData.get(url);
  if (!got) {
    countryData.set(url, fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null).then(d => {
      countryData.set(url, d || { places: [], total: 0 });
      if (countryUrl() === url) { drawCountries(); drawLegend(); }
    }));
    return;
  }
  if (got instanceof Promise) return;
  countryLayer.clearLayers();
  visitedCount = got.places.length;
  countryTotal = got.total;
  const color = mapVar('--country');
  got.places.forEach(c => {
    const flag = String(c.id).length === 2 ? flagOf(c.id) : '';
    L.geoJSON(c.shape, { style: { stroke: false, fillColor: color, fillOpacity: /^grey/.test(prefs.basemap) ? 0.08 : 0.18, fillRule: 'nonzero', className: 'country-fill' } })
      .bindPopup(`<b>🌍 ${flag}${escapeHTML(c.name)}</b><br><small>${c.region ? escapeHTML(c.region.toLowerCase().replace(/\b\w/g, l => l.toUpperCase())) + '<br>' : ''}` +
        `${c.days} day${c.days !== 1 ? 's' : ''}${win.from || win.to ? ' in this period' : ''}, first ${fmtDate(c.first)}` +
        `${c.last !== c.first ? ', last ' + fmtDate(c.last) : ''}<br>${COUNTRY_LISTS[prefs.countries]}: ${visitedCount} of ${countryTotal}</small>` +
        (/^[A-Z]{2}$/.test(c.id) ? `<br><a href="#country=${c.id}" class="popup-link" onclick="event.preventDefault(); openCountry('${c.id}')">Country page →</a>` : ''))
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
  // the trips Cairn finds in all its data (trips.js), when they have loaded: the map's trip choice lists them instead
  if (typeof loadTrips === 'function') loadTrips().then(list => {
    const sel = document.getElementById('p-trip');
    if (!list.length || sel?.value) return;  // (not while a flight-made trip is chosen)
    journeys = list.map(t => ({ start: t.start, end: t.end, name: t.name, id: t.id }));
    if (sel) sel.innerHTML = `<option value="">all trips</option>` +
      journeys.map((j, i) => `<option value="${i}">${j.start.slice(0, 7)} · ${escapeHTML(j.name)}</option>`).join('');
  });
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
      const box = L.DomUtil.create('div', 'map-legend map-period foldable');
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      box.addEventListener('click', e => { if (e.target.closest('.panel-toggle')) box.classList.toggle('open'); });  // on a phone
      const ys = years(), opt = (v, t) => `<option value="${v}">${t}</option>`;
      box.innerHTML = '<button class="panel-toggle" type="button">Period ▾</button>' +
        `<label>Years <select id="p-from">${opt('', 'first')}${ys.map(y => opt(y, y)).join('')}</select>` +
        `– <select id="p-to">${opt('', 'last')}${ys.map(y => opt(y, y)).join('')}</select></label>` +
        `<label>Trip <select id="p-trip">${opt('', 'all trips')}` +
        journeys.map((j, i) => opt(i, `${j.start.slice(0, 7)} · ${escapeHTML(j.name)}`)).join('') + `</select>` +
        ` <a href="#" id="p-trip-open" hidden title="The trip's page">page →</a></label>` +
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
    $('p-trip-open').hidden = !j?.id;
    redrawMap();
    const b = j && windowBounds();
    if (b) map.fitBounds(b, { padding: [40, 40], maxZoom: 9 });
  });
  $('p-trip-open').addEventListener('click', e => {
    e.preventDefault();
    const j = journeys[$('p-trip').value];
    if (j?.id) openTrip(j.id);
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
  whereMarker = L.circleMarker(spot, { radius: 9, color: mapVar('--text'), weight: 2, fillColor: mapVar('--accent2'), fillOpacity: 0.9 })
    .bindPopup(`<b>${fmtDate(d)}</b><br>${lines.join('<br>')}`, { maxWidth: 280 }).addTo(map);
  map.setView(spot, Math.max(map.getZoom(), 6));
  whereMarker.openPopup();
}
