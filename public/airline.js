'use strict';
// An airline's page (#airline=<name>): its logo, codes and country, the flights you took with it in the period chosen,
// on a map of its routes, with what they add up to (distance, time in the air, airports, countries), its routes, the
// planes, the years, the classes and seats you had, the longest and shortest. Made from the page's flights and airports
// (allFlights, allAirports) and /api/airlines (codes, country); the logo from /api/airline-logo. Uses the page's and
// layers.js's globals.

let airlineShown = null, airlineMap = null, allAirlines = {};

const airlineLink = (name, text) => (name ? `<a href="#airline=${encodeURIComponent(name)}" class="sp-link inline" ` +
  `onclick="event.preventDefault(); openAirline(decodeURIComponent('${encodeURIComponent(name).replace(/'/g, '%27')}'))">${text || escapeHTML(name)}</a>` : '');

function openAirline(name) {
  if (!allFlights.some(f => f.airline === name)) return toast(`No flights with ${name}`, 'error');
  airlineShown = name;
  if (typeof map !== 'undefined' && map) map.closePopup();
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-airline').classList.add('active');
  const hash = `#airline=${encodeURIComponent(name)}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  renderAirline();
  window.scrollTo(0, 0);
}

function closeAirline() {
  history.replaceState(null, '', location.pathname + location.search);
  document.querySelector(`.tab[data-tab="${tabOfPath()}"]`).click();  // the tab it was opened from
}

const minutesOf = d => { const m = /^(\d+):(\d\d)/.exec(d || ''); return m ? +m[1] * 60 + +m[2] : 0; };
const hoursText = min => (min >= 60 * 48 ? `${Math.round(min / 60).toLocaleString()} h` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`);

