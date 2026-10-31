'use strict';
// A town's report page: opened from a city on the map (or #city=<GeoNames id>), it lists the visits there and what
// you did: stays and rental cars, flights, trains, buses and ferries, sports activities, photos, Timeline places.
// Uses the page's and layers.js's globals (win, fmtDate, nights, flagOf, dist, DU, groundModes, linkTo, hookLinks, and
// the map data: allActivities, allTrips, allStays, allAirports, allClimbs, allPhotoPoints).

let cityShown = null;  // the report's data

async function openCityReport(id) {
  const q = new URLSearchParams({ from: win.from, to: win.to }).toString();
  const d = await fetch(`/api/city/${id}?${q}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!d) return toast('No report for this town', 'error');
  cityShown = d;
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-city').classList.add('active');
  if (location.hash !== `#city=${id}`) history.replaceState(null, '', `#city=${id}`);
  renderCityReport();
  window.scrollTo(0, 0);
}

function closeCityReport(toTown = false) {
  history.replaceState(null, '', location.pathname + location.search);
  document.querySelector('.tab[data-tab="map"]').click();
  if (toTown && cityShown) setTimeout(() => map.setView([cityShown.town.lat, cityShown.town.lon], 12), 80);
}

function renderCityReport() {
  const d = cityShown, t = d.town;
  const range = (a, b) => (b && b !== a ? `${fmtDate(a)} – ${fmtDate(b)}` : fmtDate(a));
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n !== 1 ? 's' : ''}`;
  const inVisit = (v, date) => date && date.slice(0, 10) >= v.start && date.slice(0, 10) <= v.end;
  const stays = d.stays.filter(s => s.what !== 'car'), cars = d.stays.filter(s => s.what === 'car');
  const km = d.activities.reduce((n, a) => n + (a.distance || 0), 0);
  const photos = Math.max(d.photos.reduce((n, p) => n + p.count, 0), (d.photo_ids || []).length);  // the photo places, or the photo index
  document.getElementById('city-title').innerHTML = `<span id="city-flag"></span>🏙️ ${countryLink(t.country, flagOf(t.country))}${escapeHTML(t.name)}`;
  // its own flag (or coat of arms), from Wikidata
  fetch(`/api/city/${t.id}/flag`).then(r => (r.ok ? r.json() : null)).catch(() => null).then(f => {
    const box = document.getElementById('city-flag');
    if (f && box && cityShown === d) box.innerHTML = `<img class="page-flag" src="${escapeHTML(f.url)}" alt="" title="${escapeHTML(t.name)}'s ${f.kind} (Wikimedia Commons, via Wikidata)" onerror="this.remove()">`;
  });
  document.getElementById('city-sub').textContent = (win.from || win.to ? `${win.from || '…'} to ${win.to || '…'} · ` : '') +
    (d.days ? `first ${fmtDate(d.first)}, last ${fmtDate(d.last)}` : 'no days there in this period');

  const card = (label, value, sub = '') => (value === '0' ? '' : `<div class="stat-card"><div class="label">${label}</div><div class="value">${value}</div>` +
    (sub ? `<div class="sub">${sub}</div>` : '') + '</div>');  // nothing of that kind there: no card
  const section = (title, body, note = '') => `<div class="chart-section"><h3>${title}</h3><div class="sp-scroll">${body}</div>` +
    (note ? `<p class="sp-note">${note}</p>` : '') + '</div>';
  const table = (head, rows) => `<table class="sp-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.join('')}</tbody></table>`;
  let html = `<div class="chart-section" style="padding:0;overflow:hidden"><div id="city-map" class="mini-map" style="height:340px"></div></div>` +
    '<div class="stat-cards">' +
    card('Days', d.days.toLocaleString(), plural(d.visits.length, 'visit')) +
    card('Nights in stays', stays.reduce((n, s) => n + nights(s), 0).toLocaleString(), plural(stays.length, 'stay')) +
    card('Flights', d.flights.length.toLocaleString(), `${d.flights.filter(f => f.direction === 'in').length} in, ${d.flights.filter(f => f.direction === 'out').length} out`) +
    card('Trains, buses, ferries', d.ground.length.toLocaleString()) +
    card('Activities', d.activities.length.toLocaleString(), `${Math.round(dist(km)).toLocaleString()} ${DU()}`) +
    card('Photos', photos.toLocaleString(), d.photos.length ? plural(d.photos.length, 'day') : '') + '</div>' +
    '<div id="city-photos"></div>';  // the photos taken in and around the town (cityPhotos)

  if (d.visits.length) {
    html += section('Visits', table(['When', 'Days', 'What you did', 'Trip'], d.visits.map(v => {
      const did = [
        [d.stays.filter(s => s.what !== 'car' && s.start <= v.end && (s.end || s.start) >= v.start).length, '🏨'],
        [d.flights.filter(f => inVisit(v, f.date)).length, '✈️'],
        [d.ground.filter(g => inVisit(v, g.date)).length, '🚆'],
        [d.activities.filter(a => inVisit(v, a.date)).length, '🏃'],
        [d.photos.filter(p => inVisit(v, p.day)).reduce((n, p) => n + p.count, 0), '📷']
      ].filter(([n]) => n).map(([n, icon]) => `${icon} ${n}`).join(' · ');
      const trip = tripOn(v.start);
      return `<tr><th>${range(v.start, v.end)}</th><td>${v.days}</td><td>${did}</td><td>${trip ? tripLink(trip) : ''}</td></tr>`;
    })), 'A visit is a run of days in a row there; ✈️ flights, 🚆 trains, buses and ferries, 🏃 activities, 📷 photos on those days.');
  }
  if (d.stays.length) {
    html += section('Stays and rental cars', table(['When', 'Nights', 'Where', 'Booked'], d.stays.map(s =>
      `<tr><th>${s.what === 'car' ? '🚗' : '🏨'} ${range(s.start, s.end)}</th><td>${nights(s)}${awayNote(s)}</td>` +
      `<td><b>${escapeHTML(s.hotel || s.type || (s.what === 'car' ? 'Rental car' : 'Stay'))}</b><small>${escapeHTML(s.place || '')}</small></td>` +
      `<td>${escapeHTML(s.provider || '')}${s.price ? `<small>${escapeHTML(s.price)}</small>` : ''}</td></tr>`)),
      cars.length ? `${plural(cars.length, 'rental car')} among them.` : '');
  }
  if (d.flights.length) {
    html += section('Flights', table(['When', 'Flight', 'Route', ''], d.flights.map(f =>
      `<tr><th>${fmtDate(f.date)}</th><td><b>${escapeHTML(f.flight_number || '')}</b><small>${escapeHTML(f.airline || '')}</small></td>` +
      `<td>${escapeHTML(f.from_city || f.from)} (${escapeHTML(f.from)}) → ${escapeHTML(f.to_city || f.to)} (${escapeHTML(f.to)})</td>` +
      `<td>${f.direction === 'in' ? 'arrived' : 'left'}</td></tr>`)));
  }
  if (d.ground.length) {
    html += section('Trains, buses and ferries', table(['When', '', 'Route', DU()], d.ground.map(g =>
      `<tr><th>${fmtDate(g.date)}</th><td>${(groundModes[g.mode] || '🚌').split(' ')[0]}</td>` +
      `<td>${escapeHTML(g.from)} → ${escapeHTML(g.to)}</td><td>${g.distance ? Math.round(dist(g.distance)).toLocaleString() : ''}</td></tr>`)));
  }
  if (d.activities.length) {
    const bySport = {};
    d.activities.forEach(a => {
      const s = bySport[a.sport] = bySport[a.sport] || { n: 0, km: 0 };
      s.n++; s.km += a.distance || 0;
    });
    const sports = Object.entries(bySport).sort((a, b) => b[1].n - a[1].n)
      .map(([s, v]) => `${escapeHTML(s)}: ${v.n} (${Math.round(dist(v.km)).toLocaleString()} ${DU()})`).join(' · ');
    html += section('Sports activities', table(['When', 'Activity', DU(), 'Time', 'Climb'], d.activities.slice(0, 200).map(a =>
      `<tr><th>${fmtDate(a.date)}</th><td>${linkTo(a)}<small>${escapeHTML(a.sport)}${a.trainer ? ' · indoor' : ''}</small></td>` +
      `<td>${(Math.round(dist(a.distance || 0) * 10) / 10).toLocaleString()}</td>` +
      `<td>${a.moving_time ? `${Math.floor(a.moving_time / 3600)}:${String(Math.round(a.moving_time % 3600 / 60)).padStart(2, '0')}` : ''}</td>` +
      `<td>${a.elevation ? fmtHeight(a.elevation) : ''}</td></tr>`)),
      sports + (d.activities.length > 200 ? ` · the newest 200 are listed` : '') + ' · started there; click one for its route.');
  }
  if (d.photos.length) {
    const months = {};
    d.photos.forEach(p => {
      const m = months[p.day.slice(0, 7)] = months[p.day.slice(0, 7)] || { n: 0, days: 0 };
      m.n += p.count; m.days++;
    });
    html += section('Photos', table(['Month', 'Photos', 'Days'], Object.entries(months).map(([m, v]) =>
      `<tr><th>${new Date(m + '-15T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</th>` +
      `<td>${v.n.toLocaleString()}</td><td>${v.days}</td></tr>`)), 'From the photo places import; counts per day are spread over a place’s days.');
  }
  if (d.music?.plays) html += musicSection(d.music, 'Music played here', 'What you played on Last.fm on your days here');
  if (d.timeline.length) {
    html += section('Google Timeline places', table(['When', 'Place'], d.timeline.slice(0, 200).map(v =>
      `<tr><th>${range(v.start, v.end)}</th><td>${escapeHTML(v.name || '')}</td></tr>`)));
  }
  document.getElementById('city-body').innerHTML = html;
  hookLinks('city-body');
  paginateTables('city-body');
  drawCityMap(d);
}

