'use strict';
// An airport's page: opened from an airport on the map (or #airport=<IATA>), its flights in and out, the airports it
// took you to and from, the airlines, and a map of its routes. Made from the page's flights and airports (allFlights,
// allAirports) for the period chosen; uses the page's and layers.js's globals.

let airportShown = null, airportMap = null;

function openAirport(iata) {
  const ap = allAirports[iata];
  if (!ap) return toast(`No airport ${iata}`, 'error');
  airportShown = iata;
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-airport').classList.add('active');
  if (location.hash !== `#airport=${iata}`) history.replaceState(null, '', `#airport=${iata}`);
  renderAirport();
  window.scrollTo(0, 0);
}

function closeAirport(toAirport = false) {
  history.replaceState(null, '', location.pathname + location.search);
  document.querySelector('.tab[data-tab="map"]').click();
  const ap = allAirports[airportShown];
  if (toAirport && ap) setTimeout(() => map.setView([ap.lat, ap.lon], 10), 80);
}

const airportLink = code => (allAirports[code] ? `<a href="#airport=${code}" class="sp-link inline" onclick="event.preventDefault(); openAirport('${code}')">${code}</a>` : escapeHTML(code || ''));

function renderAirport() {
  const iata = airportShown, ap = allAirports[iata];
  const flights = allFlights.filter(f => (f.from === iata || f.to === iata) && inWin(f.date)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n !== 1 ? 's' : ''}`;
  const out = flights.filter(f => f.from === iata), into = flights.filter(f => f.to === iata);
  const dates = flights.map(f => (f.date || '').slice(0, 10)).filter(Boolean).sort();
  document.getElementById('airport-title').innerHTML = `✈️ ${countryFlag(ap.country)}${iata} · ${escapeHTML(ap.name)}`;
  document.getElementById('airport-sub').textContent = `${ap.city}, ${ap.country}` +
    (win.from || win.to ? ` · ${win.from || '…'} to ${win.to || '…'}` : '') + (dates.length ? ` · first ${fmtDate(dates[0])}, last ${fmtDate(dates[dates.length - 1])}` : ' · no flights in this period');

  // the other ends: per airport, how many flights and when last
  const ends = new Map();
  flights.forEach(f => {
    const other = f.from === iata ? f.to : f.from, e = ends.get(other) || { code: other, n: 0, last: '', out: 0 };
    e.n++; if (f.from === iata) e.out++;
    if ((f.date || '') > e.last) e.last = f.date || '';
    ends.set(other, e);
  });
  const airlines = new Map();
  flights.forEach(f => { const a = f.airline || 'Unknown'; airlines.set(a, (airlines.get(a) || 0) + 1); });
  const km = flights.reduce((n, f) => n + (f.distance || 0), 0);

  const card = (label, value, sub = '') => `<div class="stat-card"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const section = (title, body, note = '') => `<div class="chart-section"><h3>${title}</h3><div class="sp-scroll">${body}</div>${note ? `<p class="sp-note">${note}</p>` : ''}</div>`;
  const table = (head, rows) => `<table class="sp-table"><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  let html = '<div class="chart-section" style="padding:0;overflow:hidden"><div id="airport-map" class="mini-map" style="height:340px"></div></div>' +
    '<div class="stat-cards">' + card('Flights', flights.length.toLocaleString(), `${out.length} out, ${into.length} in`) +
    card('Airports', ends.size.toLocaleString(), 'flown to or from') + card('Airlines', airlines.size.toLocaleString()) +
    card('Distance', fmtDist(km), 'of these flights') + '</div>';
  if (ends.size) {
    html += section('To and from', table('<th data-sort="text">Airport</th><th data-sort="text">City</th><th data-sort="num" class="sort-desc" aria-sort="descending">Flights</th><th data-sort="num">Last</th>',
      [...ends.values()].sort((a, b) => b.n - a.n).map(e => {
        const o = allAirports[e.code] || {};
        return `<tr><td data-v="${escapeHTML(e.code)}">${airportLink(e.code)}<small>${escapeHTML(o.name || '')}</small></td><td data-v="${escapeHTML(o.city || '')}">${countryFlag(o.country)}${escapeHTML(o.city || '')}</td>` +
          `<td data-v="${e.n}">${e.n}<small>${e.out} out, ${e.n - e.out} in</small></td><td data-v="${Date.parse(e.last) || ''}">${e.last ? fmtDate(e.last) : ''}</td></tr>`;
      })), 'Click a heading to sort.');
    html += section('Airlines', table('<th data-sort="text">Airline</th><th data-sort="num" class="sort-desc" aria-sort="descending">Flights</th>',
      [...airlines].sort((a, b) => b[1] - a[1]).map(([a, n]) => `<tr><td data-v="${escapeHTML(a)}">${escapeHTML(a)}</td><td data-v="${n}">${n}</td></tr>`)));
    html += section('Flights', table('<th>When</th><th>Flight</th><th>Route</th><th></th>', flights.map(f =>
      `<tr><th>${fmtDate(f.date)}</th><td><b>${escapeHTML(f.flight_number || '')}</b><small>${escapeHTML(f.airline || '')}</small></td>` +
      `<td>${airportLink(f.from)} → ${airportLink(f.to)}<small>${escapeHTML(allAirports[f.from]?.city || '')} → ${escapeHTML(allAirports[f.to]?.city || '')}</small></td>` +
      `<td>${f.from === iata ? 'out' : 'in'}</td></tr>`)));
  }
  document.getElementById('airport-body').innerHTML = html;
  sortableTables('airport-body');
  paginateTables('airport-body');
  drawAirportMap(ap, ends);
}

function drawAirportMap(ap, ends) {
  if (airportMap) { try { airportMap.remove(); } catch (_) { /* never fully drawn */ } airportMap = null; }
  const box = document.getElementById('airport-map');
  box.dataset.basemap = BASEMAPS[prefs.basemap] ? prefs.basemap : 'auto';
  airportMap = L.map(box, { zoomControl: true, attributionControl: true, worldCopyJump: true });
  toneMap(airportMap);
  const b = BASEMAPS[prefs.basemap] || BASEMAPS.auto, [url, attribution, maxZoom = 19] = b.tiles;
  L.tileLayer(url, { attribution, maxZoom }).addTo(airportMap);
  const accent = mapVar('--accent'), bounds = [[ap.lat, ap.lon], ...[...ends.keys()].map(c => allAirports[c]).filter(Boolean).map(o => [o.lat, o.lon])];
  if (bounds.length > 1) airportMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 9 }); else airportMap.setView([ap.lat, ap.lon], 9);  // the view before the lines
  ends.forEach(e => {
    const o = allAirports[e.code];
    if (!o) return;
    L.polyline(greatCircle(ap.lat, ap.lon, o.lat, o.lon), { color: accent, weight: Math.min(1 + Math.log2(e.n) * 0.8, 4), opacity: 0.55 }).addTo(airportMap);
    L.circleMarker([o.lat, o.lon], { radius: 4, color: accent, fillColor: accent, fillOpacity: 0.8, weight: 1 })
      .bindPopup(`<b>${e.code}</b> — ${escapeHTML(o.name)}<br><small>${escapeHTML(o.city)} · ${e.n} flight${e.n > 1 ? 's' : ''}</small>` +
        `<br><a href="#airport=${e.code}" class="popup-link" onclick="event.preventDefault(); openAirport('${e.code}')">Airport page →</a>`).addTo(airportMap);
  });
  L.circleMarker([ap.lat, ap.lon], { radius: 8, color: mapVar('--surface'), weight: 2, fillColor: accent, fillOpacity: 1 }).addTo(airportMap);
  setTimeout(() => airportMap && airportMap.invalidateSize(), 50);
}

window.addEventListener('load', () => {
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.addEventListener('click', () => {
    if (location.hash.startsWith('#airport=')) history.replaceState(null, '', location.pathname + location.search);
  }));
  const m = /^#airport=([A-Z0-9]{3})$/.exec(location.hash);
  const go = (n = 0) => (Object.keys(allAirports || {}).length ? openAirport(m[1]) : n < 60 && setTimeout(() => go(n + 1), 300));
  if (m) go();  // once the page's flights and airports have loaded
});
