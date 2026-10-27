'use strict';
// The Trips tab and a page per trip (#trip=<first day>): the runs of days away that Cairn finds in all its data
// (trips.js on the server), listed by year; a trip's page has its map (flights, trains, buses and ferries, stays,
// activities, photos and the moves between them, along the roads where they were long enough), its numbers, day by
// day what happened, and links to the towns' and climbs' pages. Uses the page's and layers.js's globals.

let tripList = null, tripShown = null, tripMap = null;

function loadTrips() {
  if (!tripList) tripList = fetch('/api/trips').then(r => (r.ok ? r.json() : [])).catch(() => []);
  return tripList;
}
// the trip a day belongs to (for links from other pages), once the list has loaded
let tripsByDay = [];
loadTrips().then(list => { tripsByDay = list; });
const tripOn = d => d && tripsByDay.find(t => d.slice(0, 10) >= t.start && d.slice(0, 10) <= t.end);
const tripLink = (t, text) => `<a href="#trip=${t.id}" class="sp-link inline" onclick="event.preventDefault(); openTrip('${t.id}')">${text || escapeHTML(t.name)}</a>`;

const hm = sec => `${Math.floor(sec / 3600)}:${String(Math.round(sec % 3600 / 60)).padStart(2, '0')}`;
const tripRange = (a, b) => (b && b !== a ? `${fmtDate(a)} – ${fmtDate(b)}` : fmtDate(a));
const tripFlags = t => t.countries.map(c => flagOf(c.cc).trim()).join(' ');

async function renderTrips() {
  const box = document.getElementById('trips-body');
  const list = await loadTrips();
  if (!list.length) { box.innerHTML = '<p class="sp-note">No trips yet: they come from flights, trains, stays, activities and photos away from home.</p>'; return; }
  const years = {};
  list.forEach(t => (years[t.start.slice(0, 4)] = years[t.start.slice(0, 4)] || []).push(t));
  const abroad = list.filter(t => t.countries.length);
  let html = '<div class="stat-cards">' +
    `<div class="stat-card"><div class="label">Trips</div><div class="value">${list.length.toLocaleString()}</div><div class="sub">${abroad.length} abroad</div></div>` +
    `<div class="stat-card"><div class="label">Days away</div><div class="value">${list.reduce((n, t) => n + t.days, 0).toLocaleString()}</div>` +
    `<div class="sub">${list.reduce((n, t) => n + t.nights, 0).toLocaleString()} nights in stays</div></div>` +
    `<div class="stat-card"><div class="label">Longest</div><div class="value">${Math.max(...list.map(t => t.days))} days</div>` +
    `<div class="sub">${escapeHTML(list.reduce((a, b) => (b.days > a.days ? b : a)).name)}</div></div></div>`;
  Object.keys(years).sort().reverse().forEach(y => {
    const ts = years[y];
    html += `<div class="chart-section"><h3>${y} · ${ts.length} trip${ts.length !== 1 ? 's' : ''}, ${ts.reduce((n, t) => n + t.days, 0)} days</h3><div class="sp-scroll">` +
      `<table class="sp-table"><thead><tr><th>When</th><th>Trip</th><th>Days</th><th>Towns</th><th></th></tr></thead><tbody>` +
      ts.map(t => `<tr><th>${tripRange(t.start, t.end)}</th><td>${tripFlags(t)} ${tripLink(t)}</td><td>${t.days}${t.nights ? `<small>${t.nights} night${t.nights !== 1 ? 's' : ''} in stays</small>` : ''}</td>` +
        `<td>${t.towns.slice(0, 3).map(c => `<a href="#" class="sp-link inline" onclick="event.preventDefault(); openCityReport(${c.id})">${escapeHTML(c.name)}</a>`).join(', ')}</td>` +
        `<td>${[[t.flights, '✈️'], [t.ground, '🚆'], [t.activities, '🏃'], [t.photos, '📷']].filter(([n]) => n).map(([n, i]) => `${i} ${n}`).join(' · ')}</td></tr>`).join('') +
      '</tbody></table></div></div>';
  });
  box.innerHTML = html;
  paginateTables('trips-body');
}