// The town on a small map you can drag and zoom: what the report lists (activities, trains, buses and ferries, stays,
// the airports of its flights) and the photos and famous climbs around it, each with its popup
const CITY_PHOTO_KM = 15, CITY_CLIMB_KM = 30;
let cityMap = null;
function drawCityMap(d) {
  if (cityMap) { cityMap.remove(); cityMap = null; }
  const box = document.getElementById('city-map'), t = d.town;
  box.dataset.basemap = BASEMAPS[prefs.basemap] ? prefs.basemap : 'auto';
  cityMap = L.map(box, { zoomControl: true, attributionControl: true }).setView([t.lat, t.lon], 12);
  toneMap(cityMap);
  const b = BASEMAPS[prefs.basemap] || BASEMAPS.auto, [url, attribution, maxZoom = 19] = b.tiles;
  L.tileLayer(url, { attribution, maxZoom }).addTo(cityMap);
  const st = lineStyle(), col = k => mapVar('--' + k);
  const near = (lat, lon, maxKm) => Math.hypot(lat - t.lat, (lon - t.lon) * Math.cos(t.lat * Math.PI / 180)) * 111.2 <= maxKm;
  const acts = new Set(d.activities.map(a => a.id));
  allActivities.filter(a => acts.has(a.id) && a.pts).forEach(a => {
    const pts = [];
    for (let i = 0; i < a.pts.length; i += 2) pts.push([a.pts[i], a.pts[i + 1]]);
    L.polyline(pts, { color: col(a.kind || 'sport'), weight: 2.5 * st.w, opacity: Math.min(1, 0.75 * st.o) })
      .bindPopup(`<b>${escapeHTML(a.name || a.sport || '')}</b><br><small>${fmtDate(a.date)}</small><br><a href="#" onclick="event.preventDefault(); showActivityOnMap(${a.id})">Show on the big map →</a>`).addTo(cityMap);
  });
  const ground = new Set(d.ground.map(g => g.id));
  allTrips.filter(g => ground.has(g.id) && g.from_lat != null && g.to_lat != null).forEach(g => {
    L.polyline(g.path ? decodePath(g.path) : [[g.from_lat, g.from_lon], [g.to_lat, g.to_lon]],
      { color: col(g.mode in { train: 1, bus: 1, ferry: 1, hitch: 1 } ? g.mode : 'bus'), weight: 3 * st.w, opacity: 0.85, dashArray: g.path ? null : '6 6' })
      .bindPopup(`<b>${(groundModes[g.mode] || '🚌').split(' ')[0]} ${escapeHTML(g.from)} → ${escapeHTML(g.to)}</b><br><small>${fmtDate(g.date)}</small>`).addTo(cityMap);
  });
  const stays = new Set(d.stays.map(s => s.id));
  allStays.filter(s => stays.has(s.id) && s.lat != null).forEach(s => {
    const c = col(s.what === 'car' ? 'car' : 'stay');
    L.circleMarker([s.lat, s.lon], { radius: 7 * st.r, color: '#fff', weight: 1.5, fillColor: c, fillOpacity: 0.9 })
      .bindPopup(`<b>${s.what === 'car' ? '🚗' : '🏨'} ${escapeHTML(s.hotel || s.type || s.place || '')}</b><br><small>${fmtDate(s.start)}` +
        `${s.end && s.end !== s.start ? ' – ' + fmtDate(s.end) : ''} · ${escapeHTML(s.provider || '')}</small>`).addTo(cityMap);
  });
  [...new Set(d.flights.map(f => (f.direction === 'in' ? f.to : f.from)))].filter(code => allAirports[code]).forEach(code => {
    const ap = allAirports[code], n = d.flights.filter(f => f.to === code || f.from === code).length;
    L.circleMarker([ap.lat, ap.lon], { radius: 8 * st.r, color: '#fff', weight: 1.5, fillColor: col('accent'), fillOpacity: 0.9 })
      .bindPopup(`<b>✈️ ${escapeHTML(ap.name)} (${code})</b><br><small>${n} flight${n !== 1 ? 's' : ''}</small>`).addTo(cityMap);
  });
  allClimbs.filter(c => near(c.lat, c.lon, CITY_CLIMB_KM)).forEach(c => {
    const done = climbDone(c);
    L.circleMarker([c.lat, c.lon], { radius: (done ? 6 : 5) * st.r, color: done ? '#fff' : col('climb'), weight: 1.5, fillColor: col('climb'), fillOpacity: done ? 0.95 : 0 })
      .bindPopup(`<b>⛰️ ${escapeHTML(c.name)}</b><br><small>${done ? `climbed ${c.times}×` : 'not climbed yet'}</small>` +
        `<br><a href="#" onclick="event.preventDefault(); openClimb('${c.id}')">Open climb page →</a>`).addTo(cityMap);
  });
  const photos = cityPhotoList(t);
  cityPhotos(photos);
  if (photos.length) {
    const group = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 40,
      iconCreateFunction: c => L.divIcon({ html: `<span>${c.getChildCount().toLocaleString()}</span>`, className: 'photo-cluster', iconSize: [30, 30] }) });
    const icon = L.divIcon({ className: 'photo-dot', iconSize: [10, 10] });
    group.addLayers(photos.map(p => L.marker([p[2], p[3]], { icon }).bindPopup(() => photoPopup(p), { maxWidth: 260, minWidth: 240 })));
    cityMap.addLayer(group);
  } else if (allPhotoPoints === null) loadPhotoPoints().then(() => cityShown === d && drawCityMap(d));
  setTimeout(() => cityMap && cityMap.invalidateSize(), 50);
}

