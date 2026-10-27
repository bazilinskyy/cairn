'use strict';
// A climb's page: opened from the Sports tab's list or a climb on the map (or #climb=<Wikidata id>). A small map of
// its ways up and your rides over it; per way up your times (with the FTP and weight of each day), your best, and how
// it compares with what your FTP and weight predict, with a top climber and with the record where one is known; a
// few lines from Wikipedia and links. Uses layers.js's and city.js's globals.

let climbMap = null;

const clock = s => {
  if (s == null) return '';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.round(s % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
};
const diff = s => (s == null ? '' : `${s < 0 ? '−' : '+'}${clock(Math.abs(s))}`);

async function openClimb(id) {
  const c = allClimbs.find(x => x.id === id);
  if (!c) return toast('No such climb', 'error');
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-climb').classList.add('active');
  if (location.hash !== `#climb=${id}`) history.replaceState(null, '', `#climb=${id}`);
  renderClimb(c);
  window.scrollTo(0, 0);
}

function closeClimb(toMap = false) {
  history.replaceState(null, '', location.pathname + location.search);
  document.querySelector(`.tab[data-tab="${toMap ? 'map' : 'sports'}"]`).click();
  const c = allClimbs.find(x => x.id === document.getElementById('tab-climb').dataset.id);
  if (toMap && c) setTimeout(() => map.setView([c.lat, c.lon], 12), 80);
}

function renderClimb(c) {
  const box = document.getElementById('tab-climb');
  box.dataset.id = c.id;
  const names = new Intl.DisplayNames(['en'], { type: 'region' }), country = cc => { try { return names.of(cc); } catch (_) { return cc || ''; } };
  document.getElementById('climb-title').innerHTML = `⛰️ ${flagOf(c.country)}${escapeHTML(c.name)}`;
  document.getElementById('climb-sub').textContent = [c.ele ? fmtHeight(c.ele) : '', country(c.country),
    c.times ? `climbed ${c.times} time${c.times !== 1 ? 's' : ''}, first ${fmtDate(c.first)}, last ${fmtDate(c.last)}` : 'not climbed yet'].filter(Boolean).join(' · ');
  const link = r => `<a href="#" class="sp-link" data-activity="${r.id}">${fmtDate(r.date)}</a>`;
  const section = (title, body, note = '') => `<div class="chart-section"><h3>${title}</h3>${body}${note ? `<p class="sp-note">${note}</p>` : ''}</div>`;
  const recordNote = r => `Record: ${escapeHTML(r.rider || '')}, ${escapeHTML(r.event || '')} ${r.year || ''}, ${escapeHTML(r.measured || '')}` +
    `${r.from_note ? ` (${escapeHTML(r.from_note)})` : ''} (<a href="${escapeHTML(r.source)}" target="_blank" rel="noopener">source</a>).` +
    `${r.note ? ` <span title="${escapeHTML(r.note)}">ⓘ</span>` : ''}`;
  const tile = (label, value, sub = '') => `<div class="stat-card"><div class="label">${label}</div><div class="value" style="font-size:20px">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  let html = `<div class="chart-section" style="padding:0;overflow:hidden"><div id="climb-map" style="height:320px"></div></div>` +
    '<div id="climb-photos"></div>';  // the photos taken on the way up, when they have come (climbPhotos)
  // your ride up: one effort on the map and as a profile, coloured by a metric
  const all = [...(c.ascents || []), ...(c.other || []).map(o => ({ ...o, from: o.via }))].flatMap(a => (a.efforts || []).map(e => ({ a, e })));
  if (all.length) {
    const best = all.reduce((x, y) => (y.e.seconds < x.e.seconds ? y : x));
    html += section('Your ride up',
      `<div class="sp-head" style="margin-bottom:10px;flex-wrap:wrap"><select id="climb-effort" aria-label="Effort">` +
      all.sort((x, y) => y.e.date.localeCompare(x.e.date)).map(({ a, e }) => `<option value="${escapeHTML(a.from)}|${e.id}" ${e === best.e && a === best.a ? 'selected' : ''}>` +
        `${/^via /.test(a.from) ? '' : 'from '}${escapeHTML(a.from)} · ${fmtDate(e.date)} · ${clock(e.seconds)}${e === best.e ? ' 🏆' : ''}</option>`).join('') +
      `</select><select id="climb-metric" aria-label="Colour by">${Object.entries(METRICS).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('')}</select></div>` +
      `<div class="chart-wrap tall"><canvas id="climb-profile"></canvas></div><div id="climb-scale" class="sp-legend"></div>`,
      'The line on the map and the profile are coloured by the metric chosen; hover the profile to see every metric at that point and where it is on the map.');
  }
  (c.ascents || []).forEach(a => {
    const best = a.best, rec = a.record;
    html += section(`From ${escapeHTML(a.from)} · ${fmtDist(a.length, 1)} · ${fmtHeight(a.gain)} · ${a.grade}%`,
      '<div class="stat-cards" style="margin-bottom:16px">' +
      tile('Your best', best ? clock(best.seconds) : '—', best ? `${fmtDate(best.date)}${best.wkg ? ` · ${best.wkg} W/kg` : ''}` : (a.times ? 'no timed track' : 'not ridden')) +
      tile('Your FTP would do', a.you ? clock(a.you.seconds) : '—', a.you ? `${a.you.ftp} W, ${a.you.kg} kg today` + (best ? ` · you ${diff(best.seconds - a.you.seconds)}` : '') : '') +
      (best?.predicted ? tile('That day\'s FTP would do', clock(best.predicted), `${best.ftp} W, ${best.kg} kg · you ${diff(best.seconds - best.predicted)}`) : '') +
      tile('A top climber', clock(a.pro.seconds), `about ${a.pro.wkg} W/kg` + (best ? ` · you ${diff(best.seconds - a.pro.seconds)}` : '')) +
      (rec ? tile('Record', clock(rec.seconds), `${escapeHTML(rec.rider || '')} ${rec.year || ''}` + (best ? ` · you ${diff(best.seconds - rec.seconds)}` : '')) : '') +
      '</div>' +
      (a.efforts.length ? `<div class="sp-scroll"><table class="sp-table"><thead><tr><th>Ride</th><th>Time</th><th>Power</th><th>W/kg</th><th>HR</th><th>VAM</th><th>FTP, kg that day</th><th>FTP would do</th><th>Weather</th></tr></thead><tbody>` +
        a.efforts.map((e, i) => `<tr><th>${link(e)}${i === 0 ? ' 🏆' : ''}<small>${escapeHTML(e.name || '')}</small></th><td><b>${clock(e.seconds)}</b></td>` +
          `<td>${e.power ? e.power + ' W' : ''}</td><td>${e.wkg ?? ''}</td><td>${e.hr ?? ''}</td><td>${Math.round(a.gain / (e.seconds / 3600)).toLocaleString()} m/h</td>` +
          `<td>${e.ftp ? e.ftp + ' W' : ''}${e.kg ? `, ${e.kg} kg` : ''}</td><td>${e.predicted ? `${clock(e.predicted)} <small>(${diff(e.seconds - e.predicted)})</small>` : ''}</td>` +
          `<td data-weather="${e.id}"></td></tr>`).join('') +
        '</tbody></table></div>' : (a.times ? `<p class="sp-note">Ridden ${a.times}× (${a.rides.map(link).join(', ')}), but those rides have no timed track.</p>` : '')),
      rec ? recordNote(rec) : '');
  });
  if (c.records?.length) html += section('Best known times', '<div class="stat-cards">' + c.records.map(r =>
    tile(`From ${escapeHTML(r.from)}`, clock(r.seconds), `${escapeHTML(r.rider || '')} ${r.year || ''}`)).join('') + '</div>',
    c.records.map(recordNote).join('<br>'));
  (c.other || []).forEach(o => {  // your own way up, from your tracks
    const b = o.best;
    html += section(`${escapeHTML(o.via)}${b?.length ? ` · ${fmtDist(b.length, 1)}` : ''}${b?.gain ? ` · ${fmtHeight(b.gain)} · ${Math.round(b.gain / b.length / 10 * 10) / 10}%` : ''}`,
      (b ? '<div class="stat-cards" style="margin-bottom:16px">' +
        tile('Your best', clock(b.seconds), `${fmtDate(b.date)}${b.wkg ? ` · ${b.wkg} W/kg` : ''}`) +
        (b.predicted ? tile('That day\'s FTP would do', clock(b.predicted), `${b.ftp} W, ${b.kg} kg · you ${diff(b.seconds - b.predicted)}`) : '') + '</div>' : '') +
      (o.efforts?.length ? `<div class="sp-scroll"><table class="sp-table"><thead><tr><th>Ride</th><th>Time</th><th>Power</th><th>W/kg</th><th>HR</th><th>VAM</th><th>FTP, kg that day</th><th>FTP would do</th><th>Weather</th></tr></thead><tbody>` +
        o.efforts.map((e, i) => `<tr><th>${link(e)}${i === 0 ? ' 🏆' : ''}<small>${escapeHTML(e.name || '')}</small></th><td><b>${clock(e.seconds)}</b></td>` +
          `<td>${e.power ? e.power + ' W' : ''}</td><td>${e.wkg ?? ''}</td><td>${e.hr ?? ''}</td><td>${e.gain ? Math.round(e.gain / (e.seconds / 3600)).toLocaleString() + ' m/h' : ''}</td>` +
          `<td>${e.ftp ? e.ftp + ' W' : ''}${e.kg ? `, ${e.kg} kg` : ''}</td><td>${e.predicted ? `${clock(e.predicted)} <small>(${diff(e.seconds - e.predicted)})</small>` : ''}</td>` +
          `<td data-weather="${e.id}"></td></tr>`).join('') +
        '</tbody></table></div>' : `<p>${o.rides.map(link).join(', ')}</p>`),
      'Your own way up, read from your rides\' heights: from where the road started to climb to the top.');
  });
  if (!c.known && c.times) html += section('Ways up', '<p class="sp-note">Still being worked out from the roads and the terrain.</p>');
  html += section('About', `<p id="climb-wiki" class="sp-note" style="font-size:13px">${c.wiki ? 'Loading…' : ''}</p>` +
    `<p>${c.wiki ? `<a href="${c.wiki}" target="_blank" rel="noopener">Wikipedia</a> · ` : ''}` +
    `<a href="https://climbfinder.com/en/search?q=${encodeURIComponent(c.name)}" target="_blank" rel="noopener">Climbfinder</a> · ` +
    `<a href="https://www.google.com/search?q=${encodeURIComponent(c.name + ' cycling climb record')}" target="_blank" rel="noopener">Records</a></p>`,
    'Your times: from passing the foot of a way up to passing its top, in the ride\'s timed track (Garmin). FTP of the day: Garmin\'s, from the ride\'s intensity factor; weight: your last weigh-in before it. Predicted times: a model of the power it takes to lift you and the bike (8 kg), roll and push the air, holding what an FTP gives for that long. Top climber: 60 kg at 6 W/kg for an hour.');
  document.getElementById('climb-body').innerHTML = html;
  hookLinks('climb-body');
  paginateTables('climb-body');
  drawClimbMap(c);
  climbPhotos(c);
  loadWeather().then(w => document.querySelectorAll('#climb-body [data-weather]').forEach(td => { td.innerHTML = weatherText(w[td.dataset.weather], true); }));
  const pick = document.getElementById('climb-effort'), metric = document.getElementById('climb-metric');
  if (pick) {
    metric.value = climbMetric;
    pick.addEventListener('change', () => showEffort(c));
    metric.addEventListener('change', () => { climbMetric = metric.value; drawEffort(); });
    showEffort(c);
  }
  if (c.wiki) wikiSummary(c.wiki).then(t => { const p = document.getElementById('climb-wiki'); if (p) p.textContent = t || ''; });
}

async function wikiSummary(url) {  // the first lines of the article (Wikipedia's page summary API)
  const m = /^https:\/\/(\w+)\.wikipedia\.org\/wiki\/(.+)$/.exec(url);
  if (!m) return '';
  try {
    const d = await fetch(`https://${m[1]}.wikipedia.org/api/rest_v1/page/summary/${m[2]}`).then(r => r.json());
    return d.extract || '';
  } catch (_) { return ''; }
}

