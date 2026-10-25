'use strict';
// The Sports tab: Strava activities as statshunters shows them, and more. Cycling and running first.
// Cards; distance per year; the year race; every day of a year; when you go out; Eddington numbers; explored tiles
// over time; how far you go; records, best efforts, year by year, where you go and countries. Everything follows the
// sport and year chosen at the top. Uses layers.js (allActivities, prepared; sportOf; TILES) and the page's helpers.

const KINDS = { ride: 'Cycling', run: 'Running', walk: 'Walks & hikes', sport: 'Other' };
const PICKS = { main: ['ride', 'run'], ride: ['ride'], run: ['run'], walk: ['walk'], all: ['ride', 'run', 'walk', 'sport'] };
const BLUES = {  // sequential (one hue, dataviz reference ramp): low recedes into the surface in each mode
  light: ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'], dark: ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#9ec5f4']
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let sportCharts = [], sportPlaces = null, sportPicked = { kinds: 'main', year: '' };

// Numbers in the unit chosen in the settings (layers.js: dist, DU, height, HU); activities keep km and m
const km0 = v => Math.round(dist(v)).toLocaleString();
const km1 = v => (Math.round(dist(v) * 10) / 10).toLocaleString();
const up = m => Math.round(height(m)).toLocaleString();
const hours = s => Math.round(s / 3600).toLocaleString();
const pace = a => {
  const s = a.moving_time / dist(a.distance), m = Math.floor(s / 60), r = Math.round(s % 60);
  return `${r === 60 ? m + 1 : m}:${String(r === 60 ? 0 : r).padStart(2, '0')} /${DU()}`;
};
const speed = a => `${(Math.round(dist(a.distance) / (a.moving_time / 3600) * 10) / 10).toLocaleString()} ${imperial() ? 'mph' : 'km/h'}`;
const dayOf = a => (a.date || '').slice(0, 10);
const yearOf = a => (a.date || '').slice(0, 4);
const color = k => getCSSVar('--' + k);

// The activities of the chosen sports (and year, unless all years are wanted)
function picked({ allYears = false } = {}) {
  const kinds = PICKS[sportPicked.kinds];
  return allActivities.filter(a => kinds.includes(a.kind || sportOf(a.sport)) && a.date
    && (allYears || !sportPicked.year || yearOf(a) === sportPicked.year));
}

// --- numbers ---

// Eddington number: the biggest E such that on E days you covered at least E km
function eddington(list) {
  const perDay = {};
  list.forEach(a => { perDay[dayOf(a)] = (perDay[dayOf(a)] || 0) + dist(a.distance); });  // in km or miles
  const d = Object.values(perDay).sort((a, b) => b - a);
  let e = 0;
  while (e < d.length && d[e] >= e + 1) e++;
  const next = e + 1, have = d.filter(x => x >= next).length;
  return { e, next, missing: next - have, days: d };
}

// Days in a row with an activity: the longest run, and the one going on (ending today or yesterday)
function streaks(list) {
  const days = [...new Set(list.map(dayOf))].sort();
  let best = { n: 0, end: '' }, run = 0, prev = null;
  days.forEach(d => {
    run = prev && (Date.parse(d) - Date.parse(prev)) / 864e5 === 1 ? run + 1 : 1;
    if (run > best.n) best = { n: run, end: d };
    prev = d;
  });
  const today = new Date().toISOString().slice(0, 10), gap = prev ? (Date.parse(today) - Date.parse(prev)) / 864e5 : 99;
  return { best, current: gap <= 1 ? run : 0, days: days.length };
}

// Explored tiles of these activities, with max square and cluster (as on the map)
function exploredOf(list) {
  const tiles = new Set();
  list.forEach(a => actTiles(a).forEach(k => tiles.add(k)));  // at the zoom chosen in the settings
  const size = new Map();
  let square = 0;
  [...tiles].sort((p, q) => (p % TILES) - (q % TILES) || p - q).forEach(k => {
    const n = 1 + Math.min(size.get(k - TILES) || 0, size.get(k - 1) || 0, size.get(k - TILES - 1) || 0);
    size.set(k, n);
    if (n > square) square = n;
  });
  const near = k => [k - TILES, k + TILES, k - 1, k + 1];
  const inner = [...tiles].filter(k => near(k).every(m => tiles.has(m))), innerSet = new Set(inner), seen = new Set();
  let cluster = 0;
  inner.forEach(k => {
    if (seen.has(k)) return;
    let n = 0;
    const todo = [k];
    seen.add(k);
    while (todo.length) {
      n++;
      near(todo.pop()).forEach(m => { if (innerSet.has(m) && !seen.has(m)) { seen.add(m); todo.push(m); } });
    }
    cluster = Math.max(cluster, n);
  });
  return { tiles: tiles.size, square, cluster };
}

