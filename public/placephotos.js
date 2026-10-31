'use strict';
// Placing photos by hand (#place-photos): the library's photos with no place (/api/photos/unplaced), by day, with the
// albums they are in. Select one or many (a click, shift-click for a run, a day's or an album's at once), then place them
// in a town (search, or the town Cairn has you in that day), drag them onto the map at the exact spot, or put each at the
// spot of a photo with a place taken within half an hour of it (📍 on the photo: a camera beside the phone). Each placing
// can be undone. Uses the page's globals (escapeHTML, fmtDate, BASEMAPS, prefs, toneMap, toast).

const PP_DAYS = 40;  // days drawn at a time
let pp = null;       // { photos, albums, days, shown (filtered list), selected: Set, last: index, map, markers, undo: [] }

async function openPlacePhotos() {
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === 'trips'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-place-photos').classList.add('active');
  if (location.hash !== '#place-photos') history.replaceState(null, '', '#place-photos');
  const box = document.getElementById('pp-body');
  box.innerHTML = '<p class="sp-note">Gathering your photos with no place…</p>';
  const d = await fetch('/api/photos/unplaced').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!d) { box.innerHTML = '<p class="sp-note">Could not load the photos.</p>'; return; }
  pp = { ...d, selected: new Set(), last: -1, limit: PP_DAYS, undo: pp?.undo || [], markers: null, map: pp?.map || null };
  window.scrollTo(0, 0);
  const years = [...new Set(d.photos.filter(p => p.t).map(p => new Date(p.t * 1000).getUTCFullYear()))].sort();
  const albumCount = new Map();
  d.photos.forEach(p => p.albums.forEach(a => albumCount.set(a, (albumCount.get(a) || 0) + 1)));
  box.innerHTML = `
    <div id="pp-auto" class="sp-note"></div>
    <div class="pp-bar">
      <b id="pp-count"></b>
      <select id="pp-album" aria-label="Album"><option value="">All albums</option><option value="none">Not in an album</option>${
        d.albums.map((a, i) => [a, i]).filter(([, i]) => albumCount.get(i)).sort((x, y) => x[0].localeCompare(y[0]))
          .map(([a, i]) => `<option value="${i}">${escapeHTML(a)} (${albumCount.get(i)})</option>`).join('')}</select>
      <select id="pp-year" aria-label="Year"><option value="">All years</option>${years.map(y => `<option>${y}</option>`).join('')}<option value="0">No date</option></select>
      <label class="pp-nearonly" title="Taken within half an hour of a photo with a place"><input type="checkbox" id="pp-nearonly"> Only 📍 near a photo with a place (<span id="pp-nearcount"></span>)</label>
      <button class="btn btn-ghost" onclick="ppSelectShown()">Select all shown</button>
      <button class="btn btn-ghost" onclick="ppClear()">Clear</button>
    </div>
    <div class="pp-cols">
      <div id="pp-grid"></div>
      <div class="pp-side">
        <div class="chart-section pp-panel">
          <div id="pp-sel">Nothing selected</div>
          <div id="pp-nearsel"></div>
          <input id="pp-town" type="search" placeholder="Place them in a town…" autocomplete="off" aria-label="Town">
          <div id="pp-towns"></div>
          <p class="sp-note">Or drag photos onto the map to place them at that exact spot. Dragging a selected photo moves
            all of the selection; double-click a photo to see it whole.</p>
          <div id="pp-map" class="mini-map"></div>
          <div id="pp-undo"></div>
          <p class="sp-note">Places are kept in Cairn at once and written into Apple Photos on this Mac in the background.
            ${d.placed ? `${d.placed.toLocaleString()} placed so far.` : ''}</p>
        </div>
      </div>
    </div>`;
  document.getElementById('pp-album').onchange = document.getElementById('pp-year').onchange = document.getElementById('pp-nearonly').onchange = () => { pp.limit = PP_DAYS; ppFilter(); };
  let timer = null;
  document.getElementById('pp-town').oninput = e => { clearTimeout(timer); timer = setTimeout(() => ppTowns(e.target.value), 250); };
  ppMap();
  ppFilter();
  ppUndoBar();
  ppAuto();
}

