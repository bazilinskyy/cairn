'use strict';
// A report of everything, to keep or print: what it all adds up to (curiosities), the countries, year by year, and
// then every trip in turn with its countries and towns, how you got around, where you slept, your rides and runs, a
// few photos and a sketch of the way on the coast. One page of HTML made to be printed (A4); made into a PDF by the
// Chrome or Chromium of this computer when there is one (pdf()), else by the browser's own Save as PDF.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { stayKind } = require('./stats');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const names = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch (_) { return null; } })();
const countryName = cc => { try { return (cc && names?.of(cc)) || cc || ''; } catch (_) { return cc || ''; } };
const flag = cc => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '');
const num = n => Math.round(n || 0).toLocaleString('en-GB');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = d => (d ? `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}` : '');
const dayShort = d => (d ? `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}` : '');
const range = (a, b) => (!b || a === b ? day(a) : a.slice(0, 4) === b.slice(0, 4) ? `${dayShort(a)} – ${day(b)}` : `${day(a)} – ${day(b)}`);
const plural = (n, one, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`;
const MODES = { flight: ['✈️', 'Flights'], train: ['🚆', 'Trains'], bus: ['🚌', 'Buses'], ferry: ['⛴️', 'Ferries'], drive: ['🚗', 'Driving'],
  hitch: ['👍', 'Hitchhiking'], commute: ['🚉', 'Commuting'], ride: ['🚴', 'Rides'], run: ['🏃', 'Runs'], walk: ['🥾', 'Walks and hikes'],
  sport: ['🏅', 'Other sports'] };
const modeIcon = m => (MODES[m] || ['🛤️'])[0];
const sportKind = s => (/Ride|Velomobile|Handcycle/.test(s || '') ? 'ride' : /Run/.test(s || '') ? 'run' : /Walk|Hike/.test(s || '') ? 'walk'
  : /Swim/.test(s || '') ? 'swim' : 'sport');
const SPORTS = { ride: ['🚴', 'ride'], run: ['🏃', 'run'], walk: ['🥾', 'walk or hike', 'walks and hikes'], swim: ['🏊', 'swim', 'swims'], sport: ['🏅', 'other activity', 'other activities'] };
const COLORS = { flight: '#2f6fd6', train: '#1f9d55', bus: '#d97706', ferry: '#0e9fb3', drive: '#c2410c', hitch: '#7c3aed' };

// --- the coast, for the sketches: its lines with their boxes, read once ---
function coastLines(file) {
  let geo;
  try { geo = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return []; }
  const lines = [];
  for (const f of geo.features || []) {
    const g = f.geometry || {};
    for (const line of g.type === 'MultiLineString' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : []) {
      let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
      for (const [lon, lat] of line) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
      lines.push({ line, box: [w, s, e, n] });
    }
  }
  return lines;
}

// A sketch of a trip: the coast around it, the ways between places (flights dashed) and the towns, the most visited
// named; an SVG of W by H, or '' when nothing is placed. points: { towns: [{lat, lon, days, name}], legs: [{from:
// [lat, lon], to, mode}], beds: [[lat, lon]] }
const W = 600, H = 300;
function sketch({ towns = [], legs = [], beds = [] }, coast = []) {
  const all = [...towns.map(t => [t.lat, t.lon]), ...legs.flatMap(l => [l.from, l.to]), ...beds].filter(p => p && p[0] != null && p[1] != null);
  if (!all.length) return '';
  // across the date line: east of it counted on from 180°, when that makes the way shorter
  const spanOf = lons => Math.max(...lons) - Math.min(...lons);
  const shift = spanOf(all.map(p => p[1])) > 180 && spanOf(all.map(p => (p[1] < 0 ? p[1] + 360 : p[1]))) < spanOf(all.map(p => p[1]));
  const lonOf = lon => (shift && lon < 0 ? lon + 360 : lon);
  const s0 = Math.min(...all.map(p => p[0])), n0 = Math.max(...all.map(p => p[0]));
  const w0 = Math.min(...all.map(p => lonOf(p[1]))), e0 = Math.max(...all.map(p => lonOf(p[1])));
  const k = Math.cos(((s0 + n0) / 2) * Math.PI / 180) || 1;

  // the frame: a margin round the places, at least `least` degrees across, in the shape of the picture; and the coast
  // in it (and just past it), points closer than two pixels left out
  function frame(least) {
    let s = s0, n = n0, w = w0, e = e0;
    const padY = Math.max((n - s) * 0.12, least / 2), padX = Math.max((e - w) * 0.12, least / 2 / k);
    s -= padY; n += padY; w -= padX; e += padX;
    let spanX = (e - w) * k, spanY = n - s;
    if (spanX / spanY > W / H) { const more = (spanX * H / W - spanY) / 2; s -= more; n += more; spanY = n - s; }
    else { const more = (spanY * W / H / k - (e - w)) / 2; w -= more; e += more; spanX = (e - w) * k; }
    const scale = W / spanX, paths = [];
    let inside = 0;  // coast points in the picture itself
    for (const { line, box } of coast) {
      for (const off of shift ? [0, 360] : [0]) {
        if (box[2] + off < w - padX || box[0] + off > e + padX || box[3] < s - padY || box[1] > n + padY) continue;
        let run = [], last = null;
        const flush = () => { if (run.length > 1) paths.push('M' + run.join('L')); run = []; last = null; };
        for (const [lon0, lat] of line) {
          const lon = lon0 + off;
          if (lon < w - padX || lon > e + padX || lat < s - padY || lat > n + padY) { flush(); continue; }
          const p = [((lon - w) * k * scale), ((n - lat) * scale)];
          if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 2) continue;
          if (p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H) inside++;
          run.push(p.map(v => Math.round(v)).join(','));
          last = p;
        }
        flush();
      }
    }
    return { paths, inside, xy: (lat, lon) => [((lonOf(lon) - w) * k * scale), ((n - lat) * scale)] };
  }
  // a few degrees across at least; further out while no coast is in it (a town inland), up to a country's size
  let least = 3, f = frame(least);
  while (f.inside < 10 && coast.length && least < 24) f = frame(least *= 2);
  const { paths, xy } = f;

  const lines = legs.filter(l => l.from && l.to).map(l =>
    `<line x1="${xy(...l.from)[0].toFixed(1)}" y1="${xy(...l.from)[1].toFixed(1)}" x2="${xy(...l.to)[0].toFixed(1)}" y2="${xy(...l.to)[1].toFixed(1)}" ` +
    `stroke="${COLORS[l.mode] || '#6b7280'}" stroke-width="1.6"${l.mode === 'flight' ? ' stroke-dasharray="5 4"' : ''} stroke-linecap="round"/>`).join('');
  const most = [...towns].sort((a, b) => (b.days || 0) - (a.days || 0));
  const dots = most.map(t => { const [x, y] = xy(t.lat, t.lon); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(2 + Math.sqrt(t.days || 1)).toFixed(1)}"/>`; }).join('');
  // names for the towns of most days, none on top of another
  const placed = [], labels = [];
  for (const t of most) {
    if (labels.length >= 6) break;
    const [x, y] = xy(t.lat, t.lon), wide = 6.2 * (t.name || '').length;
    if (x < 0 || x > W || y < 10 || y > H) continue;
    const left = x + wide + 8 > W, box = [left ? x - wide - 6 : x + 6, y - 9, wide, 12];
    if (placed.some(b => box[0] < b[0] + b[2] && b[0] < box[0] + box[2] && box[1] < b[1] + b[3] && b[1] < box[1] + box[3])) continue;
    placed.push(box);
    labels.push(`<text x="${box[0].toFixed(1)}" y="${(y + 3).toFixed(1)}">${esc(t.name)}</text>`);
  }
  return `<svg class="sketch" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sketch of the trip">` +
    `<rect width="${W}" height="${H}" class="sea"/><path class="coast" d="${paths.join('')}"/>${lines}<g class="towns">${dots}</g><g class="labels">${labels.join('')}</g></svg>`;
}

