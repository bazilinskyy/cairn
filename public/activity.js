'use strict';
// An activity's page: opened from a ride's or a run's name in its popup on the map, the Sports tab, or #activity=<id>.
// Its numbers, its route on a map with the photos taken and the famous climbs it went up, the profile of its timed track
// (height, speed, heart rate and power along the way, a line under the pointer reading them all), the weather on it,
// that night's sleep, the music played while it lasted and the trip it was part of. All from /api/activity/:id
// (activitypage.js). Uses the page's and layers.js's globals.

let activityShown = null, activityMap = null, activityAsked = 0;

async function openActivity(id) {
  const asked = ++activityAsked;
  const d = await fetch(`/api/activity/${encodeURIComponent(id)}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (asked !== activityAsked) return;  // another was asked for meanwhile
  if (!d) return toast('No page for this activity', 'error');
  activityShown = d;
  if (typeof map !== 'undefined' && map) map.closePopup();  // (opened from the address, the map is not there yet)
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-activity').classList.add('active');
  if (location.hash !== `#activity=${d.id}`) history.replaceState(null, '', `#activity=${d.id}`);
  renderActivity();
  window.scrollTo(0, 0);
}

function closeActivity(toMap = false) {
  history.replaceState(null, '', location.pathname + location.search);
  const id = activityShown?.id;
  document.querySelector(`.tab[data-tab="${toMap ? 'map' : tabOfPath()}"]`).click();  // else the tab it was opened from
  if (toMap && id) showActivityOnMap(Number(id));
}

const actDur = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`; };
const actClock = (unix, at) => new Date(unix * 1000).toISOString().slice(11, 16) + ' UTC';

function renderActivity() {
  const d = activityShown, kind = sportOf(d.sport), p = d.profile;
  const card = (label, value, sub = '') => (!value ? '' : `<div class="stat-card"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`);
  const section = (title, body, note = '') => `<div class="chart-section"><h3>${title}</h3>${body}${note ? `<p class="sp-note">${note}</p>` : ''}</div>`;
  const speed = kmh => `${(Math.round(dist(kmh) * 10) / 10).toLocaleString()} ${DU()}/h`;
  const where = d.from ? `${flagOf(d.from.cc)}<a href="#city=${d.from.id}" class="sp-link inline" onclick="event.preventDefault(); openCityReport(${d.from.id})">${escapeHTML(d.from.name)}</a>` +
    (d.loop || !d.to || d.to.id === d.from.id ? (d.loop ? ', a loop' : '') : ` → ${flagOf(d.to.cc)}<a href="#city=${d.to.id}" class="sp-link inline" onclick="event.preventDefault(); openCityReport(${d.to.id})">${escapeHTML(d.to.name)}</a>`) : '';
  document.getElementById('activity-title').textContent = `${sportEmoji[kind] || '🏅'} ${d.name}`;
  document.getElementById('activity-sub').innerHTML = [`${escapeHTML(d.sport)} · ${fmtDate(d.date)}, ${actClock(d.start)}`, where,
    d.trip ? `on ${typeof tripLink === 'function' ? tripLink(d.trip) : escapeHTML(d.trip.name)}` : ''].filter(Boolean).join(' · ');
  const moving = d.moving_time || d.elapsed_time, avg = moving ? d.distance / (moving / 3600) : 0;
  const night = d.day?.sleep ? `${actDur(d.day.sleep)}${d.day.score ? ` · score ${d.day.score}` : ''}` : '';
  let html = (d.path ? '<div class="chart-section" style="padding:0;overflow:hidden"><div id="activity-map" class="mini-map" style="height:380px"></div></div>' : '') +
    '<div class="stat-cards">' +
    card('Distance', d.distance ? fmtDist(d.distance, 1) : '') +
    card('Moving time', moving ? actDur(moving) : '', d.elapsed_time > moving + 60 ? `${actDur(d.elapsed_time)} in all` : '') +
    card('Average speed', avg ? speed(avg) : '', p?.maxKmh ? `max ${speed(p.maxKmh)}` : '') +
    card('Climbing', d.elevation ? fmtHeight(d.elevation) : '', p?.alt.max ? `${fmtHeight(p.alt.min)} – ${fmtHeight(p.alt.max)}` : '') +
    card('Heart rate', (p?.hr.avg || d.heartrate) ? `${p?.hr.avg || d.heartrate} bpm` : '', p?.hr.max ? `max ${p.hr.max}` : '') +
    card('Power', p?.power.avg ? `${p.power.avg} W` : '', p?.power.max ? `max ${p.power.max} W` : '') +
    card('Weather', d.weather ? weatherText(d.weather, true) : '') +
    card('Sleep the night before', night, d.day?.rhr ? `resting heart rate ${d.day.rhr}` : '') +
    card('Photos', d.photos.length ? d.photos.length.toLocaleString() : '') + '</div>';
  if (p?.points.length > 1) html += section('Along the way', '<div id="activity-profile" class="act-profile"></div>',
    'Height, speed, heart rate and power along the ride, from its timed track; move over it to read them at a point (and see where on the map).');
  if (d.climbs.length) html += section('Famous climbs', `<table class="sp-table"><thead><tr><th>Climb</th><th>Height</th></tr></thead><tbody>${d.climbs.map(c =>
    `<tr><td><a href="#climb=${c.id}" class="sp-link inline" onclick="event.preventDefault(); openClimb('${c.id}')">${flagOf(c.country)}${escapeHTML(c.name)}</a></td><td>${c.ele ? fmtHeight(c.ele) : ''}</td></tr>`).join('')}</tbody></table>`);
  if (d.photos.length) html += section(`Photos · ${d.photos.length}`, `<div class="act-photos">${d.photos.map(x =>
    `<a href="/api/photos/${x.id}/full" target="_blank" rel="noopener" title="${actClock(x.t)}"><img src="/api/photos/${x.id}/thumb" alt="" loading="lazy"></a>`).join('')}</div>`,
    'Taken while it lasted. Click one for the whole photo.');
  if (d.music.length) html += section(`Music · ${d.music.length} plays`, `<table class="sp-table"><tbody>${d.music.map(m =>
    `<tr><th>${actClock(m.t)}</th><td>${escapeHTML(m.artist)} – ${escapeHTML(m.name)}</td></tr>`).join('')}</tbody></table>`, 'What you played (Last.fm) while it lasted.');
  document.getElementById('activity-body').innerHTML = html;
  if (d.path) drawActivityMap(d, kind);
  if (p?.points.length > 1) drawActivityProfile(p, kind);
}

let activityCursor = null;
function drawActivityMap(d, kind) {
  if (activityMap) { try { activityMap.remove(); } catch (_) { /* never fully drawn */ } activityMap = null; }
  const box = document.getElementById('activity-map');
  box.dataset.basemap = BASEMAPS[prefs.basemap] ? prefs.basemap : 'auto';
  activityMap = L.map(box, { zoomControl: true, attributionControl: true });
  toneMap(activityMap);
  addBasemap(activityMap);
  const pts = decodePath(d.path), col = k => mapVar('--' + k);
  activityMap.fitBounds(pts, { padding: [24, 24] });
  L.polyline(pts, { color: col('text'), weight: 7, opacity: 0.7, interactive: false }).addTo(activityMap);
  L.polyline(pts, { color: col(kind), weight: 4, opacity: 1, interactive: false }).addTo(activityMap);
  L.circleMarker(pts[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#2e7d32', fillOpacity: 1 }).bindTooltip('Start').addTo(activityMap);
  if (!d.loop) L.circleMarker(pts[pts.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: '#c62828', fillOpacity: 1 }).bindTooltip('End').addTo(activityMap);
  d.photos.forEach(x => L.marker(x.at, { icon: L.divIcon({ className: 'photo-dot', iconSize: [10, 10] }) })
    .bindPopup(`<a href="/api/photos/${x.id}/full" target="_blank" rel="noopener"><img src="/api/photos/${x.id}/thumb" alt="" width="200"></a><br><small>📷 ${actClock(x.t)}</small>`)
    .addTo(activityMap));
  const climbsById = new Map((typeof allClimbs !== 'undefined' ? allClimbs : []).map(c => [c.id, c]));
  d.climbs.forEach(c => { const x = climbsById.get(c.id); if (x) L.circleMarker([x.lat, x.lon], { radius: 6, color: '#fff', weight: 1.5, fillColor: col('climb'), fillOpacity: 0.95 }).bindTooltip(`⛰️ ${escapeHTML(c.name)}`).addTo(activityMap); });
  activityCursor = L.circleMarker(pts[0], { radius: 7, color: col('text'), weight: 3, fillColor: col(kind), fillOpacity: 1, interactive: false });
  setTimeout(() => activityMap && activityMap.invalidateSize(), 50);
}

// Height (an area), speed, heart rate and power, each a band of its own along the distance; a line under the pointer
// reads them all and shows the spot on the map
function drawActivityProfile(p, kind) {
  const box = document.getElementById('activity-profile'), pts = p.points, W = 1000, PAD = 46;
  const series = [['alt', 'Height', v => fmtHeight(v), 90], ['kmh', 'Speed', v => `${(Math.round(dist(v) * 10) / 10).toLocaleString()} ${DU()}/h`, 60],
    ['hr', 'Heart rate', v => `${v} bpm`, 60], ['w', 'Power', v => `${v} W`, 60]].filter(([k]) => pts.some(x => x[k] > 0));
  const H = series.reduce((s, x) => s + x[3] + 18, 0), maxKm = pts[pts.length - 1].km || 1, xOf = km => PAD + (W - PAD - 8) * km / maxKm;
  let y = 0, svg = '';
  const color = { alt: mapVar('--' + kind), kmh: mapVar('--accent'), hr: '#e53935', w: '#fb8c00' };
  series.forEach(([k, label, fmt, h]) => {
    const vals = pts.map(x => x[k]).filter(v => v != null && v > 0), lo = k === 'alt' ? Math.min(...vals) : 0, hi = Math.max(...vals) || 1;
    const yOf = v => y + 16 + h - (h * (v - lo) / (hi - lo || 1));
    const line = pts.filter(x => x[k] != null).map(x => `${xOf(x.km).toFixed(1)},${yOf(Math.max(x[k], lo)).toFixed(1)}`).join(' ');
    svg += `<text x="${PAD}" y="${y + 11}" class="act-label">${label}</text><text x="${W - 8}" y="${y + 11}" text-anchor="end" class="act-label">${fmt(hi)}</text>` +
      (k === 'alt' ? `<polygon points="${xOf(0)},${y + 16 + h} ${line} ${xOf(maxKm)},${y + 16 + h}" fill="${color[k]}" fill-opacity="0.25" stroke="none"/>` : '') +
      `<polyline points="${line}" fill="none" stroke="${color[k]}" stroke-width="${k === 'alt' ? 2 : 1.5}" stroke-linejoin="round"/>` +
      `<line x1="${PAD}" x2="${W - 8}" y1="${y + 16 + h}" y2="${y + 16 + h}" class="act-axis"/>`;
    y += h + 18;
  });
  svg += `<text x="${PAD}" y="${H + 14}" class="act-label">0</text><text x="${W - 8}" y="${H + 14}" text-anchor="end" class="act-label">${fmtDist(maxKm, 1)}</text>` +
    `<line id="act-cross" x1="0" x2="0" y1="0" y2="${H}" class="act-cross" visibility="hidden"/>`;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H + 18}" role="img" aria-label="The activity's profile">${svg}</svg><div class="act-read" id="act-read">&nbsp;</div>`;
  const svgEl = box.querySelector('svg'), cross = box.querySelector('#act-cross'), read = box.querySelector('#act-read'), route = activityShown.path ? decodePath(activityShown.path) : [];
  const along = [0];  // km along the route at each of its points
  for (let i = 1; i < route.length; i++) along.push(along[i - 1] + L.latLng(route[i - 1]).distanceTo(route[i]) / 1000);
  const scale = along.length ? along[along.length - 1] / maxKm : 1;
  svgEl.addEventListener('mousemove', e => {
    const r = svgEl.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W, km = Math.max(0, Math.min(maxKm, (x - PAD) / (W - PAD - 8) * maxKm));
    const pt = pts.reduce((b, q) => (Math.abs(q.km - km) < Math.abs(b.km - km) ? q : b), pts[0]);
    cross.setAttribute('x1', xOf(pt.km)); cross.setAttribute('x2', xOf(pt.km)); cross.setAttribute('visibility', 'visible');
    read.textContent = [fmtDist(pt.km, 1), actDur(pt.s), ...series.map(([k, label, fmt]) => (pt[k] > 0 ? `${label.toLowerCase()} ${fmt(pt[k])}` : ''))].filter(Boolean).join(' · ');
    if (activityMap && activityCursor && route.length) {  // the route's point as far along (by distance)
      const want = pt.km * scale, i = Math.max(0, along.findIndex(k => k >= want));
      activityCursor.setLatLng(route[i]).addTo(activityMap);
    }
  });
  svgEl.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); read.innerHTML = '&nbsp;'; if (activityCursor) activityCursor.remove(); });
}

window.addEventListener('load', () => {
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.addEventListener('click', () => {
    if (location.hash.startsWith('#activity=')) history.replaceState(null, '', location.pathname + location.search);
  }));
  const m = /^#activity=(\d+)$/.exec(location.hash);
  if (m) setTimeout(() => openActivity(m[1]), 300);
});