// the ones Cairn can place by itself (/api/photos/auto): near a photo with a place, or on a day all else puts you in one
// town; kept in Cairn only (a guess), all taken back at once
async function ppAuto() {
  const a = await fetch('/api/photos/auto').then(r => (r.ok ? r.json() : null)).catch(() => null), box = document.getElementById('pp-auto');
  if (!a || !box) return;
  const n = x => x.toLocaleString();
  box.innerHTML = (a.total ? `Cairn can place ${n(a.total)} of these by itself: ${n(a.near)} taken within half an hour of a photo with a place, ` +
      `${n(a.day + a.between)} on days when all else puts you in one town (at that town). Not batches copied or posted at once (their times are not when they were taken), ` +
      `and kept in Cairn only, not written into Photos. <button class="btn btn-ghost" onclick="ppAutoGo()">Place them</button> ` : '') +
    (a.placed ? `${n(a.placed)} placed by Cairn so far. <button class="btn btn-ghost" onclick="ppAutoGo(true)">Take them back</button>` : '');
}
async function ppAutoGo(undo) {
  const r = await fetch('/api/photos/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ undo: !!undo }) })
    .then(x => (x.ok ? x.json() : null)).catch(() => null);
  if (!r) return toast('Could not place them');
  toast(undo ? `Took back ${r.removed.toLocaleString()} places` : `Placed ${r.placed.toLocaleString()} photos`);
  openPlacePhotos();
}

// the photos the filters leave, and the grid of them by day
function ppFilter() {
  const album = document.getElementById('pp-album').value, year = document.getElementById('pp-year').value, nearOnly = document.getElementById('pp-nearonly').checked;
  pp.shown = pp.photos.filter(p => (album === '' || (album === 'none' ? !p.albums.length : p.albums.includes(+album))) && (!nearOnly || p.near)
    && (year === '' || (year === '0' ? !p.t : p.t && new Date(p.t * 1000).getUTCFullYear() === +year)));
  pp.last = -1;
  ppDraw();
}

function ppDraw() {
  const grid = document.getElementById('pp-grid'), byDay = new Map();
  pp.shown.forEach((p, i) => { const d = p.t ? new Date(p.t * 1000).toISOString().slice(0, 10) : ''; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push([p, i]); });
  const days = [...byDay.entries()];
  grid.innerHTML = days.slice(0, pp.limit).map(([day, list]) => {
    const albums = [...new Set(list.flatMap(([p]) => p.albums))].map(a => pp.albums[a]);
    const at = pp.days[day], near = list.filter(([p]) => p.near).length;
    return `<div class="pp-day" data-day="${day}">
      <div class="pp-day-head">
        <label><input type="checkbox" onchange="ppSelectDay('${day}', this.checked)"> <b>${day ? fmtDate(day) : 'No date'}</b> · ${list.length}</label>
        ${albums.length ? `<small>in ${albums.slice(0, 3).map(escapeHTML).join(', ')}${albums.length > 3 ? ` +${albums.length - 3}` : ''}</small>` : ''}
        ${at ? `<button class="btn btn-ghost pp-here" title="Cairn has you in ${escapeHTML(at.name)} that day" onclick="ppPlaceDay('${day}')">📍 ${flagOf(at.cc)}${escapeHTML(at.name)}</button>` : ''}
        ${near ? `<button class="btn btn-ghost pp-here" title="Each where a photo with a place was taken within half an hour of it" onclick="ppPlaceDayNear('${day}')">📍 ${near} at nearby photos' spots</button>` : ''}
      </div>
      <div class="pp-thumbs">${list.map(([p, i]) => `<div class="pp-ph${pp.selected.has(p.id) ? ' sel' : ''}" data-id="${p.id}" data-i="${i}" draggable="true"
        title="${escapeHTML(p.name || '')}${p.t ? ' · ' + new Date(p.t * 1000).toISOString().slice(11, 16) : ''}${p.albums.length ? ' · ' + escapeHTML(p.albums.map(a => pp.albums[a]).join(', ')) : ''}">
        <img loading="lazy" src="/api/photos/unplaced/${p.id}/thumb" alt="">${p.video ? '<span class="pp-video">▶</span>' : ''}${p.near ? `<span class="pp-near" title="${ppNearText(p.near)}">📍</span>` : ''}</div>`).join('')}</div>
    </div>`;
  }).join('') + (days.length > pp.limit ? `<button class="btn btn-ghost" onclick="pp.limit += ${PP_DAYS}; ppDraw()">Show more days (${days.length - pp.limit} left)</button>` : '')
    + (!days.length ? '<p class="sp-note">No photos without a place here.</p>' : '');
  grid.querySelectorAll('.pp-ph').forEach(el => {
    el.onclick = e => ppClick(el, e);
    el.ondblclick = () => window.open(`/api/photos/unplaced/${el.dataset.id}/full`, '_blank');
    el.ondragstart = e => {
      const ids = pp.selected.has(el.dataset.id) ? [...pp.selected] : [el.dataset.id];
      e.dataTransfer.setData('text/plain', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
    };
  });
  ppCount();
}

function ppClick(el, e) {
  const i = +el.dataset.i, id = el.dataset.id;
  if (e.shiftKey && pp.last >= 0) {  // a run, from the last clicked
    const [a, b] = [Math.min(pp.last, i), Math.max(pp.last, i)];
    pp.shown.slice(a, b + 1).forEach(p => pp.selected.add(p.id));
  } else if (pp.selected.has(id)) pp.selected.delete(id);
  else pp.selected.add(id);
  pp.last = i;
  ppMarks();
}
function ppSelectDay(day, on) {
  pp.shown.forEach(p => { if ((p.t ? new Date(p.t * 1000).toISOString().slice(0, 10) : '') === day) on ? pp.selected.add(p.id) : pp.selected.delete(p.id); });
  ppMarks();
}
function ppSelectShown() { pp.shown.forEach(p => pp.selected.add(p.id)); ppMarks(); }
function ppClear() { pp.selected.clear(); ppMarks(); }
function ppMarks() {
  document.querySelectorAll('#pp-grid .pp-ph').forEach(el => el.classList.toggle('sel', pp.selected.has(el.dataset.id)));
  ppCount();
}
function ppCount() {
  document.getElementById('pp-count').textContent = `${pp.photos.length.toLocaleString()} photos with no place` +
    (pp.shown.length !== pp.photos.length ? ` · ${pp.shown.length.toLocaleString()} shown` : '');
  document.getElementById('pp-nearcount').textContent = pp.photos.filter(p => p.near).length.toLocaleString();
  const n = pp.selected.size, near = pp.photos.filter(p => p.near && pp.selected.has(p.id)).length;
  document.getElementById('pp-sel').innerHTML = n ? `<b>${n.toLocaleString()} selected</b>` : 'Nothing selected: click photos, shift-click for a run, or tick a day';
  document.getElementById('pp-nearsel').innerHTML = near ? `<button class="btn btn-ghost" onclick="ppPlaceNear(pp.photos.filter(p => p.near && pp.selected.has(p.id)).map(p => p.id))"
    title="Each where a photo with a place was taken within half an hour of it">📍 Place ${near === n ? (n > 1 ? 'them' : 'it') : `${near.toLocaleString()} of them`} at nearby photos' spots</button>` : '';
}
function ppNearText([, , min]) {
  return min === 0 ? 'A photo with a place was taken the same minute' : `A photo with a place was taken ${Math.abs(min)} min ${min > 0 ? 'after' : 'before'}`;
}

// towns by name (/api/towns): a click places the selection there
async function ppTowns(q) {
  const box = document.getElementById('pp-towns');
  if (q.trim().length < 2) { box.innerHTML = ''; return; }
  const list = await fetch(`/api/towns?q=${encodeURIComponent(q.trim())}`).then(r => (r.ok ? r.json() : [])).catch(() => []);
  box.innerHTML = list.slice(0, 8).map((t, i) => `<button class="btn btn-ghost pp-town" data-i="${i}">${flagOf(t.cc)}${escapeHTML(t.name)} <small>${escapeHTML(t.cc)}</small></button>`).join('');
  box.querySelectorAll('.pp-town').forEach(b => { b.onclick = () => {
    const t = list[+b.dataset.i];
    if (!pp.selected.size) return toast('Select photos first', 'error');
    ppPlace([...pp.selected], t.lat, t.lon, t.name);
  }; });
}

function ppPlaceDay(day) {
  const at = pp.days[day];
  const inDay = pp.shown.filter(p => (p.t ? new Date(p.t * 1000).toISOString().slice(0, 10) : '') === day);
  const chosen = inDay.filter(p => pp.selected.has(p.id));
  ppPlace((chosen.length ? chosen : inDay).map(p => p.id), at.lat, at.lon, at.name);
}

function ppPlaceDayNear(day) {
  const inDay = pp.shown.filter(p => p.near && (p.t ? new Date(p.t * 1000).toISOString().slice(0, 10) : '') === day);
  const chosen = inDay.filter(p => pp.selected.has(p.id));
  ppPlaceNear((chosen.length ? chosen : inDay).map(p => p.id));
}

// placed: gone from the list, a dot on the map, and a line to undo it
async function ppPlace(ids, lat, lon, name) {
  if (!ids.length) return;
  const r = await fetch('/api/photos/place', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, lat, lon, name }) })
    .then(x => (x.ok ? x.json() : null)).catch(() => null);
  if (!r) return toast('Could not place them', 'error');
  const marker = L.circleMarker([lat, lon], { radius: 7, color: '#fff', weight: 1.5, fillColor: mapVar('--photo'), fillOpacity: 0.9 })
    .bindTooltip(`${ids.length} photo${ids.length > 1 ? 's' : ''}${name ? ` · ${escapeHTML(name)}` : ''}`).addTo(pp.markers);
  ppPlaced(ids, name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`, marker);
  toast(`Placed ${ids.length} photo${ids.length > 1 ? 's' : ''}${name ? ` in ${name}` : ' on the map'}`);
}
// each at the spot of the photo with a place taken nearest in time to it
async function ppPlaceNear(ids) {
  if (!ids.length) return;
  const r = await fetch('/api/photos/place', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, near: true }) })
    .then(x => (x.ok ? x.json() : null)).catch(() => null);
  if (!r) return toast('Could not place them', 'error');
  const set = new Set(ids), marker = L.layerGroup().addTo(pp.markers), spots = new Map();
  pp.photos.filter(p => set.has(p.id) && p.near).forEach(p => { const k = p.near[0] + ',' + p.near[1]; spots.set(k, [p.near, (spots.get(k)?.[1] || 0) + 1]); });
  spots.forEach(([[lat, lon], n]) => L.circleMarker([lat, lon], { radius: 6, color: '#fff', weight: 1.5, fillColor: mapVar('--photo'), fillOpacity: 0.9 })
    .bindTooltip(`${n} photo${n > 1 ? 's' : ''} · near a photo with a place`).addTo(marker));
  if (spots.size) pp.map.fitBounds(L.latLngBounds([...spots.values()].map(([at]) => at)), { maxZoom: 12, padding: [20, 20] });
  ppPlaced(ids, "at nearby photos' spots", marker);
  toast(`Placed ${r.placed} photo${r.placed !== 1 ? 's' : ''} at nearby photos' spots`);
}
function ppPlaced(ids, name, marker) {
  const gone = new Set(ids), photos = pp.photos.filter(p => gone.has(p.id));
  pp.photos = pp.photos.filter(p => !gone.has(p.id));
  ids.forEach(id => pp.selected.delete(id));
  pp.undo.unshift({ ids, photos, name, marker });
  pp.undo = pp.undo.slice(0, 10);
  const keep = new Set(pp.shown.map(p => p.id));
  pp.shown = pp.photos.filter(p => keep.has(p.id));
  ppDraw();
  ppUndoBar();
}

async function ppUndo(i) {
  const u = pp.undo[i];
  if (!u) return;
  const r = await fetch('/api/photos/place', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: u.ids, undo: true }) })
    .then(x => (x.ok ? x.json() : null)).catch(() => null);
  if (!r) return toast('Could not undo', 'error');
  pp.photos = [...pp.photos, ...u.photos].sort((a, b) => (a.t || 0) - (b.t || 0));
  pp.markers.removeLayer(u.marker);
  pp.undo.splice(i, 1);
  ppFilter();
  ppUndoBar();
}

