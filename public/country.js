'use strict';
// A country's page: opened from a country on the map, the Stats tab's table, a town or a trip (or #country=<ISO code>),
// with its flag (flagcdn.com), its days and visits, its towns, the trips that went there, flights in and out, trains,
// buses and ferries, stays, the famous climbs in it you rode, and the music you played there; a map of its outline with
// all of these on it, as on a town's page. All time (the server's /api/country/:cc). Uses the page's and layers.js's globals.

let countryShown = null, countryMap = null;
const countryNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch (_) { return null; } })();
const countryName = cc => { try { return countryNames?.of(cc) || cc; } catch (_) { return cc; } };
const countryLink = (cc, text) => `<a href="#country=${cc}" class="sp-link inline" onclick="event.preventDefault(); openCountry('${cc}')">${text || `${flagOf(cc)}${escapeHTML(countryName(cc))}`}</a>`;

let countryAsked = 0;
async function openCountry(cc) {
  cc = String(cc || '').toUpperCase();
  const asked = ++countryAsked;
  const d = await fetch(`/api/country/${cc}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (asked !== countryAsked) return;  // another was asked for meanwhile
  if (!d) return toast(`No page for ${cc}`, 'error');
  countryShown = d;
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-country').classList.add('active');
  if (location.hash !== `#country=${cc}`) history.replaceState(null, '', `#country=${cc}`);
  renderCountry();
  window.scrollTo(0, 0);
}

function closeCountry(toCountry = false) {
  history.replaceState(null, '', location.pathname + location.search);
  document.querySelector('.tab[data-tab="map"]').click();
  if (toCountry && countryShown?.shape) setTimeout(() => map.fitBounds(L.geoJSON(countryShown.shape).getBounds(), { padding: [20, 20] }), 80);
}

function renderCountry() {
  const d = countryShown;
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n !== 1 ? 's' : ''}`;
  const range = (a, b) => (b && b !== a ? `${fmtDate(a)} – ${fmtDate(b)}` : fmtDate(a));
  document.getElementById('country-title').innerHTML = `<img class="page-flag" src="https://flagcdn.com/h40/${d.cc.toLowerCase()}.png" alt="" ` +
    `onerror="this.remove()">${escapeHTML(d.name || countryName(d.cc))}`;
  document.getElementById('country-sub').textContent = d.days ? `first ${fmtDate(d.first)}, last ${fmtDate(d.last)} · all time` : 'no days there yet';
  const card = (label, value, sub = '') => (!value || value === '0' ? '' : `<div class="stat-card"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`);
  const section = (title, body, note = '') => `<div class="chart-section"><h3>${title}</h3><div class="sp-scroll">${body}</div>${note ? `<p class="sp-note">${note}</p>` : ''}</div>`;
  const table = (head, rows) => `<table class="sp-table"><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  const stays = d.stays.filter(s => s.what !== 'car');
  let html = '<div class="chart-section" style="padding:0;overflow:hidden"><div id="country-map" class="mini-map" style="height:380px"></div></div>' +
    '<div class="stat-cards">' +
    card('Days', d.days.toLocaleString(), plural(d.visits.length, 'visit')) +
    card('Towns', d.towns.length.toLocaleString(), d.towns.slice(0, 3).map(t => escapeHTML(t.name)).join(', ')) +
    card('Trips', d.trips.length.toLocaleString()) +
    card('Flights', d.flights.length.toLocaleString(), `${d.flights.filter(f => f.direction === 'in').length} in, ${d.flights.filter(f => f.direction === 'out').length} out`) +
    card('Trains, buses, ferries', d.ground.length.toLocaleString()) +
    card('Nights in stays', stays.reduce((n, s) => n + nights(s), 0).toLocaleString(), plural(stays.length, 'stay')) +
    card('Activities', d.activities.count.toLocaleString(), fmtDist(d.activities.km)) +
    card('Photos', d.photos.toLocaleString()) +
    card('Famous climbs', d.climbs.total ? `${d.climbs.done.length} / ${d.climbs.total}` : '', 'ridden') + '</div>';
  if (d.towns.length) {
    html += section('Towns', table('<th data-sort="text">Town</th><th data-sort="num" class="sort-desc" aria-sort="descending">Days</th><th data-sort="num">Visits</th><th data-sort="num">First</th><th data-sort="num">Last</th>',
      d.towns.map(t => `<tr><td data-v="${escapeHTML(t.name)}"><a href="#city=${t.id}" class="sp-link inline" onclick="event.preventDefault(); openCityReport(${t.id})">${escapeHTML(t.name)}</a></td>` +
        `<td data-v="${t.days}">${t.days}</td><td data-v="${t.visits}">${t.visits}</td><td data-v="${Date.parse(t.first)}">${fmtDate(t.first)}</td><td data-v="${Date.parse(t.last)}">${fmtDate(t.last)}</td></tr>`)),
      "A day counts in a town as on the map's Cities. Click a heading to sort.");
  }
  if (d.trips.length) {
    html += section('Trips', table('<th>When</th><th>Trip</th><th>Days</th><th>Here</th>', d.trips.map(t =>
      `<tr><th>${range(t.start, t.end)}</th><td>${t.countries.map(c => flagOf(c.cc).trim()).join(' ')} ${tripLink(t)}</td><td>${t.days}</td><td>${t.here}</td></tr>`)));
  }
  if (d.visits.length) {
    html += section('Visits', table('<th>When</th><th>Days</th>', d.visits.map(v => `<tr><th>${range(v.start, v.end)}</th><td>${v.days}</td></tr>`)),
      'A visit is a run of days in a row there.');
  }
  if (d.flights.length) {
    html += section('Flights', table('<th>When</th><th>Flight</th><th>Route</th><th></th>', d.flights.map(f =>
      `<tr><th>${fmtDate(f.date)}</th><td><b>${escapeHTML(f.flight_number || '')}</b><small>${escapeHTML(f.airline || '')}</small></td>` +
      `<td>${airportLink(f.from)} → ${airportLink(f.to)}<small>${escapeHTML(f.from_city || '')} → ${escapeHTML(f.to_city || '')}</small></td><td>${f.direction}</td></tr>`)));
  }
  if (d.ground.length) {
    const when = g => (g.approx === 'year' ? escapeHTML(g.date.slice(0, 4)) : g.approx === 'month' ? escapeHTML(g.date.slice(0, 7)) : fmtDate(g.date));
    html += section('Trains, buses and ferries', table(`<th>When</th><th></th><th>Route</th><th>${DU()}</th>`, d.ground.map(g =>
      `<tr><th>${when(g)}</th><td>${(groundModes[g.mode] || '🚌').split(' ')[0]}</td><td>${escapeHTML(g.from)} → ${escapeHTML(g.to)}</td>` +
      `<td>${g.distance ? Math.round(dist(g.distance)).toLocaleString() : ''}</td></tr>`)));
  }
  if (d.stays.length) {
    html += section('Stays and rental cars', table('<th>When</th><th>Nights</th><th>Where</th><th>Booked</th>', d.stays.map(s =>
      `<tr><th>${s.what === 'car' ? '🚗' : '🏨'} ${range(s.start, s.end)}</th><td>${nights(s)}${awayNote(s)}</td>` +
      `<td><b>${escapeHTML(s.hotel || s.type || (s.what === 'car' ? 'Rental car' : 'Stay'))}</b><small>${escapeHTML(s.place || '')}</small></td><td>${escapeHTML(s.provider || '')}</td></tr>`)));
  }
  if (d.climbs.done.length) {
    html += section(`Famous climbs ridden · ${d.climbs.done.length} of ${d.climbs.total}`, table('<th>Climb</th><th>Height</th><th>Times</th>', d.climbs.done.map(c =>
      `<tr><td><a href="#climb=${c.id}" class="sp-link inline" onclick="event.preventDefault(); openClimb('${c.id}')">${escapeHTML(c.name)}</a></td><td>${c.ele ? fmtHeight(c.ele) : ''}</td><td>${c.times}</td></tr>`)));
  }
  if (d.music?.plays) html += musicSection(d.music, 'Music played here', 'What you played on Last.fm on your days here');
  document.getElementById('country-body').innerHTML = html;
  hookLinks('country-body');
  sortableTables('country-body');
  paginateTables('country-body');
  drawCountryMap(d);
}