function renderAirline() {
  const name = airlineShown, info = allAirlines[name] || {};
  const all = allFlights.filter(f => f.airline === name);
  const flights = all.filter(f => inWin(f.date)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const yours = allFlights.filter(f => inWin(f.date)).length;
  const dates = flights.map(f => (f.date || '').slice(0, 10)).filter(Boolean).sort();
  const logo = info.iata ? `<span class="airline-logo"><img src="/api/airline-logo/${info.iata}" alt="" onerror="this.parentNode.remove()"></span>` : '';
  document.getElementById('airline-title').innerHTML = `${logo}<span>${escapeHTML(name)}</span>`;
  document.getElementById('airline-sub').textContent = [
    info.country ? `${countryFlag(info.country)}${info.country}` : '',
    [info.iata, info.icao].filter(Boolean).join(' / '), info.callsign ? `call sign "${info.callsign}"` : '',
    info.active === false ? 'no longer flies' : '',
    win.from || win.to ? `${win.from || '…'} to ${win.to || '…'}` : '',
    dates.length ? `first ${fmtDate(dates[0])}, last ${fmtDate(dates[dates.length - 1])}` : 'no flights with it in this period',
  ].filter(Boolean).join(' · ');

  const km = flights.reduce((n, f) => n + (f.distance || 0), 0), min = flights.reduce((n, f) => n + minutesOf(f.duration), 0);
  const ports = new Set(flights.flatMap(f => [f.from, f.to]));
  const countries = new Set([...ports].map(c => allAirports[c]?.country).filter(Boolean));
  const routes = new Map();  // both ways as one
  flights.forEach(f => {
    const k = [f.from, f.to].sort().join('|'), r = routes.get(k) || { a: f.from, b: f.to, n: 0, last: '', km: f.distance || 0 };
    r.n++; if ((f.date || '') > r.last) r.last = f.date || '';
    routes.set(k, r);
  });
  const count = key => { const m = new Map(); flights.forEach(f => { const v = key(f); if (v) m.set(v, (m.get(v) || 0) + 1); }); return [...m].sort((a, b) => b[1] - a[1]); };
  const planes = count(f => f.plane), years = count(f => (f.date || '').slice(0, 4)).sort((a, b) => a[0].localeCompare(b[0]));
  const classes = count(f => ({ F: 'First', C: 'Business', P: 'Premium economy', Y: 'Economy' })[f.class] || '');
  // window, aisle or middle: as the booking says, else from the seat's letter as on a plane of six a row (A and F by
  // the window), a guess on a wider one
  const seatKind = f => ({ W: 'Window', A: 'Aisle', M: 'Middle' })[f.seat_type] || { A: 'Window', F: 'Window', C: 'Aisle', D: 'Aisle', B: 'Middle', E: 'Middle' }[(/\d+([A-K])$/i.exec(f.seat || '') || [])[1]?.toUpperCase()] || '';
  const seats = count(seatKind);
  const byKm = flights.filter(f => f.distance).sort((a, b) => b.distance - a.distance);

  const card = (label, value, sub = '') => `<div class="stat-card"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const section = (title, body, note = '') => `<div class="chart-section"><h3>${title}</h3><div class="sp-scroll">${body}</div>${note ? `<p class="sp-note">${note}</p>` : ''}</div>`;
  const table = (head, rows) => `<table class="sp-table"><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  const bars = list => { const top = Math.max(1, ...list.map(x => x[1])); return table('<th></th><th></th><th></th>', list.map(([k, n]) =>
    `<tr><th>${escapeHTML(k)}</th><td style="width:60%"><div class="airline-bar" style="width:${Math.round(n / top * 100)}%"></div></td><td>${n}</td></tr>`)); };
  const flightRow = f => `<tr><th>${fmtDate(f.date)}</th><td><b>${escapeHTML(f.flight_number || '')}</b></td>` +
    `<td>${airportLink(f.from)} → ${airportLink(f.to)}<small>${escapeHTML(allAirports[f.from]?.city || '')} → ${escapeHTML(allAirports[f.to]?.city || '')}</small></td>` +
    `<td>${escapeHTML(f.plane || '')}</td><td>${escapeHTML(f.seat || '')}</td><td data-v="${f.distance || 0}">${f.distance ? fmtDist(f.distance) : ''}</td><td data-v="${minutesOf(f.duration)}">${escapeHTML(f.duration || '')}</td></tr>`;

  let html = '<div class="chart-section" style="padding:0;overflow:hidden"><div id="airline-map" class="mini-map" style="height:340px"></div></div>' +
    '<div class="stat-cards">' + card('Flights', flights.length.toLocaleString(), yours ? `${Math.round(flights.length / yours * 100)}% of your flights` : '') +
    card('Distance', fmtDist(km), km > 40075 ? `${(km / 40075).toFixed(1)} times around the Earth` : '') +
    card('In the air', min ? hoursText(min) : '—', min ? `of the ${flights.filter(f => minutesOf(f.duration)).length} with a flight time` : '') +
    card('Airports', ports.size.toLocaleString(), `in ${countries.size} countr${countries.size === 1 ? 'y' : 'ies'}`) + '</div>';
  if (flights.length) {
    html += section('Routes', table('<th data-sort="text">Route</th><th data-sort="num" class="sort-desc" aria-sort="descending">Flights</th><th data-sort="num">Distance</th><th data-sort="num">Last</th>',
      [...routes.values()].sort((a, b) => b.n - a.n).map(r => `<tr><td data-v="${escapeHTML(r.a + r.b)}">${airportLink(r.a)} ⇄ ${airportLink(r.b)}` +
        `<small>${escapeHTML(allAirports[r.a]?.city || '')} ⇄ ${escapeHTML(allAirports[r.b]?.city || '')}</small></td><td data-v="${r.n}">${r.n}</td>` +
        `<td data-v="${r.km}">${r.km ? fmtDist(r.km) : ''}</td><td data-v="${Date.parse(r.last) || ''}">${r.last ? fmtDate(r.last) : ''}</td></tr>`)), 'Both ways together. Click a heading to sort.');
    if (byKm.length > 1) html += section('Longest and shortest', table('<th></th><th>When</th><th>Route</th><th>Distance</th>', [['Longest', byKm[0]], ['Shortest', byKm[byKm.length - 1]]].map(([k, f]) =>
      `<tr><th>${k}</th><td>${fmtDate(f.date)}</td><td>${airportLink(f.from)} → ${airportLink(f.to)}</td><td>${fmtDist(f.distance)}</td></tr>`)));
    html += '<div class="airline-grid">';
    if (years.length > 1) html += section('By year', bars(years));
    if (planes.length) html += section('Planes', bars(planes), planes.length < flights.length ? `${flights.filter(f => f.plane).length} of ${flights.length} flights know their plane.` : '');
    if (classes.length) html += section('Class', bars(classes));
    if (seats.length) html += section('Seat', bars(seats), 'From the seat letter, as on a plane of six seats a row.');
    html += '</div>';
    html += section('Flights', table('<th>When</th><th>Flight</th><th>Route</th><th>Plane</th><th>Seat</th><th data-sort="num">Distance</th><th data-sort="num">Time</th>', flights.map(flightRow)));
  }
  document.getElementById('airline-body').innerHTML = html;
  sortableTables('airline-body');
  paginateTables('airline-body');
  drawAirlineMap(routes);
}

function drawAirlineMap(routes) {
  if (airlineMap) { try { airlineMap.remove(); } catch (_) { /* never fully drawn */ } airlineMap = null; }
  const box = document.getElementById('airline-map');
  box.dataset.basemap = BASEMAPS[prefs.basemap] ? prefs.basemap : 'auto';
  airlineMap = L.map(box, { zoomControl: true, attributionControl: true, worldCopyJump: true });
  toneMap(airlineMap);
  addBasemap(airlineMap);
  const accent = mapVar('--accent'), seen = new Map();
  routes.forEach(r => {
    const a = allAirports[r.a], b = allAirports[r.b];
    if (!a || !b) return;
    L.polyline(greatCircle(a.lat, a.lon, b.lat, b.lon), { color: accent, weight: Math.min(1 + Math.log2(r.n) * 0.8, 4), opacity: 0.55 }).addTo(airlineMap);
    seen.set(r.a, (seen.get(r.a) || 0) + r.n);
    seen.set(r.b, (seen.get(r.b) || 0) + r.n);
  });
  const pts = [];
  seen.forEach((n, code) => {
    const o = allAirports[code];
    pts.push([o.lat, o.lon]);
    L.circleMarker([o.lat, o.lon], { radius: 4, color: accent, fillColor: accent, fillOpacity: 0.8, weight: 1 })
      .bindPopup(`<b>${code}</b> — ${escapeHTML(o.name)}<br><small>${escapeHTML(o.city)} · ${n} flight${n > 1 ? 's' : ''} with ${escapeHTML(airlineShown)}</small>` +
        `<br><a href="#airport=${code}" class="popup-link" onclick="event.preventDefault(); openAirport('${code}')">Airport page →</a>`).addTo(airlineMap);
  });
  if (pts.length > 1) airlineMap.fitBounds(pts, { padding: [24, 24], maxZoom: 8 }); else airlineMap.setView(pts[0] || [48, 10], pts.length ? 8 : 3);
  setTimeout(() => airlineMap && airlineMap.invalidateSize(), 50);
}

window.addEventListener('load', () => {
  fetch('/api/airlines').then(r => (r.ok ? r.json() : {})).then(d => { allAirlines = d; if (airlineShown) renderAirline(); }).catch(() => {});
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.addEventListener('click', () => {
    if (location.hash.startsWith('#airline=')) history.replaceState(null, '', location.pathname + location.search);
  }));
  const m = /^#airline=(.+)$/.exec(location.hash);
  const go = (n = 0) => ((allFlights || []).length ? openAirline(decodeURIComponent(m[1])) : n < 60 && setTimeout(() => go(n + 1), 300));
  if (m) go();  // once the page's flights have loaded
});