function ppUndoBar() {
  const box = document.getElementById('pp-undo');
  if (box) box.innerHTML = pp.undo.length ? '<p><b>Placed just now</b></p>' + pp.undo.map((u, i) =>
    `<p><small>${u.ids.length} photo${u.ids.length > 1 ? 's' : ''} · ${escapeHTML(u.name)}</small> <button class="btn btn-ghost" onclick="ppUndo(${i})">Undo</button></p>`).join('') : '';
}

// the map: photos dropped on it are placed where they fall
function ppMap() {
  if (pp.map) { pp.map.remove(); pp.map = null; }
  const el = document.getElementById('pp-map');
  el.dataset.basemap = BASEMAPS[prefs.basemap] ? prefs.basemap : 'auto';
  pp.map = L.map(el, { zoomControl: true, worldCopyJump: true }).setView([48, 15], 4);
  toneMap(pp.map);
  const b = BASEMAPS[prefs.basemap] || BASEMAPS.auto, [url, attribution, maxZoom = 19] = b.tiles;
  L.tileLayer(url, { attribution, maxZoom }).addTo(pp.map);
  pp.markers = L.layerGroup().addTo(pp.map);
  pp.undo.forEach(u => u.marker.addTo(pp.markers));
  el.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('pp-drop'); });
  el.addEventListener('dragleave', () => el.classList.remove('pp-drop'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('pp-drop');
    let ids = [];
    try { ids = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (_) { return; }
    const at = pp.map.mouseEventToLatLng(e);
    ppPlace(ids, at.lat, at.lng, '');
  });
  setTimeout(() => pp.map && pp.map.invalidateSize(), 50);
}

window.addEventListener('load', () => {
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.addEventListener('click', () => {
    if (location.hash === '#place-photos') history.replaceState(null, '', location.pathname + location.search);
  }));
  if (location.hash === '#place-photos') setTimeout(openPlacePhotos, 500);
});
window.addEventListener('hashchange', () => { if (location.hash === '#place-photos') openPlacePhotos(); });  // the link opened in a page already open