function drawCountryMap(d) {
  if (countryMap) { try { countryMap.remove(); } catch (_) { /* never fully drawn */ } countryMap = null; }
  const box = document.getElementById('country-map');
  box.dataset.basemap = BASEMAPS[prefs.basemap] ? prefs.basemap : 'auto';
  countryMap = L.map(box, { zoomControl: true, attributionControl: true, preferCanvas: true });  // canvas: a country's thousands of tracks
  toneMap(countryMap);
  const b = BASEMAPS[prefs.basemap] || BASEMAPS.auto, [url, attribution, maxZoom = 19] = b.tiles;
  L.tileLayer(url, { attribution, maxZoom }).addTo(countryMap);
  const st = lineStyle(), col = k => mapVar('--' + k);
  // the view first (shapes can only be clipped to a map that has one): the country's outline, else its towns
  const outline = d.shape ? L.geoJSON(d.shape, { style: { color: col('country'), weight: 1.5, fillColor: col('country'), fillOpacity: 0.12 }, interactive: false }) : null;
  const bounds = outline?.getBounds();
  if (bounds && bounds.isValid()) countryMap.fitBounds(bounds, { padding: [16, 16] });
  else if (d.towns.length) countryMap.fitBounds(d.towns.map(t => [t.lat, t.lon]), { padding: [24, 24], maxZoom: 9 });
  else countryMap.setView([20, 0], 2);
  if (outline) outline.addTo(countryMap);
  // as on a town's page: sports activities, trains, buses and ferries, stays and rental cars, airports, climbs and
  // photos, each a layer that can be switched off
  const layers = {}, layer = (name, list) => { if (list.length) layers[name] = L.layerGroup(list).addTo(countryMap); };
  const acts = new Set(d.activities.ids || []);
  layer('🏃 Sports activities', allActivities.filter(a => acts.has(a.id) && a.pts).map(a => {
    const pts = [];
    for (let i = 0; i < a.pts.length; i += 2) pts.push([a.pts[i], a.pts[i + 1]]);
    return L.polyline(pts, { color: col(a.kind || 'sport'), weight: 2 * st.w, opacity: Math.min(1, 0.7 * st.o) })
      .bindPopup(`<b>${escapeHTML(a.name || a.sport || '')}</b><br><small>${fmtDate(a.date)}</small><br><a href="#" onclick="event.preventDefault(); showActivityOnMap(${a.id})">Show on the big map →</a>`);
  }));
  const ground = new Set(d.ground.map(g => g.id));
  layer('🚆 Trains, buses, ferries', allTrips.filter(g => ground.has(g.id) && g.from_lat != null && g.to_lat != null).map(g =>
    L.polyline(g.path ? decodePath(g.path) : [[g.from_lat, g.from_lon], [g.to_lat, g.to_lon]],
      { color: col(g.mode in { train: 1, bus: 1, ferry: 1, hitch: 1 } ? g.mode : 'bus'), weight: 3 * st.w, opacity: 0.85, dashArray: g.path ? null : '6 6' })
      .bindPopup(`<b>${(groundModes[g.mode] || '🚌').split(' ')[0]} ${escapeHTML(g.from)} → ${escapeHTML(g.to)}</b><br><small>${fmtDate(g.date)}</small>`)));
  const flown = d.flights.map(f => (f.direction === 'in' ? f.to : f.from)), codes = [...new Set(flown)].filter(c => allAirports[c]);
  layer('✈️ Airports', codes.map(code => {
    const ap = allAirports[code], n = flown.filter(c => c === code).length;
    return L.circleMarker([ap.lat, ap.lon], { radius: 8 * st.r, color: '#fff', weight: 1.5, fillColor: col('accent'), fillOpacity: 0.9 })
      .bindPopup(`<b>✈️ ${escapeHTML(ap.name)} (${code})</b><br><small>${n} flight${n !== 1 ? 's' : ''}</small>` +
        `<br><a href="#airport=${code}" class="popup-link" onclick="event.preventDefault(); openAirport('${code}')">Airport page →</a>`);
  }));
  const stays = new Set(d.stays.map(s => s.id));
  layer('🏨 Stays and rental cars', allStays.filter(s => stays.has(s.id) && s.lat != null).map(s =>
    L.circleMarker([s.lat, s.lon], { radius: 6 * st.r, color: '#fff', weight: 1.5, fillColor: col(s.what === 'car' ? 'car' : 'stay'), fillOpacity: 0.9 })
      .bindPopup(`<b>${s.what === 'car' ? '🚗' : '🏨'} ${escapeHTML(s.hotel || s.type || s.place || '')}</b><br><small>${fmtDate(s.start)}` +
        `${s.end && s.end !== s.start ? ' – ' + fmtDate(s.end) : ''} · ${escapeHTML(s.provider || '')}</small>`)));
  layer('⛰️ Climbs', allClimbs.filter(c => c.country === d.cc).map(c => {
    const done = c.times > 0;  // all time, as the page
    return L.circleMarker([c.lat, c.lon], { radius: (done ? 6 : 4) * st.r, color: done ? '#fff' : col('climb'), weight: 1.5, fillColor: col('climb'), fillOpacity: done ? 0.95 : 0 })
      .bindPopup(`<b>⛰️ ${escapeHTML(c.name)}</b><br><small>${done ? `climbed ${c.times}×` : 'not climbed yet'}</small>` +
        `<br><a href="#" onclick="event.preventDefault(); openClimb('${c.id}')">Open climb page →</a>`);
  }));
  const most = d.towns[0]?.days || 1;
  layer('🏙️ Towns', d.towns.map(t => L.circleMarker([t.lat, t.lon], { radius: 3 + 10 * Math.sqrt(t.days / most), color: col('city'), weight: 1.5, fillColor: col('city'), fillOpacity: 0.4 })
    .bindPopup(`<b>${escapeHTML(t.name)}</b><br><small>${t.days} day${t.days !== 1 ? 's' : ''}</small>` +
      `<br><a href="#city=${t.id}" class="popup-link" onclick="event.preventDefault(); openCityReport(${t.id})">Open report →</a>`)));
  const ids = new Set(d.photo_ids || []), photos = (allPhotoPoints || []).filter(p => ids.has(p[0]));
  if (photos.length) {
    const group = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 40,
      iconCreateFunction: c => L.divIcon({ html: `<span>${c.getChildCount().toLocaleString()}</span>`, className: 'photo-cluster', iconSize: [30, 30] }) });
    const icon = L.divIcon({ className: 'photo-dot', iconSize: [10, 10] });
    group.addLayers(photos.map(p => L.marker([p[2], p[3]], { icon }).bindPopup(() => photoPopup(p), { maxWidth: 260, minWidth: 240 })));
    layers['📷 Photos'] = group.addTo(countryMap);
  } else if (ids.size && allPhotoPoints === null) loadPhotoPoints().then(() => countryShown === d && drawCountryMap(d));
  if (Object.keys(layers).length > 1) L.control.layers(null, layers, { collapsed: true, position: 'topright' }).addTo(countryMap);
  setTimeout(() => countryMap && countryMap.invalidateSize(), 50);
}

window.addEventListener('load', () => {
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.addEventListener('click', () => {
    if (location.hash.startsWith('#country=')) history.replaceState(null, '', location.pathname + location.search);
  }));
  const m = /^#country=([A-Za-z]{2})$/.exec(location.hash);
  if (m) setTimeout(() => openCountry(m[1]), 300);
});