async function openTrip(id) {
  const d = await fetch(`/api/trips/${id}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!d) return toast('No such trip', 'error');
  tripShown = d;
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === 'trips'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-trip').classList.add('active');
  if (location.hash !== `#trip=${id}`) history.replaceState(null, '', `#trip=${id}`);
  renderTrip();
  window.scrollTo(0, 0);
  if (d.roads_pending) setTimeout(() => tripShown === d && location.hash === `#trip=${id}` && refreshTripMap(id), 20000);
}

// the roads looked up meanwhile: the map again
async function refreshTripMap(id) {
  const d = await fetch(`/api/trips/${id}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!d || tripShown?.id !== id) return;
  tripShown = d;
  drawTripMap(d, true);
  if (d.roads_pending) setTimeout(() => location.hash === `#trip=${id}` && refreshTripMap(id), 30000);
}

function closeTrip() {
  history.replaceState(null, '', location.pathname + location.search);
  document.querySelector('.tab[data-tab="trips"]').click();
}

// The trip on the big map: its period chosen there
function tripOnMap() {
  const d = tripShown;
  history.replaceState(null, '', location.pathname + location.search);
  document.querySelector('.tab[data-tab="map"]').click();
  const sel = document.getElementById('p-trip'), i = journeys.findIndex(j => j.start === d.start);
  if (sel && i >= 0) { sel.value = i; sel.dispatchEvent(new Event('change')); }
}

function renderTrip() {
  const d = tripShown;
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n !== 1 ? 's' : ''}`;
  document.getElementById('trip-title').innerHTML = `${tripFlags(d)} ${escapeHTML(d.name)}`;
  document.getElementById('trip-sub').textContent = `${tripRange(d.start, d.end)} · ${plural(d.days, 'day')}` +
    (d.countries.length ? ` · ${d.countries.map(c => `${c.cc} ${c.days} d`).join(', ')}` : '');
  const card = (label, value, sub = '') => (!value || value === '0' ? '' : `<div class="stat-card"><div class="label">${label}</div><div class="value">${value}</div>` +
    (sub ? `<div class="sub">${sub}</div>` : '') + '</div>');
  const section = (title, body, note = '') => `<div class="chart-section"><h3>${title}</h3><div class="sp-scroll">${body}</div>` +
    (note ? `<p class="sp-note">${note}</p>` : '') + '</div>';
  const table = (head, rows) => `<table class="sp-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  const city = c => `<a href="#" class="sp-link inline" onclick="event.preventDefault(); openCityReport(${c.id})">${escapeHTML(c.name)}</a>`;
  const stays = d.stays.filter(s => s.what !== 'car'), cars = d.stays.filter(s => s.what === 'car');
  const road = d.moves.filter(m => m.kind !== 'move').reduce((n, m) => n + m.km, 0);
  const flownKm = d.flights.reduce((n, f) => n + (f.distance || 0), 0), groundKm = d.ground.reduce((n, g) => n + (g.distance || 0), 0);
  const actKm = d.activities.reduce((n, a) => n + (a.distance || 0), 0);
  const climbed = allClimbs.map(c => ({ c, rides: (c.rides || []).filter(r => r.date >= d.start && r.date <= d.end) })).filter(x => x.rides.length);

  let html = `<div class="chart-section" style="padding:0;overflow:hidden"><div id="trip-map" class="mini-map" style="height:440px"></div></div>` +
    '<div class="stat-cards">' +
    card('Days', d.days, `${plural(d.nights, 'night')} in stays`) +
    card('Towns', d.towns.length ? d.towns.length + (d.towns.length >= 6 ? '+' : '') : '', d.towns.slice(0, 3).map(c => escapeHTML(c.name)).join(', ')) +
    card('Flights', d.flights.length, `${Math.round(dist(flownKm)).toLocaleString()} ${DU()}`) +
    card('Trains, buses, ferries', d.ground.length, `${Math.round(dist(groundKm)).toLocaleString()} ${DU()}`) +
    card(cars.length ? 'Driven' : 'By road', road ? `${Math.round(dist(road)).toLocaleString()} ${DU()}` : '', cars.length ? plural(cars.length, 'rental car') : 'between photos and stays') +
    card('Activities', d.activities.length, `${Math.round(dist(actKm)).toLocaleString()} ${DU()}`) +
    card('Photos', d.photo_ids.length.toLocaleString()) +
    card('Sleep', d.body?.sleep ? hm(d.body.sleep) : '', [d.body.score ? `score ${d.body.score}` : '', d.body.sleep_before ? `${hm(d.body.sleep_before)} the month before` : ''].filter(Boolean).join(' · ')) +
    card('Resting heart rate', d.body?.rhr ? `${d.body.rhr} bpm` : '', d.body.rhr_before ? `${d.body.rhr_before} the month before` : '') + '</div>';

  const byId = (list, id) => list.find(x => x.id === id);
  const bodyOf = b => (b ? [b.sleep ? `😴 ${hm(b.sleep)}${b.score ? ` <small>score ${b.score}</small>` : ''}` : '', b.rhr ? `❤️ ${b.rhr} bpm` : ''].filter(Boolean).join('<br>') : '');
  const withBody = d.dayList.some(x => x.body);
  html += tripStory(d);
  html += section('Days at a glance', table(['Day', 'Where', 'How you moved', 'What you did', 'Slept', ...(withBody ? ['Sleep, heart'] : [])], d.dayList.map(x => {
    const moved = [
      ...x.flights.map(id => byId(d.flights, id)).map(f => `✈️ ${f.from} → ${f.to}`),
      ...x.ground.map(id => byId(d.ground, id)).map(g => `${(groundModes[g.mode] || '🚌').split(' ')[0]} ${escapeHTML(g.from)} → ${escapeHTML(g.to)}`),
      x.road ? `${cars.some(c => x.day >= c.start && x.day <= (c.end || c.start)) ? '🚗' : '🛣️'} ${Math.round(dist(x.road))} ${DU()}` : ''
    ].filter(Boolean).join('<br>');
    const did = [...x.activities.map(id => byId(d.activities, id)).map(a => linkTo(a) + (a.weather ? `<small>${weatherText(a.weather, true)}</small>` : '')),
      x.photos ? `📷 ${x.photos}` : ''].filter(Boolean).join('<br>');
    const s = x.stay != null && byId(d.stays, x.stay);
    return `<tr><th>${fmtDate(x.day)}<small>${new Date(x.day + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short' })}</small></th>` +
      `<td>${x.towns.map(c => `${flagOf(c.country)}${city(c)}`).join('<br>')}</td><td>${moved}</td><td>${did}</td>` +
      `<td>${s ? `🏨 ${escapeHTML(s.hotel || s.type || s.place || '')}<small>${escapeHTML(s.provider || '')}</small>` : ''}</td>` +
      (withBody ? `<td>${bodyOf(x.body)}</td>` : '') + '</tr>';
  })), 'Where: the towns your flights, trains, stays, activities, photos and Timeline put you in that day. 🛣️ moves between photos, activities and stays of 10 km or more, along the roads (🚗 with a rental car). ' +
    'Weather on rides: Open-Meteo\'s history at the start, over the ride\'s hours. Sleep, heart: from Garmin, the night before that day and the day\'s resting heart rate.');
  if (d.towns.length) html += section('Towns', `<p>${d.towns.map(c => `${flagOf(c.country)}${city(c)} <small>${plural(c.days, 'day')}</small>`).join(' · ')}</p>`);
  if (stays.length || cars.length) {
    html += section('Stays and rental cars', table(['When', 'Nights', 'Where', 'Booked'], d.stays.map(s =>
      `<tr><th>${s.what === 'car' ? '🚗' : '🏨'} ${tripRange(s.start, s.end)}</th><td>${nights(s)}</td>` +
      `<td><b>${escapeHTML(s.hotel || s.type || (s.what === 'car' ? 'Rental car' : 'Stay'))}</b><small>${escapeHTML(s.place || '')}</small></td>` +
      `<td>${escapeHTML(s.provider || '')}</td></tr>`)));
  }
  if (d.flights.length) {
    html += section('Flights', table(['When', 'Flight', 'Route', DU()], d.flights.map(f =>
      `<tr><th>${fmtDate(f.date)}</th><td><b>${escapeHTML(f.flight_number || '')}</b><small>${escapeHTML(f.airline || '')}</small></td>` +
      `<td>${escapeHTML(f.from_city || f.from)} (${f.from}) → ${escapeHTML(f.to_city || f.to)} (${f.to})</td><td>${f.distance ? Math.round(dist(f.distance)).toLocaleString() : ''}</td></tr>`)));
  }
  if (d.ground.length) {
    html += section('Trains, buses and ferries', table(['When', '', 'Route', DU()], d.ground.map(g =>
      `<tr><th>${fmtDate(g.date)}</th><td>${(groundModes[g.mode] || '🚌').split(' ')[0]}</td>` +
      `<td>${escapeHTML(g.from)} → ${escapeHTML(g.to)}</td><td>${g.distance ? Math.round(dist(g.distance)).toLocaleString() : ''}</td></tr>`)));
  }
  if (d.activities.length) {
    html += section('Sports activities', table(['When', 'Activity', DU(), 'Climb'], d.activities.map(a =>
      `<tr><th>${fmtDate(a.date)}</th><td>${linkTo(a)}<small>${escapeHTML(a.sport || '')}</small></td>` +
      `<td>${(Math.round(dist(a.distance || 0) * 10) / 10).toLocaleString()}</td><td>${a.elevation ? fmtHeight(a.elevation) : ''}</td></tr>`)));
  }
  if (d.music?.plays) html += musicSection(d.music, 'Soundtrack', 'what you played on Last.fm from the first day to the last');
  if (climbed.length) {
    html += section('Famous climbs', `<p>${climbed.map(({ c, rides }) => `⛰️ <a href="#" class="sp-link" onclick="event.preventDefault(); openClimb('${c.id}')">${escapeHTML(c.name)}</a>` +
      ` <small>${rides.map(r => fmtDate(r.date)).join(', ')}</small>`).join('<br>')}</p>`);
  }
  document.getElementById('trip-body').innerHTML = html;
  hookLinks('trip-body');
  paginateTables('trip-body');
  drawTripMap(d);
}

// The trip as a story, day after day, in the order things happened: flights, trains, buses and ferries, activities
// (with the weather), drives, and the photos taken in between as strips of thumbnails; then where you slept. Times are
// local: as booked for flights and trains, as recorded for activities, and for photos and drives from the clock in
// UTC, the zone guessed from the longitude.
const STRIP = 10;
function tripStory(d) {
  const local = (t, lon) => new Date((t + Math.round((lon || 0) / 15) * 3600) * 1000).toISOString().slice(0, 16);
  const at = s => (s || '').replace(' ', 'T').slice(0, 16);
  const ev = [];
  d.flights.forEach(f => ev.push({ at: at(f.date), html: `✈️ <b>${escapeHTML(f.from_city || f.from)} → ${escapeHTML(f.to_city || f.to)}</b> ` +
    `<small>${escapeHTML(f.flight_number || '')} ${f.from}–${f.to}${f.distance ? ` · ${fmtDist(f.distance)}` : ''}</small>` }));
  d.ground.forEach(g => ev.push({ at: at(g.date), html: `${(groundModes[g.mode] || '🚌').split(' ')[0]} <b>${escapeHTML(g.from)} → ${escapeHTML(g.to)}</b> ` +
    `<small>${[g.service, g.arrival ? `until ${g.arrival.slice(11, 16)}` : '', g.distance ? fmtDist(g.distance) : ''].filter(Boolean).map(escapeHTML).join(' · ')}</small>` }));
  d.activities.forEach(a => ev.push({ at: at(a.date), html: `${sportEmoji[sportOf(a.sport)] || '🏅'} ${linkTo(a)} <small>${[a.distance ? fmtDist(a.distance, 1) : '',
    a.elevation ? '↑' + fmtHeight(a.elevation) : '', a.moving_time ? hm(a.moving_time) : ''].filter(Boolean).join(' · ')}` +
    `${a.weather ? ` · ${weatherText(a.weather, true)}` : ''}</small>` }));
  d.moves.filter(m => m.kind !== 'move').forEach(m => ev.push({ at: local(m.t0, m.from[1]), html: `${m.kind === 'drive' ? '🚗 Drove' : '🛣️ By road'} <small>${fmtDist(m.km)}</small>` }));
  (d.photos || []).forEach(p => ev.push({ at: local(p[1], p[3]), photo: p }));
  const stays = d.stays.filter(s => s.what !== 'car');
  const days = {};
  ev.forEach(e => (days[e.at.slice(0, 10)] = days[e.at.slice(0, 10)] || []).push(e));
  const strip = list => `<div class="story-strip">${list.map((p, i) => `<a href="/api/photos/${p[0]}/full" target="_blank" rel="noopener"${i >= STRIP ? ' hidden' : ''} ` +
    `title="${p[4] ? 'Video' : 'Photo'}, ${local(p[1], p[3]).slice(11)}"><img src="/api/photos/${p[0]}/thumb" alt="" loading="lazy">${p[4] ? '<span>🎬</span>' : ''}</a>`).join('')}` +
    (list.length > STRIP ? `<button class="btn btn-ghost" onclick="this.parentNode.querySelectorAll('a[hidden]').forEach(a => a.hidden = false); this.remove()">+${list.length - STRIP} more</button>` : '') + '</div>';
  let html = '';
  d.dayList.forEach(x => {
    const items = (days[x.day] || []).sort((a, b) => a.at.localeCompare(b.at));
    const night = stays.find(s => s.start <= x.day && (s.end || s.start) > x.day);
    if (!items.length && !night) return;
    let body = '', photos = [];
    const flush = () => { if (photos.length) body += `<li class="story-photos"><span class="story-time">${photos[0][5]}</span>${strip(photos)}</li>`; photos = []; };
    items.forEach(e => {
      if (e.photo) { photos.push([...e.photo.slice(0, 5), e.at.slice(11)]); return; }
      flush();
      body += `<li><span class="story-time">${e.at.slice(11)}</span>${e.html}</li>`;
    });
    flush();
    if (night) body += `<li><span class="story-time">night</span>🏨 ${escapeHTML(night.hotel || night.type || night.place || 'Stay')} <small>${escapeHTML([night.place, night.provider].filter(Boolean).join(' · '))}</small></li>`;
    const b = x.body;
    html += `<div class="story-day"><h4>${new Date(x.day + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}` +
      ` <span>${x.towns.map(c => `${flagOf(c.country)}<a href="#" class="sp-link" onclick="event.preventDefault(); openCityReport(${c.id})">${escapeHTML(c.name)}</a>`).join(' · ')}</span>` +
      (b || d.music?.days?.[x.day] ? `<small>${[d.music?.days?.[x.day] ? `🎵 ${escapeHTML(d.music.days[x.day].top.artist)} – ${escapeHTML(d.music.days[x.day].top.name)}` : '',
        b?.sleep ? `😴 ${hm(b.sleep)}${b.score ? ` (${b.score})` : ''}` : '', b?.rhr ? `❤️ ${b.rhr}` : ''].filter(Boolean).join(' · ')}</small>` : '') +
      `</h4><ul>${body}</ul></div>`;
  });
  return html ? `<div class="chart-section"><h3>Day by day</h3>${html}<p class="sp-note">In the order it happened. Times are local: as booked for flights and trains, ` +
    `as recorded for activities; for photos and drives guessed from the longitude. Click a photo for the whole of it. 🎵 the track you played most that day (Last.fm), 😴 sleep the night before (Garmin's score), ❤️ resting heart rate.</p></div>` : '';
}

// Top artists and tracks (Last.fm), for a trip's or a town's page
function musicSection(m, title, what) {
  const list = rows => `<ol class="music-list">${rows.join('')}</ol>`;
  return `<div class="chart-section"><h3>${title} · ${m.plays.toLocaleString()} plays</h3><div class="music-cols">` +
    `<div><h4>Artists</h4>${list(m.artists.map(a => `<li>${escapeHTML(a.name)} <small>${a.plays}</small></li>`))}</div>` +
    `<div><h4>Tracks</h4>${list(m.tracks.map(t => `<li>${escapeHTML(t.name)} <small>${escapeHTML(t.artist)} · ${t.plays}</small></li>`))}</div>` +
    `</div><p class="sp-note">${what}.</p></div>`;
}

function drawTripMap(d, keepView = false) {
  const view = keepView && tripMap ? { c: tripMap.getCenter(), z: tripMap.getZoom() } : null;
  if (tripMap) { tripMap.remove(); tripMap = null; }
  const box = document.getElementById('trip-map');
  if (!box) return;
  box.dataset.basemap = BASEMAPS[prefs.basemap] ? prefs.basemap : 'auto';
  tripMap = L.map(box, { zoomControl: true, attributionControl: true });
  const b = BASEMAPS[prefs.basemap] || BASEMAPS.auto, [url, attribution, maxZoom = 19] = b.tiles;
  L.tileLayer(url, { attribution, maxZoom }).addTo(tripMap);
  const st = lineStyle(), col = k => getCSSVar('--' + k), bounds = [], local = [];  // local: the trip's own area, without the flights there
  // moves first, under the rest: along the roads solid, the short ones dotted
  d.moves.forEach(m => {
    const pts = m.path ? decodePath(m.path) : [m.from, m.to];
    const drive = m.kind === 'drive', roadway = !!m.path;
    L.polyline(pts, { color: drive ? col('car') : roadway ? col('timeline') : col('photo'), weight: (roadway ? 3 : 1.5) * st.w,
      opacity: roadway ? 0.85 : 0.6, dashArray: roadway ? null : '2 6' })
      .bindPopup(`<b>${drive ? '🚗 Drive' : roadway ? '🛣️ By road' : '📍 Moved'}</b> · ${Math.round(dist(m.km) * 10) / 10} ${DU()}<br>` +
        `<small>${fmtDate(new Date(m.t0 * 1000).toISOString().slice(0, 10))} ${new Date(m.t0 * 1000).toISOString().slice(11, 16)}–${new Date(m.t1 * 1000).toISOString().slice(11, 16)} UTC` +
        `${roadway ? ', the likeliest road route' : ''}</small>`).addTo(tripMap);
    pts.forEach(p => bounds.push(p));
    if (m.km < 300) pts.forEach(p => local.push(p));
  });
  d.flights.forEach(f => {
    const a = allAirports[f.from], z = allAirports[f.to];
    if (!a || !z) return;
    L.polyline(greatCircle(a.lat, a.lon, z.lat, z.lon), { color: col('accent'), weight: 2 * st.w, opacity: 0.8 })
      .bindPopup(`<b>✈️ ${escapeHTML(f.flight_number || '')} ${f.from} → ${f.to}</b><br><small>${fmtDate(f.date)}</small>`).addTo(tripMap);
    bounds.push([a.lat, a.lon], [z.lat, z.lon]);
  });
  const gids = new Set(d.ground.map(g => g.id));
  allTrips.filter(g => gids.has(g.id) && g.from_lat != null && g.to_lat != null).forEach(g => {
    const pts = g.path ? decodePath(g.path) : [[g.from_lat, g.from_lon], [g.to_lat, g.to_lon]];
    L.polyline(pts, { color: col(['train', 'bus', 'ferry'].includes(g.mode) ? g.mode : 'bus'), weight: 3 * st.w, opacity: 0.9, dashArray: g.path ? null : '6 6' })
      .bindPopup(`<b>${(groundModes[g.mode] || '🚌').split(' ')[0]} ${escapeHTML(g.from)} → ${escapeHTML(g.to)}</b><br><small>${fmtDate(g.date)}</small>`).addTo(tripMap);
    pts.forEach(p => { bounds.push(p); local.push(p); });
  });
  const aids = new Set(d.activities.map(a => a.id));
  allActivities.filter(a => aids.has(a.id) && a.pts).forEach(a => {
    const pts = [];
    for (let i = 0; i < a.pts.length; i += 2) pts.push([a.pts[i], a.pts[i + 1]]);
    L.polyline(pts, { color: col(a.kind || 'sport'), weight: 2.5 * st.w, opacity: Math.min(1, 0.85 * st.o) })
      .bindPopup(`<b>${escapeHTML(a.name || a.sport || '')}</b><br><small>${fmtDate(a.date)}</small><br>` +
        `<a href="#" onclick="event.preventDefault(); showActivityOnMap(${a.id})">Show on the big map →</a>`).addTo(tripMap);
    bounds.push(pts[0], pts[pts.length - 1]); local.push(pts[0], pts[pts.length - 1]);
  });
  d.stays.filter(s => s.lat != null).forEach(s => {
    L.circleMarker([s.lat, s.lon], { radius: 7 * st.r, color: '#fff', weight: 1.5, fillColor: col(s.what === 'car' ? 'car' : 'stay'), fillOpacity: 0.95 })
      .bindPopup(`<b>${s.what === 'car' ? '🚗' : '🏨'} ${escapeHTML(s.hotel || s.type || s.place || '')}</b><br><small>${tripRange(s.start, s.end)} · ${escapeHTML(s.provider || '')}</small>`)
      .addTo(tripMap);
    bounds.push([s.lat, s.lon]); local.push([s.lat, s.lon]);
  });
  const ids = new Set(d.photo_ids), photos = (allPhotoPoints || []).filter(p => ids.has(p[0]));
  if (photos.length) {
    const group = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 40,
      iconCreateFunction: c => L.divIcon({ html: `<span>${c.getChildCount().toLocaleString()}</span>`, className: 'photo-cluster', iconSize: [30, 30] }) });
    const icon = L.divIcon({ className: 'photo-dot', iconSize: [10, 10] });
    group.addLayers(photos.map(p => L.marker([p[2], p[3]], { icon }).bindPopup(() => photoPopup(p), { maxWidth: 260, minWidth: 240 })));
    tripMap.addLayer(group);
  } else if (ids.size && allPhotoPoints === null) {
    loadPhotoPoints();
    setTimeout(() => tripShown === d && drawTripMap(d, true), 4000);
  }
  if (view) tripMap.setView(view.c, view.z);
  else if (local.length || bounds.length) tripMap.fitBounds(L.latLngBounds(local.length ? local : bounds), { padding: [24, 24], maxZoom: 12 });
  else if (d.towns[0]) tripMap.setView([d.towns[0].lat || 0, d.towns[0].lon || 0], 8);
  setTimeout(() => tripMap && tripMap.invalidateSize(), 50);
}

window.addEventListener('load', () => {
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.addEventListener('click', () => {
    if (location.hash.startsWith('#trip=')) history.replaceState(null, '', location.pathname + location.search);
    if (b.dataset.tab === 'trips') renderTrips();
  }));
  const m = /^#trip=(\d{4}-\d\d-\d\d)$/.exec(location.hash);
  if (m) setTimeout(() => openTrip(m[1]), 300);
});
