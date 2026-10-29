'use strict';
// A year in review (review.js on the server): #year=2025, opened from the Stats tab or a year of the Trips tab. Uses
// the page's and layers.js's globals.

async function yearLinks() {
  const box = document.getElementById('year-links');
  const years = await fetch('/api/review/years').then(r => (r.ok ? r.json() : [])).catch(() => []);
  if (box) box.innerHTML = years.filter(y => y <= String(new Date().getFullYear())).reverse()
    .map(y => `<a href="#year=${y}" class="sp-link inline" onclick="event.preventDefault(); openYear(${y})">${y}</a>`).join(' · ');
  yearsSideBySide();
  const pick = document.getElementById('year-pick');
  if (pick && !pick.options.length) {
    pick.innerHTML = years.slice().reverse().map(y => `<option>${y}</option>`).join('');
    pick.addEventListener('change', () => openYear(+pick.value));
  }
}

// The years side by side (/api/review/by-year): one row a year, each number with a bar against the column's biggest
async function yearsSideBySide() {
  const box = document.getElementById('years-table');
  if (!box) return;
  const now = new Date().getFullYear();
  const rows = (await fetch('/api/review/by-year').then(r => (r.ok ? r.json() : [])).catch(() => [])).filter(r => r.year <= now).reverse();
  if (!rows.length) { box.innerHTML = ''; return; }
  const sum = (o, keys) => keys.reduce((n, k) => n + (o[k] || 0), 0);
  const GROUND = ['train', 'commute', 'bus', 'ferry', 'hitch', 'drive'], SPORT = ['ride', 'run', 'walk', 'sport'];
  const cols = [
    ['Days', r => r.days, 'with a place'], ['Away', r => r.away, 'days on trips'], ['Trips', r => r.trips],
    ['Countries', r => r.countries, r => (r.newCountries ? `${r.newCountries} new` : '')], ['Towns', r => r.towns, r => (r.newTowns ? `${r.newTowns} new` : '')],
    [`Flown, ${DU()}`, r => Math.round(dist(r.distance.flight || 0))],
    [`Overland, ${DU()}`, r => Math.round(dist(sum(r.distance, GROUND))), r => GROUND.filter(k => r.distance[k]).map(k => `${(groundModes[k] || k).split(' ')[0]} ${Math.round(dist(r.distance[k])).toLocaleString()}`).join(' ')],
    [`Own power, ${DU()}`, r => Math.round(dist(sum(r.distance, SPORT))), r => ['ride', 'run', 'walk'].filter(k => r.distance[k]).map(k => `${{ ride: '🚴', run: '🏃', walk: '🚶' }[k]} ${Math.round(dist(r.distance[k])).toLocaleString()}`).join(' ')],
    ['Nights', r => sum(r.nights, Object.keys(r.nights)), null, r => Object.entries(r.nights).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ')],
    ['Photos', r => r.photos], ['Climbs', r => r.climbs, 'first time'], ['Stays, €', r => r.eur ?? 0],
  ];
  const most = cols.map(([, v]) => Math.max(1, ...rows.map(v)));
  const cell = (r, [, v, sub, hover], i) => {
    const n = v(r), note = typeof sub === 'function' ? sub(r) : '';
    return `<td data-v="${n}" class="yb"${hover ? ` title="${escapeHTML(hover(r))}"` : ''}><span class="yb-bar" style="width:${Math.round(100 * n / most[i])}%"></span>${n ? n.toLocaleString() : '·'}` +
      `${note ? `<small>${escapeHTML(note)}</small>` : ''}</td>`;
  };
  box.innerHTML = `<table class="sp-table years-table"><thead><tr><th data-sort="num" class="sort-desc" aria-sort="descending">Year</th>` +
    cols.map(([h, , sub]) => `<th data-sort="num"${typeof sub === 'string' ? ` title="${sub}"` : ''}>${h}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map(r => `<tr><th data-v="${r.year}"><a href="#year=${r.year}" class="sp-link inline" onclick="event.preventDefault(); openYear(${r.year})">${r.year}</a></th>` +
      cols.map((c, i) => cell(r, c, i)).join('') + '</tr>').join('') + '</tbody></table>';
  sortableTables(box);
}

async function openYear(y) {
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === 'stats'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-year').classList.add('active');
  if (location.hash !== `#year=${y}`) history.replaceState(null, '', `#year=${y}`);
  document.getElementById('year-title').textContent = `${y} in review`;
  document.getElementById('year-pick').value = String(y);
  const body = document.getElementById('year-body');
  body.innerHTML = '<p class="sp-note">Gathering the year…</p>';
  const d = await fetch(`/api/review/${y}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!d) { body.innerHTML = '<p class="sp-note">Nothing for this year.</p>'; return; }
  window.scrollTo(0, 0);
  const card = (label, value, sub = '') => (value === '' || value == null ? '' : `<div class="stat-card"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`);
  const section = (title, html) => `<div class="chart-section"><h3>${title}</h3>${html}</div>`;
  const town = t => `${flagOf(t.cc)}<a href="#" class="sp-link inline" onclick="event.preventDefault(); openCityReport(${t.id})">${escapeHTML(t.name)}</a>`;
  const country = cc => `${flagOf(cc)}${escapeHTML(new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) || cc)}`;
  const hm = sec => `${Math.floor(sec / 3600)}:${String(Math.round(sec % 3600 / 60)).padStart(2, '0')}`;
  const newCountries = d.countries.filter(c => c.first), newTowns = d.towns.filter(t => t.first);
  const totalKm = Object.values(d.distance).reduce((a, b) => a + b, 0);
  let html = '<div class="stat-cards">' +
    card('Trips', d.trips.length, `${d.away} days away`) +
    card('Countries', d.countries.length, newCountries.length ? `${newCountries.length} for the first time` : '') +
    card('Towns', d.towns.length, newTowns.length ? `${newTowns.length} new` : '') +
    card('Distance, every means', fmtDist(totalKm), `${d.flights} flights · ${d.ground} trains, buses, ferries, car journeys`) +
    card('Activities', d.activities, d.distance.ride ? `${fmtDist(d.distance.ride)} cycled` : '') +
    card('Climbs', d.climbs.length || '', d.climbs.filter(c => c.firstTime).length ? `${d.climbs.filter(c => c.firstTime).length} for the first time` : '') +
    card('Photos', d.photos.count ? d.photos.count.toLocaleString() : '', d.photos.topDay ? `most on ${fmtDate(d.photos.topDay.day)} (${d.photos.topDay.count})` : '') +
    card('Music', d.music?.plays ? d.music.plays.toLocaleString() : '', d.music?.artists?.[0] ? `most: ${escapeHTML(d.music.artists[0].name)}` : '') +
    card('Sleep', d.body?.sleep ? hm(d.body.sleep) : '', d.body ? [d.body.score ? `score ${d.body.score}` : '', d.body.rhr ? `resting heart rate ${d.body.rhr}` : ''].filter(Boolean).join(' · ') : '') +
    card('Spent on stays', d.spending ? `€${d.spending.eur.toLocaleString()}` : '', d.spending ? `€${d.spending.perNight} a night` : '') + '</div>';
  if (d.trips.length) html += section('Trips', `<div class="sp-scroll"><table class="sp-table"><tbody>${d.trips.map(t =>
    `<tr><th>${tripRange(t.start, t.end)}</th><td>${t.countries.map(cc => flagOf(cc).trim()).join(' ')} <a href="#" class="sp-link inline" onclick="event.preventDefault(); openTrip('${t.id}')">${escapeHTML(t.name)}</a>` +
    `<small>${t.towns.map(escapeHTML).join(', ')}</small></td><td>${t.days} days</td></tr>`).join('')}</tbody></table></div>`);
  if (newCountries.length || newTowns.length) html += section('Firsts', (newCountries.length ? `<p><b>New countries:</b> ${newCountries.map(c => country(c.cc)).join(' · ')}</p>` : '') +
    (newTowns.length ? `<p><b>New towns (${newTowns.length}):</b> ${newTowns.slice(0, 60).map(town).join(' · ')}${newTowns.length > 60 ? ' …' : ''}</p>` : ''));
  html += section('Where you spent the year', `<p>${d.countries.slice(0, 20).map(c => `${country(c.cc)} <small>${c.days} d</small>`).join(' · ')}</p>` +
    `<p><b>Towns:</b> ${d.towns.slice(0, 15).map(t => `${town(t)} <small>${t.days} d</small>`).join(' · ')}</p>`);
  const names = { flight: '✈️ Flown', train: '🚆 Train', commute: '🔁 Commute', bus: '🚌 Bus', ferry: '⛴️ Ferry', hitch: '👍 Hitchhiked', drive: '🚙 By car', ride: '🚴 Cycled', run: '🏃 Run', walk: '🥾 Walked', sport: '🏅 Other' };
  const max = Math.max(1, ...Object.values(d.distance));
  html += section('How far, by each means', `<div class="curio-bars" style="grid-template-columns: 90px 1fr 90px">${Object.entries(d.distance).filter(([, v]) => v).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span>${names[k] || k}</span><div class="bar" style="width:${Math.max(1, v / max * 100)}%"></div><span>${fmtDist(v)}</span>`).join('')}</div>` +
    (Object.keys(d.beds).length ? `<p style="margin-top:10px"><b>Nights:</b> ${Object.entries(d.beds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${escapeHTML(k)} ${n}`).join(' · ')}</p>` : ''));
  if (d.climbs.length) html += section('Climbs', `<p>${d.climbs.map(c => `${c.firstTime ? '🆕 ' : ''}<a href="#" class="sp-link inline" onclick="event.preventDefault(); openClimb('${c.id}')">${escapeHTML(c.name)}</a>${c.ele ? ` <small>${fmtHeight(c.ele)}</small>` : ''}`).join(' · ')}</p>`);
  if (d.music?.plays) html += musicSection(d.music, 'The year in music', `What you played on Last.fm in ${y}`);
  if (d.rides) html += section('Ride weather', `<p>${[['Hottest', d.rides.hottest, w => fmtTemp(w.tmax)], ['Coldest', d.rides.coldest, w => fmtTemp(w.tmin)], ['Wettest', d.rides.wettest, w => `${w.rain} mm`]]
    .filter(([, w]) => w).map(([label, w, v]) => `<b>${label}:</b> ${v(w)}, <a href="#" class="sp-link inline" onclick="event.preventDefault(); showActivityOnMap(${w.id})">${escapeHTML(w.name)}</a> (${fmtDate(w.date)})`).join(' · ')}</p>`);
  body.innerHTML = html;
}

function closeYear() {
  history.replaceState(null, '', location.pathname + location.search);
  document.querySelector('.tab[data-tab="stats"]').click();
}

window.addEventListener('load', () => {
  yearLinks();
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.addEventListener('click', () => {
    if (location.hash.startsWith('#year=')) history.replaceState(null, '', location.pathname + location.search);
  }));
  const m = /^#year=(\d{4})$/.exec(location.hash);
  if (m) setTimeout(() => openYear(+m[1]), 500);
});