// --- page ---

function renderSports() {
  const root = document.getElementById('sports-body');
  if (!root) return;
  sportCharts.forEach(c => c.destroy());
  sportCharts = [];
  if (!allActivities.length) {
    const st = stravaStatus || {};
    root.innerHTML = `<div class="chart-section"><h3>No activities yet</h3><p class="sp-note">${st.garmin?.error
      ? `The Garmin sync failed: ${escapeHTML(st.garmin.error)}. `
      : st.strava?.connected ? 'Contrail is fetching your activities from Strava; this page fills in when they arrive. ' : ''}
      Import your Garmin data export, or sign in to Garmin Connect for the hourly sync, to see your rides and runs here:
      the README's "Sports activities" says how.</p></div>`;
    return;
  }
  fillPickers();
  const list = picked(), all = picked({ allYears: true }), kinds = PICKS[sportPicked.kinds].filter(k => all.some(a => a.kind === k));
  const yearShown = sportPicked.year || (all.length ? yearOf(all.reduce((a, b) => (a.date > b.date ? a : b))) : '');
  root.innerHTML = `
    <div class="stat-cards" id="sp-cards"></div>
    <div class="chart-section"><h3>Distance per year</h3><div class="chart-wrap"><canvas id="sp-years"></canvas></div></div>
    <div class="chart-section"><h3>Year race: distance through each year${kinds.length > 1 ? ' (' + kinds.map(k => KINDS[k].toLowerCase()).join(' and ') + ' together)' : ''}</h3>
      <div class="chart-wrap tall"><canvas id="sp-race"></canvas></div></div>
    <div class="chart-section"><h3>Every day of ${yearShown}</h3><div id="sp-calendar" class="sp-scroll"></div></div>
    <div class="sp-grid">
      <div class="chart-section"><h3>When you go out</h3><div id="sp-punch"></div></div>
      <div class="chart-section"><h3>Eddington number</h3><div id="sp-edd" class="sp-multi"></div></div>
      <div class="chart-section"><h3>Explored tiles</h3><div class="chart-wrap short"><canvas id="sp-tiles"></canvas></div>
        <h4>Max square at the end of each year</h4><div class="chart-wrap short"><canvas id="sp-square"></canvas></div></div>
      <div class="chart-section"><h3>How far you go</h3><div id="sp-hist" class="sp-multi"></div></div>
    </div>
    <div class="chart-section"><h3>Records</h3><div class="sp-scroll"><table class="sp-table" id="sp-records"></table></div></div>
    <div class="sp-grid">
      <div class="chart-section"><h3>Best efforts</h3><table class="sp-table" id="sp-bests"></table>
        <p class="sp-note">Whole-activity averages of activities of about that distance (Strava's list has no splits).</p></div>
      <div class="chart-section"><h3>Year by year</h3><div class="sp-scroll"><table class="sp-table" id="sp-yeartable"></table></div></div>
      <div class="chart-section"><h3>Where you start</h3><table class="sp-table" id="sp-towns"></table></div>
      <div class="chart-section"><h3>Countries</h3><table class="sp-table" id="sp-countries"></table></div>
    </div>`;
  chartDefaults();
  renderCards(list, kinds);
  renderYears(all, kinds);
  renderRace(all, yearShown);
  renderCalendar(all.filter(a => yearOf(a) === yearShown), yearShown);
  renderPunch(list);
  renderEddington(list, kinds);
  renderTilesGrowth(all);
  renderHistograms(list, kinds);
  renderRecords(list, kinds);
  renderBests(list, kinds);
  renderYearTable(all);
  renderPlaces(kinds);
}

