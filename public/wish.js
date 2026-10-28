'use strict';
// The wish list (/api/wishlist): the places you saved in Google Maps (on a map, by list), the famous climbs you have
// not ridden near the places you go most, and the countries you have not been to. #wish. Uses the page's globals.

let wishMap = null;
async function openWish() {
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === 'trips'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-wish').classList.add('active');
  if (location.hash !== '#wish') history.replaceState(null, '', '#wish');
  const box = document.getElementById('wish-body');
  box.innerHTML = '<p class="sp-note">Gathering…</p>';
  const d = await fetch('/api/wishlist').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!d) { box.innerHTML = '<p class="sp-note">Could not load the wish list.</p>'; return; }
  window.scrollTo(0, 0);
  const section = (title, html, note = '') => `<div class="chart-section"><h3>${title}</h3>${html}${note ? `<p class="sp-note">${note}</p>` : ''}</div>`;
  const placed = d.saved.filter(p => p.lat != null), lists = {};
  d.saved.forEach(p => (lists[p.list || 'Saved'] = lists[p.list || 'Saved'] || []).push(p));
  let html = `<div class="chart-section" style="padding:0;overflow:hidden"><div id="wish-map" class="mini-map" style="height:380px"></div></div>`;
  html += section(`Saved places${d.saved.length ? ` · ${d.saved.length}` : ''}`, d.saved.length ? Object.entries(lists).map(([name, ps]) =>
    `<p><b>${escapeHTML(name)} (${ps.length}):</b> ${ps.slice(0, 80).map(p => (p.url ? `<a href="${escapeHTML(p.url)}" target="_blank" rel="noopener" class="sp-link inline">${escapeHTML(p.name || '?')}</a>` : escapeHTML(p.name || '?')) +
      (p.note ? ` <small>${escapeHTML(p.note)}</small>` : '')).join(' · ')}${ps.length > 80 ? ' …' : ''}</p>`).join('')
    : '<p class="sp-note">None yet. Export "Maps (your places)" and "Saved" with Google Takeout, then: <code>python imports/saved_places.py ~/Downloads/takeout-*.zip</code></p>',
    'Your saved and starred places in Google Maps. A coming trip shows those near where you will stay.');
  html += section(`Climbs to ride near where you go · ${d.climbs.length}`, `<p>${d.climbs.map(c => `<a href="#" class="sp-link inline" onclick="event.preventDefault(); openClimb('${c.id}')">${escapeHTML(c.name)}</a>` +
    ` <small>${c.ele ? fmtHeight(c.ele) + ', ' : ''}${c.km} km from ${escapeHTML(c.near)}</small>`).join(' · ')}</p>`,
    `Famous climbs you have not ridden, within 60 km of the towns you spend most days in (${d.near.map(t => escapeHTML(t.name)).join(', ')}).`);
  html += section(`Countries still to go · ${d.countries.missing.length} of ${d.countries.total}`, `<p>${d.countries.missing.map(c => `${flagOf(c.cc)}${escapeHTML(c.name)}`).join(' · ')}</p>`,
    `ISO countries and territories you have no day in yet (you have been to ${d.countries.visited}).`);
  box.innerHTML = html;
  if (wishMap) { wishMap.remove(); wishMap = null; }
  const el = document.getElementById('wish-map');
  el.dataset.basemap = BASEMAPS[prefs.basemap] ? prefs.basemap : 'auto';
  wishMap = L.map(el, { zoomControl: true });
  toneMap(wishMap);
  const b = BASEMAPS[prefs.basemap] || BASEMAPS.auto, [url, attribution, maxZoom = 19] = b.tiles;
  L.tileLayer(url, { attribution, maxZoom }).addTo(wishMap);
  const pts = [];
  placed.forEach(p => { L.circleMarker([p.lat, p.lon], { radius: 6, color: '#fff', weight: 1.5, fillColor: '#ffca28', fillOpacity: 0.95 })
    .bindPopup(`<b>⭐ ${escapeHTML(p.name || '')}</b><br><small>${escapeHTML(p.list || '')}${p.note ? ' · ' + escapeHTML(p.note) : ''}</small>${p.url ? `<br><a href="${escapeHTML(p.url)}" target="_blank" rel="noopener">Google Maps →</a>` : ''}`).addTo(wishMap); pts.push([p.lat, p.lon]); });
  d.climbs.forEach(c => { L.circleMarker([c.lat, c.lon], { radius: 5, color: mapVar('--climb'), weight: 2, fillOpacity: 0 })
    .bindPopup(`<b>⛰️ ${escapeHTML(c.name)}</b><br><small>${c.km} km from ${escapeHTML(c.near)}</small><br><a href="#" onclick="event.preventDefault(); openClimb('${c.id}')">Open climb page →</a>`).addTo(wishMap); pts.push([c.lat, c.lon]); });
  if (pts.length) wishMap.fitBounds(L.latLngBounds(pts).pad(0.1), { maxZoom: 9 }); else wishMap.setView([48, 10], 4);
  setTimeout(() => wishMap && wishMap.invalidateSize(), 50);
}

window.addEventListener('load', () => {
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.addEventListener('click', () => {
    if (location.hash === '#wish') history.replaceState(null, '', location.pathname + location.search);
  }));
  if (location.hash === '#wish') setTimeout(openWish, 500);
});