// The world with every town you were in, for the cover: dots by how many days (an SVG, the coast simplified for its size)
const WW = 1000, WH = 420, NORTH = 82, SOUTH = -58;
function worldMap(towns, coast = []) {
  const scale = WW / 360, xy = (lat, lon) => [(lon + 180) * scale, (NORTH - lat) * (WH / (NORTH - SOUTH))];
  const paths = [];
  for (const { line } of coast) {
    let run = [], last = null;
    for (const [lon, lat] of line) {
      const p = xy(lat, lon);
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 2.5) continue;
      run.push(p.map(v => Math.round(v)).join(','));
      last = p;
    }
    if (run.length > 1) paths.push('M' + run.join('L'));
  }
  const cells = new Map();
  for (const t of towns) {
    if (t.lat == null || t.lon == null) continue;
    const k = `${Math.round(t.lat * 2)},${Math.round(t.lon * 2)}`, c = cells.get(k) || { lat: t.lat, lon: t.lon, days: 0 };
    c.days += t.days || 1;
    cells.set(k, c);
  }
  const dots = [...cells.values()].sort((a, b) => b.days - a.days).map(c => {
    const [x, y] = xy(c.lat, c.lon);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.min(9, 1.6 + Math.sqrt(c.days) * 0.45).toFixed(1)}"/>`;
  }).join('');
  return `<svg class="world" viewBox="0 0 ${WW} ${WH}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Every town you were in">` +
    `<path class="coast" d="${paths.join('')}"/><g class="dots">${dots}</g></svg>`;
}

// a bar of a share of the most, for the charts
const bar = (n, most) => `<i class="bar"><b style="width:${most ? Math.max(1.5, Math.round(1000 * n / most) / 10) : 0}%"></b></i>`;