function fillPickers() {
  const sel = document.getElementById('sp-year');
  const ys = [...new Set(allActivities.map(yearOf).filter(Boolean))].sort().reverse();
  const want = `<option value="">All years</option>` + ys.map(y => `<option value="${y}">${y}</option>`).join('');
  if (sel.dataset.filled !== want) { sel.innerHTML = want; sel.dataset.filled = want; sel.value = sportPicked.year; }
}

function chartDefaults() {
  Chart.defaults.color = getCSSVar('--chart-tick');
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11;
}

const axes = (yTitle, extra = {}) => ({
  x: { grid: { display: false }, ticks: { color: getCSSVar('--chart-tick') }, ...extra.x },
  y: { grid: { color: getCSSVar('--chart-grid') }, border: { display: false }, beginAtZero: true,
    title: { display: !!yTitle, text: yTitle, color: getCSSVar('--chart-tick') }, ticks: { color: getCSSVar('--chart-tick') }, ...extra.y }
});

function chart(id, config) {
  const c = new Chart(document.getElementById(id), config);
  sportCharts.push(c);
  return c;
}

// --- cards ---

function renderCards(list, kinds) {
  const total = (f, l = list) => l.reduce((s, a) => s + (f(a) || 0), 0);
  const st = streaks(list), ex = exploredOf(list);
  const card = (label, value, sub = '') => `<div class="stat-card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const per = kinds.map(k => {
    const l = list.filter(a => a.kind === k);
    return `<span class="sp-dot" style="background:${color(k)}"></span>${KINDS[k]} ${km0(total(a => a.distance, l))} ${DU()}`;
  }).join(' · ');
  const edd = kinds.filter(k => k === 'ride' || k === 'run').map(k => {
    const e = eddington(list.filter(a => a.kind === k));
    return card(`Eddington, ${KINDS[k].toLowerCase()}`, e.e, `${e.missing} more day${e.missing !== 1 ? 's' : ''} of ${e.next}+ ${DU()} for ${e.next}`);
  }).join('');
  document.getElementById('sp-cards').innerHTML =
    card('Activities', list.length.toLocaleString(), `${st.days.toLocaleString()} days out`) +
    card('Distance', `${km0(total(a => a.distance))} ${DU()}`, per) +
    card('Moving time', `${hours(total(a => a.moving_time))} h`, `${(total(a => a.moving_time) / 86400).toFixed(1)} days`) +
    card('Climbing', `${up(total(a => a.elevation))} ${HU()}`, `${(total(a => a.elevation) / 8849).toFixed(1)}× Everest`) +
    edd +
    card('Longest streak', `${st.best.n} day${st.best.n !== 1 ? 's' : ''}`, st.best.end ? `to ${fmtDate(st.best.end)}${st.current ? ` · now ${st.current}` : ''}` : '') +
    card(TILE_Z === 14 ? 'Explored tiles' : 'Squadratinhos', ex.tiles.toLocaleString(), `max square ${ex.square}×${ex.square} · cluster ${ex.cluster.toLocaleString()}`);
}

// --- charts ---

function renderYears(all, kinds) {
  const years = [...new Set(all.map(yearOf))].sort();
  chart('sp-years', {
    type: 'bar',
    data: { labels: years, datasets: kinds.map(k => ({
      label: KINDS[k], backgroundColor: color(k), borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 28,
      data: years.map(y => Math.round(dist(all.filter(a => a.kind === k && yearOf(a) === y).reduce((s, a) => s + a.distance, 0))))
    })) },
    options: { responsive: true, maintainAspectRatio: false, scales: axes(DU()),
      plugins: { legend: { display: kinds.length > 1, position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toLocaleString()} ${DU()}` } } } }
  });
}

