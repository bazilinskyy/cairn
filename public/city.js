'use strict';
// A town's report page: opened from a city on the map (or #city=<GeoNames id>), it lists the visits there and what
// you did: stays and rental cars, flights, trains, buses and ferries, sports activities, photos, Timeline places.
// Uses the page's and layers.js's globals (win, fmtDate, nights, flagOf, dist, DU, groundModes, linkTo, hookLinks).

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
  const photos = d.photos.reduce((n, p) => n + p.count, 0);
  document.getElementById('city-title').innerHTML = `🏙️ ${flagOf(t.country)}${escapeHTML(t.name)}`;
  document.getElementById('city-sub').textContent = (win.from || win.to ? `${win.from || '…'} to ${win.to || '…'} · ` : '') +
    (d.days ? `first ${fmtDate(d.first)}, last ${fmtDate(d.last)}` : 'no days there in this period');

  const card = (label, value, sub = '') => (value === '0' ? '' : `<div class="stat-card"><div class="label">${label}</div><div class="value">${value}</div>` +
    (sub ? `<div class="sub">${sub}</div>` : '') + '</div>');  // nothing of that kind there: no card
  const section = (title, body, note = '') => `<div class="chart-section"><h3>${title}</h3><div class="sp-scroll">${body}</div>` +
    (note ? `<p class="sp-note">${note}</p>` : '') + '</div>';
  const table = (head, rows) => `<table class="sp-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.join('')}</tbody></table>`;
  let html = '<div class="stat-cards">' +
    card('Days', d.days.toLocaleString(), plural(d.visits.length, 'visit')) +
    card('Nights in stays', stays.reduce((n, s) => n + nights(s), 0).toLocaleString(), plural(stays.length, 'stay')) +
    card('Flights', d.flights.length.toLocaleString(), `${d.flights.filter(f => f.direction === 'in').length} in, ${d.flights.filter(f => f.direction === 'out').length} out`) +
    card('Trains, buses, ferries', d.ground.length.toLocaleString()) +
    card('Activities', d.activities.length.toLocaleString(), `${Math.round(dist(km)).toLocaleString()} ${DU()}`) +
    card('Photos', photos.toLocaleString(), plural(d.photos.length, 'day')) + '</div>';

  if (d.visits.length) {
    html += section('Visits', table(['When', 'Days', 'What you did'], d.visits.map(v => {
      const did = [
        [d.stays.filter(s => s.what !== 'car' && s.start <= v.end && (s.end || s.start) >= v.start).length, '🏨'],
        [d.flights.filter(f => inVisit(v, f.date)).length, '✈️'],
        [d.ground.filter(g => inVisit(v, g.date)).length, '🚆'],
        [d.activities.filter(a => inVisit(v, a.date)).length, '🏃'],
        [d.photos.filter(p => inVisit(v, p.day)).reduce((n, p) => n + p.count, 0), '📷']
      ].filter(([n]) => n).map(([n, icon]) => `${icon} ${n}`).join(' · ');
      return `<tr><th>${range(v.start, v.end)}</th><td>${v.days}</td><td>${did}</td></tr>`;
    })), 'A visit is a run of days in a row there; ✈️ flights, 🚆 trains, buses and ferries, 🏃 activities, 📷 photos on those days.');
  }
  if (d.stays.length) {
    html += section('Stays and rental cars', table(['When', 'Nights', 'Where', 'Booked'], d.stays.map(s =>
      `<tr><th>${s.what === 'car' ? '🚗' : '🏨'} ${range(s.start, s.end)}</th><td>${nights(s)}</td>` +
      `<td><b>${escapeHTML(s.hotel || s.type || (s.what === 'car' ? 'Rental car' : 'Stay'))}</b><small>${escapeHTML(s.place || '')}</small></td>` +
      `<td>${escapeHTML(s.provider || '')}${s.price ? `<small>${escapeHTML(s.price)}</small>` : ''}</td></tr>`)),
      cars.length ? `${plural(cars.length, 'rental car')} among them.` : '');
  }
  if (d.flights.length) {
    html += section('Flights', table(['When', 'Flight', 'Route', ''], d.flights.map(f =>
      `<tr><th>${fmtDate(f.date)}</th><td><b>${escapeHTML(f.flight_number || '')}</b><small>${escapeHTML(f.airline || '')}</small></td>` +
      `<td>${escapeHTML(f.from_city || f.from)} (${f.from}) → ${escapeHTML(f.to_city || f.to)} (${f.to})</td>` +
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
  if (d.timeline.length) {
    html += section('Google Timeline places', table(['When', 'Place'], d.timeline.slice(0, 200).map(v =>
      `<tr><th>${range(v.start, v.end)}</th><td>${escapeHTML(v.name || '')}</td></tr>`)));
  }
  document.getElementById('city-body').innerHTML = html;
  hookLinks('city-body');
}

window.addEventListener('load', () => {
  // leaving the report by a tab or an activity link: the address no longer points at it
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.addEventListener('click', () => {
    if (location.hash.startsWith('#city=')) history.replaceState(null, '', location.pathname + location.search);
  }));
  const m = /^#city=(\d+)$/.exec(location.hash);
  if (m) setTimeout(() => openCityReport(+m[1]), 300);  // once the page's data has loaded
});