// sources: getters (see app.js); a trip's flights, trips, stays, activities and photos are read from the lists by its
// days (quick for all of them; tripStore.get works out each one's moves, slow for hundreds)
function create({ trips, flights, airports, groundTrips, drives = () => [], stays, activities, photos, curiosities, years, countries,
  climbs = () => [], music = () => null, spending = () => null, books = () => [], nearTown = () => null, coastFile = null, today = () => new Date().toISOString().slice(0, 10) }) {
  let coast = null;
  const coastNow = () => (coast = coast || (coastFile ? coastLines(coastFile) : []));
  const titleOf = t => (t.countries || []).map(c => countryName(c.cc)).join(' · ') || t.name || 'A trip';
  const flagsOf = (t, most = 99) => (t.countries || []).slice(0, most).map(c => flag(c.cc)).join('') + ((t.countries || []).length > most ? '…' : '');

  // one trip: what it was, a sketch of it, how you got around, where you slept, your outings and a few photos
  function tripHtml(t, opts) {
    const inT = d => (d || '').slice(0, 10) >= t.start && (d || '').slice(0, 10) <= t.end;
    const ap = airports() || {};
    const fl = flights().filter(f => inT(f.date)).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const gt = groundTrips().filter(g => inT(g.date) && !g.approx).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const dr = drives().filter(d => inT(d.date));
    const st = stays().filter(s => s.start && ((s.start <= t.end && (s.end || s.start) > t.start) || (s.start === t.start && !s.end)))
      .sort((a, b) => a.start.localeCompare(b.start));
    const acts = activities().filter(a => inT(a.date) && !/Virtual/i.test(a.sport || '')).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const from = Date.parse(t.start) / 1000, to = Date.parse(t.end) / 1000 + 86400;
    const ph = photos().filter(p => p[1] >= from && p[1] < to && !p[4]).sort((a, b) => a[1] - b[1]);

    // how far by each means (sports apart)
    const by = {};
    fl.forEach(f => { by.flight = (by.flight || 0) + (f.distance || 0); });
    gt.forEach(g => { by[g.mode] = (by[g.mode] || 0) + (g.distance || 0) * (g.times || 1); });
    dr.forEach(d => { by.drive = (by.drive || 0) + (d.distance || 0); });
    const travelled = Object.values(by).reduce((n, km) => n + km, 0);
    const means = Object.entries(by).filter(([, km]) => km >= 1).sort((a, b) => b[1] - a[1])
      .map(([m, km]) => `<span>${modeIcon(m)} ${num(km)} km</span>`).join('');
    const sport = {};
    acts.forEach(a => { const k = sportKind(a.sport), x = sport[k] = sport[k] || { n: 0, km: 0, up: 0 }; x.n++; x.km += a.distance || 0; x.up += a.elevation || 0; });
    const sports = Object.entries(sport).sort((a, b) => b[1].km - a[1].km).map(([k, x]) => {
      const [icon, one, many] = SPORTS[k];
      return `<span>${icon} ${plural(x.n, one, many)}${x.km >= 1 ? ` · ${num(x.km)} km` : ''}${x.up >= 100 ? ` · ${num(x.up)} m↑` : ''}</span>`;
    }).join('');

    const place = c => { const a = ap[c]; return a ? `${esc(a.city || a.name || c)} <small>${esc(c)}</small>` : esc(c); };
    const moves = [
      ...fl.map(f => ({ d: f.date, html: `<td class="d">${dayShort(f.date)}</td><td class="i">✈️</td><td>${place(f.from)} → ${place(f.to)}<small class="what">${esc([f.flight_number, f.airline].filter(Boolean).join(' · '))}</small></td><td class="n">${f.distance ? num(f.distance) : ''}</td>` })),
      ...gt.map(g => ({ d: g.date, html: `<td class="d">${dayShort(g.date)}</td><td class="i">${modeIcon(g.mode)}</td><td>${esc(g.from)} → ${esc(g.to)}${g.service ? `<small class="what">${esc(g.service)}</small>` : ''}</td><td class="n">${g.distance ? num(g.distance) : ''}</td>` }))
    ].sort((a, b) => (a.d || '').localeCompare(b.d || ''));
    const beds = st.map(s => `<tr><td class="d">${s.end && s.end !== s.start ? `${dayShort(s.start)}–${dayShort(s.end)}` : dayShort(s.start)}</td>` +
      `<td class="i">${s.what === 'car' ? '🚗' : '🛏️'}</td><td>${esc(s.place || '')}${s.hotel ? `<small class="what">${esc(s.hotel)}</small>` : ''}</td>` +
      `<td class="k">${esc(s.what === 'car' ? 'Car' : stayKind(s))}</td></tr>`).join('');
    const longest = acts.filter(a => (a.distance || 0) >= 1).sort((a, b) => b.distance - a.distance).slice(0, 4)
      .map(a => `<li><span class="i">${SPORTS[sportKind(a.sport)][0]}</span> ${esc(a.name || a.sport)} <small>${dayShort(a.date)} · ${num(a.distance)} km${a.elevation >= 100 ? ` · ${num(a.elevation)} m↑` : ''}</small></li>`).join('');

    // up to six photos spread over the trip
    const shown = [];
    if (opts.photos && ph.length) {
      const want = Math.min(6, ph.length);
      for (let i = 0; i < want; i++) shown.push(ph[Math.floor((i + 0.5) * ph.length / want)]);
    }
    const map = sketch({
      towns: (t.towns || []).filter(x => x.lat != null),
      legs: [
        ...fl.map(f => ap[f.from] && ap[f.to] && { from: [ap[f.from].lat, ap[f.from].lon], to: [ap[f.to].lat, ap[f.to].lon], mode: 'flight' }),
        ...gt.map(g => g.from_lat != null && g.to_lat != null && { from: [g.from_lat, g.from_lon], to: [g.to_lat, g.to_lon], mode: g.mode }),
        ...dr.map(d => ({ from: [d.from_lat, d.from_lon], to: [d.to_lat, d.to_lon], mode: 'drive' }))
      ].filter(Boolean),
      beds: st.filter(s => s.lat != null && s.what !== 'car').map(s => [s.lat, s.lon])
    }, coastNow());

    const extras = [];
    const m = music({ from: t.start, to: t.end });
    if (m?.artists?.length) extras.push(`<p><span class="i">🎧</span> ${m.artists.slice(0, 3).map(a => esc(a.name)).join(', ')}</p>`);
    const read = books(t.start, t.end) || [];
    if (read.length) extras.push(`<p><span class="i">📚</span> ${read.map(b => `<i>${esc(b.title)}</i>`).join(', ')}</p>`);
    const spent = spending(t.start, t.end);
    if (spent?.eur) extras.push(`<p><span class="i">💶</span> ${num(spent.eur)} € on stays${spent.perNight ? `, ${num(spent.perNight)} € a night` : ''}</p>`);

    const stats = [[num(t.days), t.days === 1 ? 'day' : 'days'], t.nights && [num(t.nights), t.nights === 1 ? 'night' : 'nights'],
      travelled >= 1 && [num(travelled), 'km travelled'], ph.length && [num(ph.length), ph.length === 1 ? 'photo' : 'photos']].filter(Boolean);
    const countriesLine = (t.countries || []).length > 1 ? `<p class="chips">${t.countries.map(c => `<span>${flag(c.cc)} ${esc(countryName(c.cc))} <small>${c.days}</small></span>`).join('')}</p>` : '';
    const towns = (t.towns || []).slice(0, 14).map(x => `${esc(x.name)}${x.days > 1 ? `<small> ${x.days}</small>` : ''}`).join(', ');
    const tables = [moves.length && `<div><h4>Getting around</h4><table class="list">${moves.map(x => `<tr>${x.html}</tr>`).join('')}</table></div>`,
      beds && `<div><h4>Where you slept</h4><table class="list">${beds}</table></div>`].filter(Boolean);
    return `<article class="trip${map ? '' : ' nomap'}" id="trip-${esc(t.id)}">
<header><h3><span class="flags">${flagsOf(t)}</span> ${esc(titleOf(t))}</h3><p class="when">${range(t.start, t.end)}${t.work?.length ? ' · 💼 work' : ''}</p></header>
<div class="top">${map ? `<figure class="map">${map}</figure>` : ''}<div class="facts">
<div class="stats">${stats.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>
${countriesLine}
${towns ? `<p class="towns">${towns}</p>` : ''}
${means ? `<p class="chips">${means}</p>` : ''}
${sports ? `<p class="chips sport">${sports}</p>` : ''}
${extras.join('')}
</div></div>
${tables.length ? `<div class="tables${tables.length > 1 ? ' two' : ''}">${tables.join('')}</div>` : ''}
${longest ? `<h4>Longest outings</h4><ul class="outings">${longest}</ul>` : ''}
${shown.length ? `<div class="photos">${shown.map(p => `<img src="/api/photos/${encodeURIComponent(p[0])}/small" alt="">`).join('')}</div>` : ''}
</article>`;
  }

  // what it all adds up to (curiosities.js)
  function glance(c, cs) {
    const out = [];
    const towns = cs.reduce((n, x) => n + (x.towns || 0), 0);
    const big = [
      c?.trips && [num(c.trips.count), 'trips'], c?.trips && [num(c.trips.awayDays), 'days away'], [num(cs.length), 'countries'],
      [num(towns), 'towns'], [num(flights().length), 'flights'], c?.distance && [`${c.distance.earth}×`, 'around the Earth']
    ].filter(Boolean);
    out.push(`<div class="big">${big.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>`);
    const halves = [];
    if (c?.distance?.by) {
      const rows = Object.entries(c.distance.by).filter(([, km]) => km >= 1).sort((a, b) => b[1] - a[1]), most = rows[0]?.[1];
      halves.push(`<div><h3>How far</h3><table class="chart">${rows.map(([m, km]) =>
        `<tr><td>${modeIcon(m)} ${esc((MODES[m] || [, m])[1])}</td><td>${bar(km, most)}</td><td class="n">${num(km)} km</td></tr>`).join('')}` +
        `<tr class="sum"><td>All together</td><td></td><td class="n">${num(c.distance.total)} km</td></tr></table></div>`);
    }
    if (c?.beds) {
      const rows = Object.entries(c.beds).sort((a, b) => b[1] - a[1]), most = rows[0]?.[1];
      halves.push(`<div><h3>Nights by bed</h3><table class="chart">${rows.map(([k, n]) =>
        `<tr><td>${esc(k)}</td><td>${bar(n, most)}</td><td class="n">${num(n)}</td></tr>`).join('')}</table></div>`);
    }
    if (halves.length) out.push(`<div class="halves">${halves.join('')}</div>`);
    if (c) {
      // a place with no town of its own (a mountain top, the sea): near the nearest one
      const where = x => {
        if (!x) return '';
        const near = !x.town && x.lat != null ? nearTown(x.lat, x.lon) : null, cc = x.country || near?.cc;
        const name = x.town ? esc(x.town) : near ? `near ${esc(near.name)}` : `${x.lat?.toFixed(2)}, ${x.lon?.toFixed(2)}`;
        return `${cc ? `${flag(cc)} ` : ''}${name}<small>${day(x.day)}</small>`;
      };
      const cards = [
        c.extremes?.north && ['🧭', 'Farthest north', where(c.extremes.north)], c.extremes?.south && ['🧭', 'Farthest south', where(c.extremes.south)],
        c.extremes?.east && ['🧭', 'Farthest east', where(c.extremes.east)], c.extremes?.west && ['🧭', 'Farthest west', where(c.extremes.west)],
        c.heights?.top && ['🏔️', `Highest, ${num(c.heights.top.h)} m`, where(c.heights.top)],
        c.below?.lowest && ['🌊', `Lowest, ${num(c.below.lowest.h)} m`, where(c.below.lowest)],
        c.longest?.nights && ['🛏️', `Longest stay, ${plural(c.longest.nights, 'night')}`, `${esc(c.longest.place)}<small>from ${day(c.longest.start)}</small>`],
        c.mostCountries?.count && ['🗺️', `${c.mostCountries.count} countries in a day`, `${c.mostCountries.countries.map(flag).join('')}<small>${day(c.mostCountries.day)}</small>`],
        c.sea?.days && ['🏖️', 'Days by the sea', num(c.sea.days)],
        c.capitals?.length && ['🏛️', 'Capitals', num(c.capitals.length)],
        c.crossings && ['🌐', 'Equator crossed', plural(c.crossings.equator || 0, 'time')]
      ].filter(Boolean);
      out.push(`<h3>Records</h3><div class="cards">${cards.map(([i, k, v]) => `<div><span class="i">${i}</span><span class="k">${k}</span><b>${v}</b></div>`).join('')}</div>`);
    } else out.push('<p class="note">The records are still being worked out: make the report again in a few minutes for them.</p>');
    const ridden = (climbs() || []).filter(x => x.times > 0).sort((a, b) => (b.ele || 0) - (a.ele || 0));
    if (ridden.length) {
      out.push(`<h3>Climbs ridden <small>${num(ridden.length)}</small></h3><p class="chips">${ridden.slice(0, 8).map(x =>
        `<span>${flag(x.country)} ${esc(x.name)} <small>${num(x.ele)} m</small></span>`).join('')}</p>`);
    }
    return out.join('\n');
  }

  // the whole report: opts { from, to (years, both kept), photos (thumbnails on each trip) }
  function html(opts = {}) {
    const now = today();
    const o = { from: +opts.from || 0, to: +opts.to || 9999, photos: opts.photos !== false };
    const all = trips().filter(t => t.start).sort((a, b) => a.start.localeCompare(b.start));
    const done = all.filter(t => t.start <= now && +t.start.slice(0, 4) >= o.from && +t.start.slice(0, 4) <= o.to);
    const coming = all.filter(t => t.start > now);
    const c = curiosities(), cs = countries() || [], ys = (years() || []).filter(y => y.days || y.trips);
    const byYear = new Map(ys.map(y => [String(y.year), y]));
    const groups = new Map();
    done.forEach(t => { const y = t.start.slice(0, 4); if (!groups.has(y)) groups.set(y, []); groups.get(y).push(t); });
    const span = done.length ? `${done[0].start.slice(0, 4)}–${done[done.length - 1].start.slice(0, 4)}` : '';
    const yearHead = y => {
      const r = byYear.get(y);
      const bits = r ? [[num(r.trips), r.trips === 1 ? 'trip' : 'trips'], [num(r.away), 'days away'],
        [num(r.countries) + (r.newCountries ? `<small> +${r.newCountries}</small>` : ''), r.countries === 1 ? 'country' : 'countries'],
        [num(r.towns) + (r.newTowns ? `<small> +${r.newTowns}</small>` : ''), 'towns'], r.photos && [num(r.photos), 'photos']].filter(Boolean) : [];
      return `<header class="year-head" id="year-${y}"><h2>${y}</h2>${bits.length ? `<div class="stats">${bits.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>` : ''}</header>`;
    };
    const mostDays = cs[0]?.days || 0, mostAway = Math.max(0, ...ys.map(y => y.away || 0));
    const contents = [...groups].map(([y, ts]) => `<div class="toc-year"><a class="y" href="#year-${y}">${y}</a>${ts.map(t =>
      `<a href="#trip-${esc(t.id)}"><span>${dayShort(t.start)}</span> ${flagsOf(t, 4)} ${esc((t.countries || []).map(x => countryName(x.cc)).slice(0, 3).join(', ') || t.name)}</a>`).join('')}</div>`).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cairn · your travels${span ? ` ${span}` : ''}</title>
<style>
@page { size: A4; margin: 15mm 14mm 16mm;
  @bottom-left { content: "Cairn · Your travels"; font: 7.5pt "Avenir Next", "Segoe UI", sans-serif; color: #8a94a3; }
  @bottom-right { content: counter(page) " / " counter(pages); font: 7.5pt "Avenir Next", "Segoe UI", sans-serif; color: #8a94a3; } }
@page :first { margin: 0; @bottom-left { content: none; } @bottom-right { content: none; } }
:root { --ink: #17202c; --muted: #6b7686; --line: #e3e7ec; --soft: #f3f5f8; --accent: #c2410c; --accent-soft: #fbeee6; --sea: #edf3f8; --coast: #a3b3c4; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 9.5pt/1.45 "Avenir Next", "Inter", "Segoe UI", Roboto, "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", sans-serif; color: var(--ink); background: #fff; }
main { max-width: 182mm; margin: 0 auto; padding: 16px; }
a { color: inherit; text-decoration: none; }
h2 { font-size: 22pt; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 4mm; }
h3 { font-size: 12pt; font-weight: 650; margin: 6mm 0 2mm; break-after: avoid; }
h3 small { color: var(--muted); font-weight: 500; }
h4 { font-size: 7.5pt; font-weight: 650; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 3.5mm 0 1mm; break-after: avoid; }
small { color: var(--muted); font-size: 8pt; }
.note { color: var(--muted); }
.part { break-before: page; }
.eyebrow { font-size: 8pt; font-weight: 650; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); margin: 0 0 2mm; }
.print { position: fixed; top: 12px; right: 12px; padding: 8px 14px; border-radius: 8px; border: 0; background: var(--ink); color: #fff; font: inherit; cursor: pointer; z-index: 2; }

/* the cover */
.cover { height: 297mm; display: flex; flex-direction: column; justify-content: space-between; padding: 26mm 20mm 22mm; background: #17202c; color: #fff; }
.cover h1 { font-size: 46pt; line-height: 1; font-weight: 700; letter-spacing: -0.03em; margin: 0 0 4mm; }
.cover .sub { font-size: 14pt; color: #c3cad4; margin: 0; }
.cover .eyebrow { color: #f0a47a; }
.cover .world { width: calc(100% + 40mm); margin: 0 -20mm; height: auto; display: block; }
.cover .world .coast { fill: none; stroke: #53627a; stroke-width: 0.9; }
.cover .world .dots circle { fill: #f08a4b; fill-opacity: .55; stroke: #f8b48a; stroke-width: 0.5; }
.cover .big { margin: 0; }
.cover .big div { background: rgba(255,255,255,.07); }
.cover .big span { color: #aab3c0; }
.cover .made { font-size: 8pt; color: #8a94a3; margin: 4mm 0 0; }

/* numbers, bars and cards */
.big { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; margin: 2mm 0 4mm; }
.big div { background: var(--soft); border-radius: 3mm; padding: 3.5mm 4mm; }
.big b { display: block; font-size: 20pt; line-height: 1.1; font-weight: 700; letter-spacing: -0.02em; }
.big span { color: var(--muted); font-size: 8.5pt; }
.halves { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; }
table.chart { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
table.chart td { padding: 1.1mm 2mm 1.1mm 0; white-space: nowrap; }
table.chart td:nth-child(2) { width: 50%; }
table.chart .n { text-align: right; font-variant-numeric: tabular-nums; }
table.chart tr.sum td { font-weight: 650; border-top: 1px solid var(--line); padding-top: 1.6mm; }
.bar { display: block; height: 2.2mm; background: var(--soft); border-radius: 2mm; overflow: hidden; }
.bar b { display: block; height: 100%; background: var(--accent); border-radius: 2mm; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2.5mm; }
.cards div { border: 1px solid var(--line); border-radius: 2.5mm; padding: 2.5mm 3mm; break-inside: avoid; }
.cards .i { float: right; font-size: 12pt; }
.cards .k { display: block; color: var(--muted); font-size: 8pt; }
.cards b { display: block; font-weight: 600; font-size: 10pt; }
.cards b small { display: block; font-weight: 400; }
.chips { display: flex; flex-wrap: wrap; gap: 1.5mm; margin: 1.5mm 0; }
.chips span { background: var(--soft); border-radius: 99px; padding: 0.6mm 2.6mm; font-size: 8.5pt; white-space: nowrap; }
.chips.sport span { background: var(--accent-soft); }

/* countries and years */
.countries { columns: 3; column-gap: 6mm; font-size: 8.5pt; }
.countries div { break-inside: avoid; display: grid; grid-template-columns: 1fr auto; column-gap: 2mm; padding: 0.8mm 0; border-bottom: 1px solid var(--soft); }
.countries .n { font-variant-numeric: tabular-nums; }
.countries .bar { grid-column: 1 / -1; height: 1.2mm; margin-top: 0.6mm; }
.countries small { grid-column: 1 / -1; font-size: 7pt; }
table.years { width: 100%; border-collapse: collapse; font-size: 8.5pt; font-variant-numeric: tabular-nums; }
table.years th { text-align: right; color: var(--muted); font-weight: 600; font-size: 7.5pt; padding: 0 0 1mm 2mm; }
table.years td { text-align: right; padding: 0.7mm 0 0.7mm 2mm; border-bottom: 1px solid var(--soft); white-space: nowrap; }
table.years td:first-child, table.years th:first-child { text-align: left; padding-left: 0; font-weight: 650; }
table.years td.b { width: 26%; }
table.years tr { break-inside: avoid; }
.toc { columns: 3; column-gap: 6mm; font-size: 7.5pt; line-height: 1.5; }
.toc-year { break-inside: avoid; margin-bottom: 2.5mm; }
.toc-year .y { display: block; font-size: 10pt; font-weight: 700; color: var(--accent); }
.toc-year a { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.toc-year a span { color: var(--muted); display: inline-block; min-width: 11mm; }

/* a year, and its trips */
.year-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 6mm; border-bottom: 2px solid var(--ink); padding-bottom: 2mm; margin-bottom: 1mm; }
.year-head h2 { font-size: 40pt; line-height: .9; color: var(--accent); margin: 0; }
.stats { display: flex; gap: 5mm; flex-wrap: wrap; }
.stats div { display: flex; flex-direction: column; }
.stats b { font-size: 13pt; font-weight: 700; line-height: 1.1; }
.stats span { font-size: 7.5pt; color: var(--muted); }
.trip { break-inside: avoid; padding: 5mm 0 5mm; border-bottom: 1px solid var(--line); }
.trip header { display: flex; justify-content: space-between; align-items: baseline; gap: 4mm; margin-bottom: 2.5mm; }
.trip h3 { margin: 0; font-size: 13.5pt; line-height: 1.2; }
.trip .flags { letter-spacing: .05em; }
.trip .when { margin: 0; color: var(--muted); white-space: nowrap; font-size: 9pt; }
.top { display: grid; grid-template-columns: 88mm 1fr; gap: 5mm; align-items: start; }
.trip.nomap .top { grid-template-columns: 1fr; }
.map { margin: 0; }
.facts p { margin: 0 0 1.5mm; }
.facts .stats { margin-bottom: 2.5mm; }
.facts .towns { font-size: 8.5pt; }
.facts .i { display: inline-block; width: 5mm; }
.sketch { width: 100%; height: auto; display: block; border-radius: 2.5mm; border: 1px solid var(--line); }
.sketch .sea { fill: var(--sea); }
.sketch .coast { fill: none; stroke: var(--coast); stroke-width: 0.9; }
.sketch .towns circle { fill: var(--accent); fill-opacity: .85; stroke: #fff; stroke-width: 1; }
.sketch .labels text { font: 600 10px "Avenir Next", "Segoe UI", sans-serif; fill: var(--ink); paint-order: stroke; stroke: #fff; stroke-width: 3px; stroke-linejoin: round; }
.tables.two { display: grid; grid-template-columns: 1.25fr 1fr; gap: 5mm; }
table.list { width: 100%; border-collapse: collapse; font-size: 8pt; }
table.list td { padding: 0.8mm 1.5mm 0.8mm 0; vertical-align: top; border-bottom: 1px solid var(--soft); }
table.list tr { break-inside: avoid; }
table.list .d { white-space: nowrap; color: var(--muted); width: 1%; }
table.list .i { width: 5mm; }
table.list .n { text-align: right; white-space: nowrap; color: var(--muted); font-variant-numeric: tabular-nums; }
table.list .k { white-space: nowrap; color: var(--muted); }
table.list .what { display: block; font-size: 7pt; }
ul.outings { margin: 0; padding: 0; list-style: none; font-size: 8.5pt; columns: 2; column-gap: 5mm; }
ul.outings li { break-inside: avoid; margin-bottom: .6mm; }
.photos { display: grid; grid-template-columns: repeat(6, 1fr); gap: 1.5mm; margin-top: 3mm; }
.photos img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 1.8mm; background: var(--soft); display: block; }
.coming td { padding: 1mm 4mm 1mm 0; }

@media screen { .cover { border-radius: 4mm; height: auto; min-height: 240mm; } .part { margin-top: 14mm; } }
@media print { .print { display: none; } main { max-width: none; padding: 0; } }
@media (max-width: 700px) { .top, .tables.two, .halves { grid-template-columns: 1fr; } .big, .cards { grid-template-columns: repeat(2, 1fr); }
  .toc, .countries { columns: 1; } .photos { grid-template-columns: repeat(3, 1fr); } .trip header { flex-direction: column; } .cover { padding: 12mm 8mm; } .cover h1 { font-size: 32pt; } }
</style></head><body>
<button class="print" onclick="print()">Save as PDF</button>
<main>
<section class="cover">
<div><p class="eyebrow">Cairn</p><h1>Your travels</h1><p class="sub">${done.length ? `${plural(done.length, 'trip')}${span ? ` · ${span}` : ''}` : 'No trips yet'}</p></div>
${worldMap(done.flatMap(t => t.towns || []), coastNow())}
<div><div class="big">${[c?.trips && [num(c.trips.awayDays), 'days away'], [num(cs.length), 'countries'], c?.distance && [c.distance.total >= 1e6 ? `${(c.distance.total / 1e6).toFixed(1)} million` : num(c.distance.total), 'km travelled']]
  .filter(Boolean).map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div><p class="made">Made on ${day(now)}</p></div>
</section>
<section class="part"><p class="eyebrow">At a glance</p><h2>All of it</h2>${glance(c, cs)}</section>
${cs.length ? `<section class="part"><p class="eyebrow">Where</p><h2>${plural(cs.length, 'country', 'countries')}</h2><div class="countries">${cs.map(x =>
  `<div><span>${flag(x.cc)} ${esc(x.name || countryName(x.cc || x.country))}</span><span class="n">${num(x.days)} d</span>${bar(x.days, mostDays)}` +
  `<small>${x.visits > 1 ? `${x.visits} visits · ` : ''}${esc((x.first || '').slice(0, 4))}${x.last && x.last.slice(0, 4) !== (x.first || '').slice(0, 4) ? `–${esc(x.last.slice(0, 4))}` : ''}</small></div>`).join('')}</div></section>` : ''}
${ys.length ? `<section class="part"><p class="eyebrow">When</p><h2>Year by year</h2><table class="years"><tr><th>Year</th><th>Days away</th><th></th><th>Trips</th><th>Countries</th><th>Towns</th><th>Flown</th><th>Photos</th></tr>${ys.map(y =>
  `<tr><td><a href="#year-${y.year}">${y.year}</a></td><td>${num(y.away)}</td><td class="b">${bar(y.away, mostAway)}</td><td>${num(y.trips)}</td>` +
  `<td>${num(y.countries)}${y.newCountries ? `<small> +${y.newCountries}</small>` : ''}</td><td>${num(y.towns)}${y.newTowns ? `<small> +${y.newTowns}</small>` : ''}</td>` +
  `<td>${y.distance?.flight ? `${num(y.distance.flight)} km` : ''}</td><td>${y.photos ? num(y.photos) : ''}</td></tr>`).join('')}</table></section>` : ''}
${done.length ? `<section class="part"><p class="eyebrow">Trips</p><h2>Contents</h2><div class="toc">${contents}</div></section>` : ''}
${[...groups].map(([y, ts]) => `<section class="part year">${yearHead(y)}${ts.map(t => tripHtml(t, o)).join('\n')}</section>`).join('\n')}
${coming.length ? `<section class="part"><p class="eyebrow">Next</p><h2>Coming up</h2><table class="list coming">${coming.map(t => `<tr><td class="d">${range(t.start, t.end)}</td><td>${flagsOf(t)} ${esc(titleOf(t))}</td></tr>`).join('')}</table></section>` : ''}
</main></body></html>`;
  }

  return { html, tripHtml };
}

// --- the PDF: the report printed by a Chrome or Chromium of this computer ---
const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const findBrowser = (given, exists = fs.existsSync) => [given, process.env.CHROME, ...BROWSERS].filter(Boolean).find(p => exists(p)) || null;

// prints url to a PDF in a folder of its own (in its own profile: the Chrome you use may be open); resolves with the
// file, which the caller removes with its folder
function pdf(url, { browser, timeoutMs = 15 * 60e3, run = execFile } = {}) {
  return new Promise((resolve, reject) => {
    if (!browser) return reject(Object.assign(new Error('no Chrome or Chromium on this computer'), { status: 501 }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-report-')), file = path.join(dir, 'report.pdf');
    run(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      `--user-data-dir=${path.join(dir, 'profile')}`, '--no-pdf-header-footer', '--generate-pdf-document-outline', `--print-to-pdf=${file}`, url],
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, err => {
      if (!err && fs.existsSync(file) && fs.statSync(file).size > 0) return resolve({ file, dir });
      fs.rmSync(dir, { recursive: true, force: true });
      reject(err || new Error('the browser made no PDF'));
    });
  });
}

module.exports = { create, sketch, worldMap, coastLines, findBrowser, pdf, esc };