// Cumulative distance by day of the year, one line per year: the year shown in the accent, the best year in the
// sport's colour, the others muted
function renderRace(all, yearShown) {
  const byYear = {};
  all.forEach(a => {
    const y = yearOf(a), d = Math.floor((Date.parse(dayOf(a)) - Date.parse(y + '-01-01')) / 864e5);
    (byYear[y] = byYear[y] || new Array(366).fill(0))[d] += dist(a.distance);
  });
  const totals = Object.fromEntries(Object.entries(byYear).map(([y, d]) => [y, d.reduce((s, x) => s + x, 0)]));
  const best = Object.keys(totals).sort((a, b) => totals[b] - totals[a])[0];
  const today = new Date(), thisYear = String(today.getFullYear());
  const muted = getCSSVar('--text2') + '55', bestColor = color(sportPicked.kinds === 'run' ? 'run' : 'ride');
  const datasets = Object.keys(byYear).sort().map(y => {
    let sum = 0;
    const last = y === thisYear ? Math.floor((today - new Date(thisYear + '-01-01')) / 864e5) : 365;
    const pts = byYear[y].slice(0, last + 1).map((v, i) => ({ x: i, y: Math.round(sum += v) }));
    const hi = y === yearShown, top = y === best;
    return { label: y, data: pts, borderColor: hi ? getCSSVar('--accent') : top ? bestColor : muted,
      borderWidth: hi || top ? 2.5 : 1, pointRadius: 0, pointHoverRadius: 3, tension: 0, order: hi ? 0 : top ? 1 : 2 };
  });
  chart('sp-race', {
    type: 'line', data: { datasets },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'nearest', intersect: false },
      scales: axes(DU(), { x: { type: 'linear', min: 0, max: 365, ticks: { stepSize: 30.4, callback: v => MONTHS[Math.round(v / 30.4)] || '' } } }),
      plugins: {
        legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 14, boxHeight: 2,
          filter: item => item.text === yearShown || item.text === best } },
        tooltip: { callbacks: { title: items => { const d = new Date(Date.UTC(2001, 0, 1) + items[0].parsed.x * 864e5); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; },
          label: c => `${c.dataset.label}: ${c.parsed.y.toLocaleString()} ${DU()}` } }
      } }
  });
}

// GitHub-style: a column per week, a square per day, the darker the further you went
function renderCalendar(list, year) {
  const box = document.getElementById('sp-calendar');
  if (!year) { box.innerHTML = ''; return; }
  const per = {}, count = {};
  list.forEach(a => { per[dayOf(a)] = (per[dayOf(a)] || 0) + a.distance; count[dayOf(a)] = (count[dayOf(a)] || 0) + 1; });
  const vals = Object.values(per).sort((a, b) => a - b), q = p => vals[Math.floor(p * (vals.length - 1))] || 0;
  const cuts = [q(0.2), q(0.45), q(0.7), q(0.9)];
  const ramp = BLUES[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'];
  const start = new Date(Date.UTC(+year, 0, 1)), offset = (start.getUTCDay() + 6) % 7, cell = 12, gap = 2, top = 18, left = 28;
  let svg = '', months = '';
  for (let i = 0; i < 366; i++) {
    const d = new Date(start.getTime() + i * 864e5);
    if (d.getUTCFullYear() !== +year) break;
    const key = d.toISOString().slice(0, 10), w = Math.floor((i + offset) / 7), wd = (i + offset) % 7, v = per[key] || 0;
    const fill = v ? ramp[cuts.filter(c => v > c).length] : getCSSVar('--surface2');
    svg += `<rect x="${left + w * (cell + gap)}" y="${top + wd * (cell + gap)}" width="${cell}" height="${cell}" rx="2" fill="${fill}"
      data-tip="${fmtDate(key)}: ${v ? `${km1(v)} ${DU()} in ${count[key]} activit${count[key] > 1 ? 'ies' : 'y'}` : 'nothing'}"/>`;
    if (d.getUTCDate() === 1) months += `<text x="${left + w * (cell + gap)}" y="11">${MONTHS[d.getUTCMonth()]}</text>`;
  }
  const days = [0, 2, 4].map(i => `<text x="0" y="${top + i * (cell + gap) + 10}">${WEEKDAYS[i]}</text>`).join('');
  const legend = ['less'].concat(ramp.map((c, i) => `<span class="sp-swatch" style="background:${c}"></span>`), ['more']).join(' ');
  box.innerHTML = `<svg class="sp-svg" width="${left + 54 * (cell + gap)}" height="${top + 7 * (cell + gap)}">${months}${days}${svg}</svg>
    <div class="sp-legend">${legend} <span class="sp-note">· ${Object.keys(per).length} active days, ${km0(vals.reduce((s, x) => s + x, 0))} ${DU()}</span></div>`;
  hookTips(box);
}

// Weekday by hour of the start: the bigger the dot, the more activities started then
function renderPunch(list) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  list.forEach(a => {
    const h = +(a.date.slice(11, 13) || 0), wd = (new Date(dayOf(a) + 'T12:00:00Z').getUTCDay() + 6) % 7;
    grid[wd][h]++;
  });
  const most = Math.max(1, ...grid.flat()), cw = 17, rh = 22, left = 34, top = 6;
  let dots = '';
  grid.forEach((row, wd) => row.forEach((n, h) => {
    if (!n) return;
    const r = 2 + 7 * Math.sqrt(n / most);
    dots += `<circle cx="${left + h * cw + cw / 2}" cy="${top + wd * rh + rh / 2}" r="${r.toFixed(1)}" fill="${getCSSVar('--accent')}" fill-opacity="0.85"
      data-tip="${WEEKDAYS[wd]} ${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00: ${n} activit${n > 1 ? 'ies' : 'y'}"/>`;
  }));
  const rows = WEEKDAYS.map((d, i) => `<text x="0" y="${top + i * rh + rh / 2 + 4}">${d}</text>`).join('');
  const cols = [0, 6, 12, 18].map(h => `<text x="${left + h * cw}" y="${top + 7 * rh + 14}">${String(h).padStart(2, '0')}:00</text>`).join('');
  const box = document.getElementById('sp-punch');
  box.innerHTML = `<svg class="sp-svg" viewBox="0 0 ${left + 24 * cw} ${top + 7 * rh + 20}" width="100%">${rows}${cols}${dots}</svg>
    <p class="sp-note">Start times, in the activity's own time zone.</p>`;
  hookTips(box);
}