// The photos of the period taken within CITY_PHOTO_KM of the town, newest first: those on its map
function cityPhotoList(t) {
  const near = p => Math.hypot(p[2] - t.lat, (p[3] - t.lon) * Math.cos(t.lat * Math.PI / 180)) * 111.2 <= CITY_PHOTO_KM;
  return (allPhotoPoints || []).filter(p => inWin(photoDay(p)) && near(p)).sort((a, b) => b[1] - a[1]);
}

// A gallery under the cards: the photos taken in the town (as its days count them: the town that pulls hardest),
// then, on asking, those around it on its map; a page of CITY_PHOTOS_PAGE at a time (only that page's thumbnails are
// asked for), each opening the whole photo or video
const CITY_PHOTOS_PAGE = 24;
function cityPhotos(all, page = 0, around = false) {
  const box = document.getElementById('city-photos');
  if (!box) return;
  const mine = new Set(cityShown?.photo_ids || []), inTown = all.filter(p => mine.has(p[0])), list = around ? all : inTown;
  const others = all.length - inTown.length, name = escapeHTML(cityShown?.town.name || 'the town');
  if (!list.length && !others) { box.innerHTML = ''; return; }
  const pages = Math.max(1, Math.ceil(list.length / CITY_PHOTOS_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const when = p => (p[5] === 'y' ? `${new Date(p[1] * 1000).getUTCFullYear()}` : `${fmtDate(photoDay(p))} ${new Date(p[1] * 1000).toISOString().slice(11, 16)} UTC`);
  // the page buttons: the first, the last, and the two either side of this one
  const nums = [...new Set([0, page - 2, page - 1, page, page + 1, page + 2, pages - 1])].filter(n => n >= 0 && n < pages).sort((a, b) => a - b);
  const pager = pages > 1 ? `<div class="photo-pager">` +
    `<button class="btn btn-ghost" data-page="${page - 1}" ${page ? '' : 'disabled'} aria-label="Previous page">‹</button>` +
    nums.map((n, i) => `${i && n - nums[i - 1] > 1 ? '<span>…</span>' : ''}<button class="btn ${n === page ? 'btn-primary' : 'btn-ghost'}" data-page="${n}"` +
      `${n === page ? ' aria-current="page"' : ''}>${n + 1}</button>`).join('') +
    `<button class="btn btn-ghost" data-page="${page + 1}" ${page < pages - 1 ? '' : 'disabled'} aria-label="Next page">›</button></div>` : '';
  const toggle = others ? `<button class="btn btn-ghost sp-more" id="city-photos-around">${around ? `Only those in ${name}` : `Also the ${others.toLocaleString()} taken around it`}</button>` : '';
  box.innerHTML = `<div class="chart-section"><h3>Photos ${around ? 'in and around' : 'in'} ${name} · ${list.length.toLocaleString()}` +
    `${pages > 1 ? ` <small style="text-transform:none;font-weight:400">page ${page + 1} of ${pages}</small>` : ''}</h3>` +
    (list.length ? '<div class="climb-photos">' + list.slice(page * CITY_PHOTOS_PAGE, (page + 1) * CITY_PHOTOS_PAGE).map(p =>
      `<a href="/api/photos/${p[0]}/full" target="_blank" rel="noopener" title="${when(p)}">` +
      `<img src="/api/photos/${p[0]}/thumb" alt="${p[4] ? 'Video' : 'Photo'} taken ${when(p)}" loading="lazy" decoding="async">${p[4] ? '<span>🎬</span>' : ''}</a>`).join('') + '</div>' : '') +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${pager}${toggle}</div>` +
    `<p class="sp-note">Newest first${win.from || win.to ? ', in this period' : ''}. In the town: the photos it counts as yours there, as for its days; around it: the rest of the 📷 marks on the map, within ${fmtDist(CITY_PHOTO_KM)}. Click one for the whole ${list.some(p => p[4]) ? 'photo or video' : 'photo'}.</p></div>`;
  box.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => {
    cityPhotos(all, +b.dataset.page, around);
    box.scrollIntoView({ block: 'nearest' });
  }));
  document.getElementById('city-photos-around')?.addEventListener('click', () => cityPhotos(all, 0, !around));
}

window.addEventListener('load', () => {
  // leaving the report by a tab or an activity link: the address no longer points at it
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.addEventListener('click', () => {
    if (location.hash.startsWith('#city=')) history.replaceState(null, '', location.pathname + location.search);
  }));
  const m = /^#city=(\d+)$/.exec(location.hash);
  if (m) setTimeout(() => openCityReport(+m[1]), 300);  // once the page's data has loaded
});
