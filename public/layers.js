'use strict';
// The map besides flights and ground trips: stays and rental cars (from flightmail), photos and Google Timeline (from
// imports/), the countries visited, trips, a time window over everything, and "where was I on" a day.
// Loaded before the page's own script; uses its globals (map, allFlights, allAirports, allTrips, ...) when called.

const COUNTRIES_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';
const stayLayer = L.layerGroup(), carLayer = L.layerGroup(), photoLayer = L.layerGroup();
const timelineLayer = L.layerGroup(), countryLayer = L.layerGroup();
const canvasRenderer = L.canvas({ padding: 0.5 });  // photos and Timeline can be many thousands of marks

let allStays = [], allPhotos = [], allTimeline = { visits: [], paths: [] }, settings = { home_airports: [] };
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
    country: ['🌍 Countries', countryLayer, '--country']
  };
}

function extraCounts() {
  const shown = allStays.filter(s => s.lat != null && overlapsWin(s.start, s.end));
  return {
    stay: shown.filter(s => s.what !== 'car').length, car: shown.filter(s => s.what === 'car').length,
    photo: photoCells().reduce((n, c) => n + c.count, 0),
    timeline: allTimeline.visits.filter(v => overlapsWin(v.start, v.end)).length, country: visitedCount
  };
}

function drawExtras() {
  drawStays();
  drawPhotos();
  drawTimeline();
  drawCountries();
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
  return pts;
}

function ringsOf(g) {
  return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
}

function inShape(shape, lat, lon) {
  const [w, s, e, n] = shape.bbox;
  if (lon < w || lon > e || lat < s || lat > n) return false;
  let inside = false;
  for (const poly of shape.polys) for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// The country of a point; a point just off the coast (a port, an airport on the shore) takes the nearest one
const countryCache = new Map();
function countryAt(lat, lon) {
  const key = lat.toFixed(2) + ',' + lon.toFixed(2);
  if (!countryCache.has(key)) {
    let hit = null;
    for (const d of [0, 0.05, 0.15]) {
      for (const [dy, dx] of d ? [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]] : [[0, 0]]) {
        hit = countryShapes.find(c => inShape(c, lat + dy, lon + dx));
        if (hit) break;
      }
      if (hit) break;
    }
    countryCache.set(key, hit);
  }
  return countryCache.get(key);
}

async function loadCountries() {
  const topo = await fetch(COUNTRIES_URL).then(r => r.json());
  countryShapes = topojson.feature(topo, topo.objects.countries).features.map(f => {
    const polys = ringsOf(f.geometry), xs = [], ys = [];
    polys.forEach(p => p.forEach(r => r.forEach(([x, y]) => { xs.push(x); ys.push(y); })));
    return { name: f.properties.name, feature: f, polys, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
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
  allPhotos.forEach(c => ys.add(c.year)); allTimeline.paths.forEach(p => add(p.date));
  return [...ys].sort();
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
        `<label>Where on <input type="date" id="p-day"></label>`;
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