// Days with at least n km against n: the Eddington number is where the bars cross the line
function renderEddington(list, kinds) {
  const box = document.getElementById('sp-edd');
  const ks = kinds.filter(k => k === 'ride' || k === 'run');
  if (!ks.length) { box.innerHTML = '<p class="sp-note">For cycling and running.</p>'; return; }
  box.innerHTML = ks.map(k => `<div><h4>${KINDS[k]}</h4><div class="chart-wrap short"><canvas id="sp-edd-${k}"></canvas></div><p class="sp-note" id="sp-edd-${k}-note"></p></div>`).join('');
  ks.forEach(k => {
    // around E, where the bars cross the line: from 25 km below it to 15 above
    const e = eddington(list.filter(a => a.kind === k)), from = Math.max(1, e.e - 25), upto = e.e + 15;
    const ns = Array.from({ length: upto - from + 1 }, (_, i) => from + i);
    chart(`sp-edd-${k}`, {
      data: { labels: ns, datasets: [
        { type: 'line', label: 'n days', data: ns, borderColor: getCSSVar('--text2'), borderWidth: 1.5, borderDash: [4, 4], pointRadius: 0, order: 0 },
        { type: 'bar', label: `days with at least n ${DU()}`, data: ns.map(n => e.days.filter(d => d >= n).length),
          backgroundColor: ns.map(n => n === e.e ? getCSSVar('--accent') : color(k)), borderRadius: 2, order: 1 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, scales: axes('days', { x: { title: { display: true, text: DU(), color: getCSSVar('--chart-tick') },
        ticks: { autoSkip: true, maxTicksLimit: 8 } }, y: { beginAtZero: false, min: Math.max(0, from - 10), max: Math.ceil(upto * 1.6 / 10) * 10 } }),  // taller bars run off the top
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: i => `${i[0].label} ${DU()}`, label: c => c.dataset.type === 'line' ? '' : `${c.parsed.y} days with ${c.label}+ ${DU()}` } } } }
    });
    document.getElementById(`sp-edd-${k}-note`).innerHTML = `<b>E = ${e.e}</b>: ${e.e} days of at least ${e.e} ${DU()}. For ${e.next}: ${e.missing} more day${e.missing !== 1 ? 's' : ''} of ${e.next}+ ${DU()}.`;
  });
}