// --- one effort: the line on the map and the profile, coloured by a metric ---

const METRICS = {
  speed: { label: 'Speed', unit: () => (imperial() ? 'mph' : 'km/h'), of: p => p.speed != null ? dist(p.speed) : null, digits: 1 },
  vam: { label: 'VAM (climbing speed)', unit: () => (imperial() ? 'ft/h' : 'm/h'), of: p => p.vam != null ? height(p.vam) : null, digits: 0 },
  grade: { label: 'Gradient', unit: () => '%', of: p => p.grade, digits: 1 },
  power: { label: 'Power', unit: () => 'W', of: p => p.power, digits: 0 },
  wkg: { label: 'Power per kg', unit: () => 'W/kg', of: p => p.wkg, digits: 1 },
  hr: { label: 'Heart rate', unit: () => 'bpm', of: p => p.hr, digits: 0 }
};
let climbMetric = 'speed', effortShown = null, effortLayer = null, effortChart = null, effortDot = null;

async function showEffort(c) {
  const [from, id] = document.getElementById('climb-effort').value.split('|');
  const d = await fetch(`/api/climbs/${c.id}/efforts/${id}?from=${encodeURIComponent(from)}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!d) return toast('No timed track for this ride', 'error');
  effortShown = d;
  // metrics this ride has (no power meter: no power)
  const metric = document.getElementById('climb-metric');
  [...metric.options].forEach(o => { o.disabled = !d.points.some(p => METRICS[o.value].of(p) != null); });
  if (metric.selectedOptions[0]?.disabled) { climbMetric = 'speed'; metric.value = 'speed'; }
  drawEffort();
}

// a value's colour: one hue, light for low and dark for high (the middle 90% of the ride's values spread over it)
function ramp(values) {
  const v = values.filter(x => x != null).sort((a, b) => a - b);
  const lo = v[Math.floor(v.length * 0.05)] ?? 0, hi = v[Math.floor(v.length * 0.95)] ?? 1;
  const light = [254, 215, 170], dark = [154, 52, 18];  // orange 200 to orange 800
  const at = x => {
    if (x == null) return 'rgba(128,128,128,0.6)';
    const f = Math.max(0, Math.min(1, (x - lo) / ((hi - lo) || 1)));
    return `rgb(${light.map((c, i) => Math.round(c + (dark[i] - c) * f)).join(',')})`;
  };
  return { at, lo, hi };
}

function drawEffort() {
  const d = effortShown, m = METRICS[climbMetric];
  if (!d || !climbMap) return;
  const vals = d.points.map(m.of), colour = ramp(vals);
  if (effortLayer) effortLayer.remove();
  effortLayer = L.layerGroup().addTo(climbMap);
  for (let i = 1; i < d.points.length; i++) {
    const a = d.points[i - 1], b = d.points[i];
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: colour.at(vals[i]), weight: 6, opacity: 1, interactive: false }).addTo(effortLayer);
  }
  effortDot = L.circleMarker([d.points[0].lat, d.points[0].lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#000', fillOpacity: 1 }).addTo(effortLayer);
  climbMap.fitBounds(L.latLngBounds(d.points.map(p => [p.lat, p.lon])).pad(0.1));
  // the profile: distance against height, its line coloured by the metric
  const x = d.points.map(p => dist(p.d / 1000)), y = d.points.map(p => (p.alt != null ? height(p.alt) : null));
  if (effortChart) effortChart.destroy();
  chartDefaults();
  effortChart = new Chart(document.getElementById('climb-profile'), {
    type: 'line',
    // the shading under the profile in one piece (filled per coloured piece it shows seams), the coloured line on top
    data: { labels: x, datasets: [
      { data: y, borderWidth: 4, pointRadius: 0, tension: 0.2, fill: false, segment: { borderColor: ctx => colour.at(vals[ctx.p1DataIndex]) } },
      { data: y, borderWidth: 0, pointRadius: 0, tension: 0.2, fill: 'origin', backgroundColor: 'rgba(237,137,54,0.14)' }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false, axis: 'x' },
      scales: { x: { type: 'linear', min: 0, max: x[x.length - 1], grid: { display: false }, title: { display: true, text: DU() }, ticks: { color: getCSSVar('--chart-tick') } },
        y: { grid: { color: getCSSVar('--chart-grid') }, title: { display: true, text: HU() }, ticks: { color: getCSSVar('--chart-tick') } } },
      plugins: { legend: { display: false }, tooltip: { displayColors: false, filter: item => item.datasetIndex === 0, callbacks: {
        title: items => `${items[0].parsed.x.toFixed(2)} ${DU()} · ${clock(d.points[items[0].dataIndex].t)}`,
        label: item => {
          const p = d.points[item.dataIndex];
          return [`Height ${Math.round(item.parsed.y).toLocaleString()} ${HU()}`,
            ...Object.values(METRICS).map(mm => { const v = mm.of(p); return v == null ? null : `${mm.label} ${v.toFixed(mm.digits)} ${mm.unit()}`; }).filter(Boolean)];
        } } } },
      onHover: (_e, items) => { const p = items[0] && d.points[items[0].index]; if (p && effortDot) effortDot.setLatLng([p.lat, p.lon]); }
    }
  });
  document.getElementById('climb-scale').innerHTML = `${m.label}: <span class="sp-swatch" style="background:${colour.at(colour.lo)}"></span> ` +
    `${colour.lo.toFixed(m.digits)} <span class="sp-swatch" style="width:60px;background:linear-gradient(90deg,${colour.at(colour.lo)},${colour.at(colour.hi)})"></span> ` +
    `${colour.hi.toFixed(m.digits)} ${m.unit()} · ${fmtDate(d.date)}, ${clock(d.seconds)}`;
}

// The photos you took on your rides up (and at the top): a strip of thumbnails, each opening the whole photo, and
// a camera dot each on the map
async function climbPhotos(c) {
  const list = await fetch(`/api/climbs/${c.id}/photos`).then(r => (r.ok ? r.json() : [])).catch(() => []);
  const box = document.getElementById('climb-photos');
  if (!list.length || !box || document.getElementById('tab-climb').dataset.id !== c.id) return;
  const when = p => `${fmtDate(new Date(p.t * 1000).toISOString().slice(0, 10))} ${new Date(p.t * 1000).toISOString().slice(11, 16)} UTC`;
  box.innerHTML = `<div class="chart-section"><h3>Photos on the way up · ${list.length}</h3><div class="climb-photos">` +
    list.map(p => `<a href="/api/photos/${p.id}/full" target="_blank" rel="noopener" title="${when(p)}${p.way ? ` · ${escapeHTML(/^via /.test(p.way) ? p.way : 'from ' + p.way)}` : ''}">` +
      `<img src="/api/photos/${p.id}/thumb" alt="${p.video ? 'Video' : 'Photo'} taken ${when(p)}" loading="lazy">${p.video ? '<span>🎬</span>' : ''}</a>`).join('') +
    `</div><p class="sp-note">Taken during your rides up, or at the top within 20 minutes of getting there, near the way up. Click one for the whole ${list.some(p => p.video) ? 'photo or video' : 'photo'}.</p></div>`;
  if (!climbMap) return;
  const icon = L.divIcon({ className: 'photo-dot', iconSize: [10, 10] });
  list.forEach(p => L.marker([p.lat, p.lon], { icon }).bindPopup(() => photoPopup([p.id, p.t, p.lat, p.lon, p.video]), { maxWidth: 260, minWidth: 240 }).addTo(climbMap));
}

function drawClimbMap(c) {
  if (climbMap) { climbMap.remove(); climbMap = null; }
  effortLayer = null;
  document.getElementById('climb-map').classList.add('mini-map');
  document.getElementById('climb-map').dataset.basemap = BASEMAPS[prefs.basemap] ? prefs.basemap : 'auto';
  climbMap = L.map('climb-map', { zoomControl: true, attributionControl: true });
  const b = BASEMAPS[prefs.basemap] || BASEMAPS.auto, [url, attribution, maxZoom = 19] = b.tiles;
  L.tileLayer(url, { attribution, maxZoom }).addTo(climbMap);
  const color = getCSSVar('--climb'), bounds = L.latLngBounds([[c.lat, c.lon]]);
  // your rides over it, thin; the ways up on top: yours solid, the others dashed
  const ids = new Set([...(c.rides || []).map(r => r.id)]);
  allActivities.filter(a => ids.has(a.id) && a.pts).forEach(a => {
    const pts = [];
    for (let i = 0; i < a.pts.length; i += 2) pts.push([a.pts[i], a.pts[i + 1]]);
    L.polyline(pts, { color: getCSSVar('--ride'), weight: 2, opacity: 0.6 }).addTo(climbMap);
  });
  (c.ascents || []).forEach(a => {
    const line = L.polyline(decodePath(a.path), a.times ? { color, weight: 5, opacity: 0.9 } : { color, weight: 3, opacity: 0.8, dashArray: '6 6' })
      .bindTooltip(`from ${escapeHTML(a.from)}`, { sticky: true }).addTo(climbMap);
    bounds.extend(line.getBounds());
  });
  (c.other || []).filter(o => o.path).forEach(o => {
    const line = L.polyline(decodePath(o.path), { color, weight: 5, opacity: 0.9 }).bindTooltip(escapeHTML(o.via), { sticky: true }).addTo(climbMap);
    bounds.extend(line.getBounds());
  });
  L.circleMarker([c.lat, c.lon], { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).bindTooltip(escapeHTML(c.name)).addTo(climbMap);
  climbMap.fitBounds(bounds.pad(0.1), { maxZoom: 13 });
  setTimeout(() => climbMap.invalidateSize(), 50);
}

window.addEventListener('load', () => {
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.addEventListener('click', () => {
    if (location.hash.startsWith('#climb=')) history.replaceState(null, '', location.pathname + location.search);
  }));
  const m = /^#climb=(Q\d+)$/.exec(location.hash);
  if (m) {  // once the climbs have loaded (after the activities)
    const wait = setInterval(() => { if (allClimbs.length) { clearInterval(wait); openClimb(m[1]); } }, 300);
    setTimeout(() => clearInterval(wait), 120000);
  }
});