// Explored tiles month by month, and the max square at the end of each year (two charts: two scales)
function renderTilesGrowth(all) {
  const sorted = [...all].sort((a, b) => a.date.localeCompare(b.date)), tiles = new Set(), months = [], counts = [];
  sorted.forEach(a => {
    actTiles(a).forEach(k => tiles.add(k));
    const m = a.date.slice(0, 7);
    if (months[months.length - 1] === m) counts[counts.length - 1] = tiles.size;
    else { months.push(m); counts.push(tiles.size); }
  });
  chart('sp-tiles', {
    type: 'line', data: { labels: months, datasets: [{ label: 'Explored tiles', data: counts, borderColor: getCSSVar('--tile'),
      backgroundColor: getCSSVar('--tile') + '33', fill: true, borderWidth: 2, pointRadius: 0, tension: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: axes('tiles', { x: { ticks: { maxTicksLimit: 8 } } }), plugins: { legend: { display: false } } }
  });
  const years = [...new Set(sorted.map(yearOf))];
  chart('sp-square', {
    type: 'bar', data: { labels: years, datasets: [{ label: 'Max square', backgroundColor: getCSSVar('--tile'), borderRadius: 4, maxBarThickness: 24,
      data: years.map(y => exploredOf(sorted.filter(a => yearOf(a) <= y)).square) }] },
    options: { responsive: true, maintainAspectRatio: false, scales: axes('tiles a side'),
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.parsed.y}×${c.parsed.y}` } } } }
  });
}

// How long activities are: one histogram per sport, in bins that suit it
function renderHistograms(list, kinds) {
  const box = document.getElementById('sp-hist');
  const bin = { ride: 10, run: 2, walk: 2, sport: 5 };
  box.innerHTML = kinds.map(k => `<div><h4>${KINDS[k]}</h4><div class="chart-wrap short"><canvas id="sp-hist-${k}"></canvas></div></div>`).join('');
  kinds.forEach(k => {
    const l = list.filter(a => a.kind === k && a.distance > 0), w = bin[k];
    const n = Math.min(20, Math.ceil(Math.max(w, ...l.map(a => dist(a.distance))) / w));
    const counts = new Array(n).fill(0);
    l.forEach(a => { counts[Math.min(n - 1, Math.floor(dist(a.distance) / w))]++; });
    chart(`sp-hist-${k}`, {
      type: 'bar', data: { labels: counts.map((_, i) => i === n - 1 ? `${i * w}+` : `${i * w}`), datasets: [{ label: KINDS[k], data: counts,
        backgroundColor: color(k), borderRadius: 3, categoryPercentage: 0.95, barPercentage: 0.95 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: axes('activities', { x: { title: { display: true, text: DU(), color: getCSSVar('--chart-tick') } } }),
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: i => `${i[0].label}${i[0].label.endsWith('+') ? '' : '–' + (+i[0].label + w)} ${DU()}` } } } }
    });
  });
}

// --- tables ---

const linkTo = a => `<a href="#" class="sp-link" data-activity="${a.id}" title="Show on the map">${escapeHTML(a.name || a.sport)}</a>`;

function biggestPeriod(list, keyOf, label) {
  const sums = {};
  list.forEach(a => { const k = keyOf(a); sums[k] = (sums[k] || 0) + a.distance; });
  const best = Object.entries(sums).sort((a, b) => b[1] - a[1])[0];
  return best ? `<b>${km0(best[1])} ${DU()}</b><small>${label(best[0])}</small>` : '–';
}

const weekOf = a => { const d = new Date(dayOf(a) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); };

function renderRecords(list, kinds) {
  const top = (l, f) => l.filter(a => f(a) > 0).sort((a, b) => f(b) - f(a))[0];
  const rows = [
    ['Longest', l => { const a = top(l, x => x.distance); return a && `<b>${km1(a.distance)} ${DU()}</b>${linkTo(a)}<small>${fmtDate(a.date)}</small>`; }],
    ['Most climbing', l => { const a = top(l, x => x.elevation); return a && `<b>${up(a.elevation)} ${HU()}</b>${linkTo(a)}<small>${fmtDate(a.date)}</small>`; }],
    ['Longest moving time', l => { const a = top(l, x => x.moving_time); return a && `<b>${(a.moving_time / 3600).toFixed(1)} h</b>${linkTo(a)}<small>${fmtDate(a.date)}</small>`; }],
    ['Fastest average', (l, k) => {
      const min = { ride: 20, run: 5, walk: 5, sport: 5 }[k], a = top(l.filter(x => x.distance >= min && !x.trainer), x => x.distance / x.moving_time);
      return a && `<b>${k === 'run' || k === 'walk' ? pace(a) : speed(a)}</b>${linkTo(a)}<small>${km1(a.distance)} ${DU()} · ${fmtDate(a.date)}</small>`;
    }],
    ['Highest heart rate average', l => { const a = top(l, x => x.heartrate || 0); return a && `<b>${a.heartrate} bpm</b>${linkTo(a)}<small>${fmtDate(a.date)}</small>`; }],
    ['Most kudos', l => { const a = top(l, x => x.kudos); return a && `<b>${a.kudos}</b>${linkTo(a)}<small>${fmtDate(a.date)}</small>`; }],
    ['Biggest week', l => biggestPeriod(l, weekOf, w => `week of ${fmtDate(w)}`)],
    ['Biggest month', l => biggestPeriod(l, a => a.date.slice(0, 7), m => `${MONTHS[+m.slice(5) - 1]} ${m.slice(0, 4)}`)],
    ['Biggest year', l => biggestPeriod(l, yearOf, y => y)],
    ['Longest streak', l => { const s = streaks(l).best; return s.n ? `<b>${s.n} days</b><small>to ${fmtDate(s.end)}</small>` : ''; }]
  ];
  document.getElementById('sp-records').innerHTML =
    `<thead><tr><th></th>${kinds.map(k => `<th><span class="sp-dot" style="background:${color(k)}"></span>${KINDS[k]}</th>`).join('')}</tr></thead><tbody>` +
    rows.map(([label, f]) => `<tr><th>${label}</th>${kinds.map(k => `<td>${f(list.filter(a => a.kind === k), k) || '–'}</td>`).join('')}</tr>`).join('') + '</tbody>';
  hookLinks('sp-records');
}

// Best whole-activity pace or speed among activities of about a race distance
function renderBests(list, kinds) {
  const bands = {
    run: [['5 km', 4.8, 5.6], ['10 km', 9.7, 11], ['Half marathon', 20.8, 22.5], ['Marathon', 41.8, 44]],
    ride: imperial()
      ? [['30 mi', 48.3, 72.4], ['60 mi', 96.6, 144.8], ['Century (100 mi)', 160.9, 241.4], ['125 mi+', 201.2, 1e6]]
      : [['50 km', 50, 75], ['100 km', 100, 140], ['160 km', 160, 250], ['200 km+', 200, 1e6]]
  };
  const ks = kinds.filter(k => bands[k]);
  document.getElementById('sp-bests').innerHTML = ks.length ? '<tbody>' + ks.map(k => bands[k].map(([name, lo, hi]) => {
    const a = list.filter(x => x.kind === k && x.distance >= lo && x.distance <= hi && !x.trainer && x.moving_time)
      .sort((p, q) => q.distance / q.moving_time - p.distance / p.moving_time)[0];
    return `<tr><th><span class="sp-dot" style="background:${color(k)}"></span>${name}</th><td>${a ? `<b>${k === 'run' ? pace(a) : speed(a)}</b>${linkTo(a)}<small>${km1(a.distance)} ${DU()} · ${fmtDate(a.date)}</small>` : '–'}</td></tr>`;
  }).join('')).join('') + '</tbody>' : '<tbody><tr><td class="sp-note">For cycling and running.</td></tr></tbody>';
  hookLinks('sp-bests');
}

function renderYearTable(all) {
  const years = [...new Set(all.map(yearOf))].sort().reverse();
  document.getElementById('sp-yeartable').innerHTML =
    `<thead><tr><th>Year</th><th>Activities</th><th>${DU()}</th><th>Hours</th><th>Climbing ${HU()}</th><th>Longest ${DU()}</th><th>${DU()} a week</th></tr></thead><tbody>` +
    years.map(y => {
      const l = all.filter(a => yearOf(a) === y), total = l.reduce((s, a) => s + a.distance, 0);
      const weeks = y === String(new Date().getFullYear()) ? Math.max(1, (Date.now() - Date.parse(y + '-01-01')) / 6048e5) : 52.18;
      return `<tr class="${y === sportPicked.year ? 'sp-hi' : ''}"><th>${y}</th><td>${l.length}</td><td>${km0(total)}</td><td>${hours(l.reduce((s, a) => s + a.moving_time, 0))}</td>` +
        `<td>${up(l.reduce((s, a) => s + a.elevation, 0))}</td><td>${km1(Math.max(0, ...l.map(a => a.distance)))}</td><td>${km0(total / weeks)}</td></tr>`;
    }).join('') + '</tbody>';
}

// Start towns and countries, from Contrail (cities.js); all years
async function renderPlaces(kinds) {
  if (!sportPlaces) sportPlaces = await fetch('/api/activities/places').then(r => r.ok ? r.json() : {}).catch(() => ({}));
  const merge = key => {
    const m = new Map();
    kinds.forEach(k => (sportPlaces[k]?.[key] || []).forEach(t => {
      const id = key === 'towns' ? `${t.name}|${t.country}` : t.country, v = m.get(id) || { ...t, count: 0, km: 0 };
      v.count += t.count; v.km += t.km;
      v.first = v.first && v.first < t.first ? v.first : t.first; v.last = v.last && v.last > t.last ? v.last : t.last;
      m.set(id, v);
    }));
    return [...m.values()].sort((a, b) => b.count - a.count || b.km - a.km);
  };
  const towns = merge('towns').slice(0, 12), countries = merge('countries');
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const el = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };
  el('sp-towns', towns.length ? `<thead><tr><th></th><th>Town</th><th>Activities</th><th>${DU()}</th></tr></thead><tbody>` + towns.map((t, i) =>
    `<tr><td class="sp-rank">${i + 1}</td><th>${flagOf(t.country)}${escapeHTML(t.name)}</th><td>${t.count}</td><td>${km0(t.km)}</td></tr>`).join('') + '</tbody>'
    : '<tbody><tr><td class="sp-note">No start places yet (or the town list is missing).</td></tr></tbody>');
  el('sp-countries', countries.length ? `<thead><tr><th>Country</th><th>Activities</th><th>${DU()}</th><th>Since</th></tr></thead><tbody>` + countries.map(c =>
    `<tr><th>${flagOf(c.country)}${escapeHTML(names.of(c.country) || c.country)}</th><td>${c.count}</td><td>${km0(c.km)}</td><td>${c.first.slice(0, 4)}</td></tr>`).join('') + '</tbody>'
    : '<tbody><tr><td class="sp-note">–</td></tr></tbody>');
}

// --- interaction ---

function hookTips(box) {
  const tip = document.getElementById('sp-tip');
  box.querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('mouseenter', () => { tip.textContent = el.dataset.tip; tip.style.display = 'block'; });
    el.addEventListener('mousemove', e => { tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY + 12 + 'px'; });
    el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

function hookLinks(id) {
  document.getElementById(id).querySelectorAll('[data-activity]').forEach(el => el.addEventListener('click', e => {
    e.preventDefault();
    showActivityOnMap(+el.dataset.activity);
  }));
}

// To the map, zoomed to the activity, its popup open
function showActivityOnMap(id) {
  const a = allActivities.find(x => x.id === id);
  if (!a?.bbox) return toast('This activity has no route', 'error');
  document.querySelector('.tab[data-tab="map"]').click();
  if (!map.hasLayer(kindLayer[a.kind])) { kindLayer[a.kind].addTo(map); afterToggle(); drawLegend(); }
  setTimeout(() => {
    map.invalidateSize();
    map.fitBounds([[a.bbox[0], a.bbox[1]], [a.bbox[2], a.bbox[3]]], { padding: [40, 40], maxZoom: 14 });
    const mid = Math.floor(a.pts.length / 4) * 2;
    activityPopup(a, L.latLng(a.pts[mid], a.pts[mid + 1]));
  }, 80);
}

function initSports() {
  document.getElementById('sp-kinds').addEventListener('change', e => { sportPicked.kinds = e.target.value; renderSports(); });
  document.getElementById('sp-year').addEventListener('change', e => { sportPicked.year = e.target.value; renderSports(); });
}
