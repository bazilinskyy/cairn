'use strict';
// The Add tab beyond flights: a train, bus or ferry, or a stay, entered by hand, with the date as well as you remember
// it (a day, a month or only a year; a trip taken many times as one entry), and the journeys your photos show but
// nothing else does, to add with a click. Uses the page's globals (allTrips, allStays, drawGround, drawStays, toast).

let addKind = 'flight';
const rand = () => Math.random().toString(36).slice(2, 10);
const MODES = { train: '🚆 Train', bus: '🚌 Bus', ferry: '⛴️ Ferry', hitch: '👍 Hitchhiking' };

function showAddKind(kind) {
  addKind = kind;
  document.querySelectorAll('.add-kinds [data-add]').forEach(b => b.className = `btn ${b.dataset.add === kind ? 'btn-primary' : 'btn-ghost'}`);
  document.getElementById('add-flight').hidden = kind !== 'flight';
  document.querySelector('.add-page').classList.toggle('wide', kind === 'suggest' || kind === 'health');
  const box = document.getElementById('add-other');
  box.innerHTML = kind === 'ground' ? groundForm() : kind === 'stay' ? stayForm() : kind === 'suggest' ? '<p class="subtitle">Looking at your photos…</p>' :
    kind === 'health' ? '<p class="subtitle">Looking for what looks wrong…</p>' : '';
  if (kind === 'ground') hookGroundForm();
  if (kind === 'stay') hookStayForm();
  if (kind === 'suggest') renderSuggestions();
  if (kind === 'health') renderHealth();
}

const field = (label, html, style = '') => `<div class="form-group"${style ? ` style="${style}"` : ''}><label>${label}</label>${html}</div>`;
const whenFields = (id, label) => field(label,
  `<div style="display:flex;gap:6px"><select id="${id}-prec" aria-label="How exactly" style="flex:0 0 110px"><option value="day">Day</option><option value="month">Month</option><option value="year">Only the year</option></select>` +
  `<input type="date" id="${id}-day"><input type="month" id="${id}-month" hidden><input type="number" id="${id}-year" min="1950" max="2100" placeholder="2005" hidden></div>`);
function hookWhen(id) {
  const prec = document.getElementById(`${id}-prec`);
  prec.addEventListener('change', () => ['day', 'month', 'year'].forEach(p => { document.getElementById(`${id}-${p}`).hidden = p !== prec.value; }));
}
// "YYYY-MM-DD HH:MM:00" and how exact it is, or null
function readWhen(id, time = '') {
  const prec = document.getElementById(`${id}-prec`).value, v = document.getElementById(`${id}-${prec}`).value;
  if (!v) return null;
  if (prec === 'day') return { date: `${v} ${time || '12:00'}:00` };
  if (prec === 'month') return { date: `${v}-01 12:00:00`, approx: 'month' };
  return /^\d{4}$/.test(v) ? { date: `${v}-01-01 12:00:00`, approx: 'year' } : null;
}

function groundForm() {
  return `<div class="form-step"><h3>A train, bus, ferry or a lift (hitchhiking)</h3>` +
    `<div class="form-row">${field('How', `<select id="g-mode">${Object.entries(MODES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`, 'flex:0 0 150px')}` +
    field('From', '<input id="g-from" placeholder="Lviv" autocomplete="off">') + field('To', '<input id="g-to" placeholder="Kraków" autocomplete="off">') + '</div>' +
    `<div class="form-row">${whenFields('g-when', 'When')}${field('Leaving at', '<input id="g-time" type="time">', 'flex:0 0 120px')}</div>` +
    `<div class="form-row">${field('Times taken', '<input id="g-times" type="number" min="1" value="1">', 'flex:0 0 120px')}` +
    field('Train or bus number, operator', '<input id="g-service" placeholder="optional" autocomplete="off">') + '</div>' +
    `<div class="form-row"><label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" id="g-back"> And back the same way</label></div>` +
    `<div class="form-row" id="g-back-row" hidden>${whenFields('g-back-when', 'Back on')}</div>` +
    `<p class="sp-note">Only a year or a month: the line is drawn and its distance counted, but no day is made up for it. Times taken: one entry for a trip you made many times (each way).</p>` +
    `<div class="form-actions"><button class="btn btn-primary" id="g-save">Add</button></div></div>`;
}
function hookGroundForm() {
  hookWhen('g-when'); hookWhen('g-back-when');
  const back = document.getElementById('g-back');
  back.addEventListener('change', () => { document.getElementById('g-back-row').hidden = !back.checked; });
  document.getElementById('g-save').addEventListener('click', async () => {
    const $ = id => document.getElementById(id).value.trim();
    const there = readWhen('g-when', $('g-time'));
    if (!$('g-from') || !$('g-to') || !there) return toast('From, to and when are needed', 'error');
    const base = { mode: $('g-mode'), service: $('g-service'), source: 'manual', times: Math.max(1, +$('g-times') || 1) };
    const legs = [{ ...base, ...there, from: $('g-from'), to: $('g-to'), event_id: 'manual-' + rand() }];
    if (back.checked) {
      const home = readWhen('g-back-when') || (there.approx ? there : null);
      if (!home) return toast('When did you come back?', 'error');
      legs.push({ ...base, ...home, from: $('g-to'), to: $('g-from'), event_id: 'manual-' + rand() });
    }
    for (const leg of legs) {
      const t = await fetch('/api/ground', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(leg) }).then(r => r.json());
      allTrips.push(t);
      drawGround();
    }
    toast(`Added: ${legs.map(l => `${l.from} → ${l.to}`).join(', ')}. Its places and track are looked up in a minute.`);
    showAddKind('ground');
  });
}

function stayForm() {
  return `<div class="form-step"><h3>A stay</h3>` +
    `<div class="form-row">${field('Where (town)', '<input id="s-place" placeholder="St Petersburg" autocomplete="off">')}${field('Country', '<input id="s-country" placeholder="optional" autocomplete="off">', 'flex:0 0 160px')}</div>` +
    `<div class="form-row">${field('From', '<input id="s-start" type="date">')}${field('Until', '<input id="s-end" type="date">')}</div>` +
    `<div class="form-row">${field('What', '<select id="s-type"><option>hotel</option><option>hostel</option><option>flat</option><option>friends</option><option>family</option><option>camping</option><option>Couchsurfing</option><option>other</option></select>', 'flex:0 0 160px')}` +
    field('Name', '<input id="s-hotel" placeholder="optional" autocomplete="off">') + '</div>' +
    `<div class="form-actions"><button class="btn btn-primary" id="s-save">Add</button></div></div>`;
}
function hookStayForm() {
  document.getElementById('s-save').addEventListener('click', async () => {
    const $ = id => document.getElementById(id).value.trim();
    if (!$('s-place') || !$('s-start')) return toast('Where and from when are needed', 'error');
    const s = { code: 'manual-' + rand(), what: 'stay', place: $('s-place'), country: $('s-country'), start: $('s-start'), end: $('s-end') || $('s-start'),
      type: $('s-type') === 'other' ? '' : $('s-type'), hotel: $('s-hotel'), provider: $('s-type') === 'Couchsurfing' ? 'Couchsurfing' : '', price: '', source: 'manual' };
    const saved = await fetch('/api/stays', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(r => r.json());
    allStays.push(saved);
    toast(`Added: ${s.place}, ${s.start}. Its place is looked up in a minute.`);
    showAddKind('stay');
  });
}

// --- suggestions: the legs your photos show, grouped into journeys (legs at most 3 days apart) ---

async function renderSuggestions() {
  const list = await fetch('/api/suggestions').then(r => (r.ok ? r.json() : [])).catch(() => []);
  const box = document.getElementById('add-other');
  box.innerHTML = '<div id="todo-suggestions"></div><div id="tripdoc-suggestions"></div><div id="album-suggestions"></div><div id="album-places"></div><div id="payment-suggestions"></div><div id="gap-suggestions"></div><div id="leg-suggestions"></div>';
  renderTodoSuggestions();
  renderTripdocSuggestions();
  renderAlbumSuggestions();
  renderAlbumPlaces();
  renderPaymentSuggestions();
  renderGapSuggestions();
  const legs = document.getElementById('leg-suggestions');
  if (!list.length) { legs.innerHTML = '<p class="subtitle">Nothing to suggest: every move your photos show is already connected.</p>'; return; }
  const groups = [];
  [...list].reverse().forEach(s => {
    const g = groups[groups.length - 1];
    if (g && (Date.parse(s.from_day) - Date.parse(g[g.length - 1].to_day)) / 864e5 <= 3) g.push(s); else groups.push([s]);
  });
  groups.reverse();
  const when = s => {
    const t = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    return s.from_day === s.to_day ? t(s.to_day) : `${t(s.from_day)} – ${t(s.to_day)}`;
  };
  legs.innerHTML = `<h3 class="sugg-title">Moves your photos show</h3><p class="subtitle">Where your photos jump from one town to another far away (${list.length} times) and no flight, train, bus, ferry or ride of yours connects them: ` +
    `add how you went, or say it was no trip. Moves inside your home countries and on days with a rental car are left out.</p>` +
    groups.map((g, gi) => `<div class="sugg-group" data-group="${gi}"><h4><span>${when({ from_day: g[0].from_day, to_day: g[g.length - 1].to_day })} · ` +
      `${[...new Set(g.flatMap(s => [s.from_country, s.to_country]))].map(cc => flagOf(cc).trim()).join(' ')} · ${g.length} leg${g.length > 1 ? 's' : ''}</span>` +
      `${g.length > 1 ? '<button class="btn btn-ghost" data-none>None of these</button>' : ''}</h4>` +
      g.map(s => `<div class="sugg" data-key="${escapeHTML(s.key)}"><div class="pics"><img src="/api/photos/${s.last_photo}/thumb" alt="" loading="lazy"><img src="/api/photos/${s.first_photo}/thumb" alt="" loading="lazy"></div>` +
        `<div><b>${flagOf(s.from_country)}${escapeHTML(s.from)} → ${flagOf(s.to_country)}${escapeHTML(s.to)}</b> · ${fmtDist(s.km)}<small>${when(s)} · ` +
        `${s.hours < 48 ? `${s.hours} h between the photos` : `${Math.round(s.hours / 24)} days between the photos`} · ${s.photos[0]} and ${s.photos[1]} photos</small></div>` +
        `<div class="acts"><select aria-label="How">${[...Object.entries(MODES), ['flight', '✈️ Flight']].map(([k, v]) => `<option value="${k}" ${k === s.mode ? 'selected' : ''}>${v}</option>`).join('')}</select>` +
        `<button class="btn btn-primary" data-add-leg>Add</button><button class="btn btn-ghost" data-no title="It was no trip (a photo's place is wrong, or you went another way)">✕</button></div></div>`).join('') +
      '</div>').join('');
  const byKey = Object.fromEntries(list.map(s => [s.key, s]));
  const dismiss = row => fetch('/api/suggestions/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: row.dataset.key }) })
    .then(() => { const g = row.closest('.sugg-group'); row.remove(); if (!g.querySelector('.sugg')) g.remove(); });
  legs.querySelectorAll('[data-no]').forEach(b => b.addEventListener('click', () => dismiss(b.closest('.sugg'))));
  legs.querySelectorAll('[data-none]').forEach(b => b.addEventListener('click', () => b.closest('.sugg-group').querySelectorAll('.sugg').forEach(dismiss)));
  legs.querySelectorAll('[data-add-leg]').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('.sugg'), s = byKey[row.dataset.key], mode = row.querySelector('select').value;
    if (mode === 'flight') {  // a flight wants its number: the flight form, its date filled in
      showAddKind('flight');
      document.getElementById('in-date').value = s.to_day;
      return toast(`A flight ${s.from} → ${s.to} around ${s.to_day}: its number and date, or fill it in by hand`);
    }
    const leg = { mode, from: s.from, to: s.to, date: `${s.to_day} 12:00:00`, source: 'photos', event_id: 'photos-' + s.key,
      from_lat: s.from_lat, from_lon: s.from_lon, to_lat: s.to_lat, to_lon: s.to_lon };
    const t = await fetch('/api/ground', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(leg) }).then(r => r.json());
    allTrips.push(t);
    drawGround();
    const g = row.closest('.sugg-group');
    row.remove();
    if (!g.querySelector('.sugg')) g.remove();
    toast(`Added: ${MODES[mode]} ${s.from} → ${s.to}, ${s.to_day}`);
  }));
}

// --- trips with a place and a year, to check: albums whose photos have no places ("Saint Petersburg - 2009") and
// "trip to X" to-dos done in Things that nothing else in Cairn knows ---

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const dismissKey = key => post('/api/suggestions/dismiss', { key });

function renderAlbumSuggestions() {
  renderPlaceSuggestions({ id: 'album-suggestions', url: '/api/suggestions/albums', source: 'album', waiting: 'Reading your Google Photos albums…',
    title: 'Albums that say where you went',
    intro: n => `Google Photos albums whose photos have no places (old cameras), so they cannot show on the map, with the place and year their names give (${n}). ` +
      'Check them, say where you came from, and add the trip there and back; or ✕ when the album was no trip. Albums for a place and year your flights, trains or stays already cover are left out.',
    cover: a => `/api/suggestions/albums/cover?key=${encodeURIComponent(a.key)}`, name: a => a.album,
    detail: a => `${a.photos} photos · ${a.first ? `${fmtDate(a.first)}${a.last !== a.first ? ' – ' + fmtDate(a.last) : ''}` : 'no dates'}` +
      `${a.place && a.looked_up && a.lat == null ? ' · place not found from the name' : ''}` });
}

function renderTodoSuggestions() {
  renderPlaceSuggestions({ id: 'todo-suggestions', url: '/api/suggestions/todos', source: 'todo', waiting: 'Reading your to-dos…',
    title: 'Trips your to-dos mention',
    intro: n => `"Trip to …" to-dos you marked done in Things, where nothing in Cairn puts you near that place within about 200 days either side (${n}). ` +
      'Some were plans that did not happen: ✕ those. For the others, check the year, say where you came from, and add the trip there and back.',
    name: t => t.title, detail: t => `done in Things on ${fmtDate(t.done)}` });
}

// the rows of trips to check: a place and a year each; from where, how and back are filled in, then added as a trip
// known to the year
async function renderPlaceSuggestions(o) {
  const box = document.getElementById(o.id);
  if (!box) return;
  const list = await fetch(o.url).then(r => (r.ok ? r.json() : [])).catch(() => []);
  if (list.pending) {
    box.innerHTML = `<p class="subtitle">${o.waiting} back in a minute.</p>`;
    return setTimeout(() => { if (document.getElementById(o.id) === box) renderPlaceSuggestions(o); }, 20000);
  }
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<h3 class="sugg-title">${o.title}</h3><p class="subtitle">${o.intro(list.length)}</p>` +
    `<div class="sugg-group">${list.map(a => `<div class="sugg album" data-key="${escapeHTML(a.key)}">` +
      `<div class="pics">${o.cover ? `<img src="${o.cover(a)}" alt="" loading="lazy">` : '<span class="pic-icon">🧳</span>'}</div>` +
      `<div><b>${escapeHTML(o.name(a))}</b><small>${o.detail(a)}</small>` +
      `<div class="album-fields"><input data-f="from" placeholder="from (where you lived)" aria-label="From"><input data-f="place" value="${escapeHTML(a.place || '')}" aria-label="To">` +
      `<input data-f="year" type="number" min="1950" max="2100" value="${a.year || ''}" placeholder="year" aria-label="Year"></div></div>` +
      `<div class="acts"><select aria-label="How">${Object.entries(MODES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>` +
      `<label title="And back the same way"><input type="checkbox" data-f="back" checked> back</label>` +
      `<button class="btn btn-primary" data-add-place>Add</button><button class="btn btn-ghost" data-no-place title="It was no trip">✕</button></div></div>`).join('')}</div>`;
  const byKey = Object.fromEntries(list.map(a => [a.key, a]));
  const gone = row => { row.remove(); if (!box.querySelector('.sugg')) box.innerHTML = ''; };
  box.querySelectorAll('[data-no-place]').forEach(b => b.addEventListener('click', () => { const row = b.closest('.sugg'); dismissKey(row.dataset.key).then(() => gone(row)); }));
  box.querySelectorAll('[data-add-place]').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('.sugg'), a = byKey[row.dataset.key], f = k => row.querySelector(`[data-f="${k}"]`);
    const from = f('from').value.trim(), to = f('place').value.trim(), year = f('year').value.trim();
    if (!from || !to || !/^\d{4}$/.test(year)) return toast('From, to and the year are needed', 'error');
    const base = { mode: row.querySelector('select').value, date: `${year}-01-01 12:00:00`, approx: 'year', source: o.source, service: `${o.source}: ${o.name(a)}` };
    const there = to === a.place && a.lat != null ? { to_lat: a.lat, to_lon: a.lon } : {};
    const legs = [{ ...base, from, to, ...there, event_id: `${o.source}-` + rand() }];
    if (f('back').checked) legs.push({ ...base, from: to, to: from, ...(there.to_lat != null ? { from_lat: a.lat, from_lon: a.lon } : {}), event_id: `${o.source}-` + rand() });
    for (const leg of legs) allTrips.push(await post('/api/ground', leg));
    drawGround();
    await dismissKey(a.key);
    toast(`Added: ${from} → ${to}${legs.length > 1 ? ' and back' : ''}, ${year}`);
    gone(row);
  }));
}

// --- where the photos of an album with no place of their own are: the town its name gives, or the one you choose
// for the whole album or for some of its photos (albums.js) ---

const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const townPlace = t => ({ name: `${t.name}, ${t.cc}`, lat: t.lat, lon: t.lon });
function photosChanged() {  // the map's photos again, with the new places
  photoPointsAsked = null;
  allPhotoPoints = null;
  loadPhotoPoints();
}

async function renderAlbumPlaces(shown = 20) {
  const box = document.getElementById('album-places');
  if (!box) return;
  const list = await fetch('/api/albums').then(r => (r.ok ? r.json() : [])).catch(() => []);
  if (list.pending) {
    box.innerHTML = '<p class="subtitle">Reading your Google Photos albums… back in a minute.</p>';
    return setTimeout(() => { if (document.getElementById('album-places') === box) renderAlbumPlaces(shown); }, 20000);
  }
  if (!list.length) { box.innerHTML = ''; return; }
  // the ones without a place first, then by their number of photos
  const order = a => (a.notPlace ? 2 : a.place ? 1 : 0);
  list.sort((a, b) => order(a) - order(b) || b.loose - a.loose);
  const where = a => (a.notPlace ? '<span class="muted">not a place</span>' : a.place ? `📍 <b>${escapeHTML(a.place.name)}</b> <span class="muted">(${a.place.by === 'you' ? 'your choice' : 'from its name'})</span>`
    : '<span class="muted">no place yet</span>') + (a.own ? ` · ${a.own} photo${a.own > 1 ? 's' : ''} placed apart` : '');
  const when = a => (a.first ? `${fmtDate(a.first)}${a.last !== a.first ? ' – ' + fmtDate(a.last) : ''}` : a.year ? `${a.year}, dates unknown` : 'dates unknown');
  const todo = list.filter(a => !a.place && !a.notPlace).length;
  box.innerHTML = `<h3 class="sugg-title">Where your albums' photos are</h3><p class="subtitle">Photos in your Google Photos albums with no place of their own ` +
    `(${list.reduce((n, a) => n + a.loose, 0).toLocaleString()} in ${list.length} albums, ${todo} with no place yet). They go on the map at the town the album's name gives, ` +
    'or where you put them: the whole album, or some of its photos (Photos…). A photo whose date is only the day Google got it shows with its year and makes no day in towns or trips.</p>' +
    `<div class="sugg-group">${list.slice(0, shown).map(a => `<div class="sugg album-place" data-album="${escapeHTML(a.album)}">` +
      `<div class="pics"><img alt="" loading="lazy" data-cover></div>` +
      `<div><b>${escapeHTML(a.album)}</b><small>${a.loose} photo${a.loose > 1 ? 's' : ''} with no place · ${when(a)}</small><small>${where(a)}</small>` +
      `<div class="album-fields"><input data-town placeholder="Put it in… (a town)" aria-label="Town for the album" autocomplete="off"></div>` +
      `<div class="album-photos" hidden></div></div>` +
      `<div class="acts"><button class="btn btn-ghost" data-photos>Photos…</button>` +
      (a.notPlace ? '' : '<button class="btn btn-ghost" data-none title="Its name is no place">Not a place</button>') +
      (a.place?.by === 'you' || a.notPlace ? '<button class="btn btn-ghost" data-reset title="Back to the place its name gives">Reset</button>' : '') + '</div></div>').join('')}</div>` +
    (list.length > shown ? `<button class="btn btn-ghost sp-more" data-more>Show ${Math.min(20, list.length - shown)} more (${list.length - shown} left)</button>` : '');
  box.querySelector('[data-more]')?.addEventListener('click', () => renderAlbumPlaces(shown + 20));
  const done = msg => { toast(msg); photosChanged(); renderAlbumPlaces(shown); };
  box.querySelectorAll('.album-place').forEach(row => {
    const album = row.dataset.album;
    // its cover: the first of its photos with no place
    fetch(`/api/albums/photos?album=${encodeURIComponent(album)}`).then(r => r.json()).then(ph => {
      const img = row.querySelector('[data-cover]');
      if (ph[0]) img.src = `/api/albums/thumb?album=${encodeURIComponent(album)}&file=${encodeURIComponent(ph[0].file)}`; else img.remove();
    }).catch(() => {});
    attachTownPicker(row.querySelector('[data-town]'), { onPick: async t => {
      await put('/api/albums/place', { album, place: townPlace(t) });
      done(`${album}: in ${t.name}`);
    } });
    row.querySelector('[data-none]')?.addEventListener('click', async () => { await put('/api/albums/place', { album, place: false }); done(`${album}: not a place`); });
    row.querySelector('[data-reset]')?.addEventListener('click', async () => { await put('/api/albums/place', { album, place: null }); done(`${album}: back to its name's place`); });
    row.querySelector('[data-photos]').addEventListener('click', () => toggleAlbumPhotos(row, album, done));
  });
}

// an album's photos, to tick some and put them elsewhere (or back to the album's place)
async function toggleAlbumPhotos(row, album, done) {
  const box = row.querySelector('.album-photos');
  if (!box.hidden) { box.hidden = true; return; }
  const list = await fetch(`/api/albums/photos?album=${encodeURIComponent(album)}`).then(r => (r.ok ? r.json() : [])).catch(() => []);
  const src = f => `/api/albums/thumb?album=${encodeURIComponent(album)}&file=${encodeURIComponent(f)}`;
  box.innerHTML = `<div class="album-grid">${list.map((p, i) => `<label title="${escapeHTML(p.file)}${p.t ? ' · ' + fmtDate(new Date(p.t * 1000).toISOString()) : ''}">` +
    `<input type="checkbox" data-i="${i}"><img src="${src(p.file)}" alt="" loading="lazy">${p.place ? `<span>📍 ${escapeHTML(p.place.name.split(',')[0])}</span>` : ''}</label>`).join('')}</div>` +
    '<div class="album-fields"><input data-photo-town placeholder="Put the ticked photos in… (a town)" aria-label="Town for the ticked photos" autocomplete="off">' +
    '<button class="btn btn-ghost" data-all>Tick all</button><button class="btn btn-ghost" data-back>Back to the album\'s place</button></div>';
  box.hidden = false;
  const ticked = () => [...box.querySelectorAll('input[data-i]:checked')].map(c => list[+c.dataset.i].file);
  box.querySelector('[data-all]').addEventListener('click', () => {
    const all = box.querySelectorAll('input[data-i]'), on = [...all].some(c => !c.checked);
    all.forEach(c => { c.checked = on; });
  });
  attachTownPicker(box.querySelector('[data-photo-town]'), { onPick: async t => {
    const files = ticked();
    if (!files.length) return toast('Tick the photos first', 'error');
    await put('/api/albums/photos', { album, files, place: townPlace(t) });
    done(`${files.length} photo${files.length > 1 ? 's' : ''} of ${album}: in ${t.name}`);
  } });
  box.querySelector('[data-back]').addEventListener('click', async () => {
    const files = ticked();
    if (!files.length) return toast('Tick the photos first', 'error');
    await put('/api/albums/photos', { album, files, place: null });
    done(`${files.length} photo${files.length > 1 ? 's' : ''} of ${album}: back to the album's place`);
  });
}

// --- payments abroad (your bank's) on days nothing else in Cairn puts you in that country ---

async function renderPaymentSuggestions() {
  const box = document.getElementById('payment-suggestions');
  const list = await fetch('/api/suggestions/payments').then(r => (r.ok ? r.json() : [])).catch(() => []);
  if (!box || !list.length) { if (box) box.innerHTML = ''; return; }
  const names = new Intl.DisplayNames(['en'], { type: 'region' }), country = cc => { try { return names.of(cc); } catch (_) { return cc; } };
  const when = r => (r.first === r.last ? fmtDate(r.first) : `${fmtDate(r.first)} – ${fmtDate(r.last)}`);
  box.innerHTML = `<h3 class="sugg-title">Payments abroad no trip explains</h3><p class="subtitle">Card payments and cash from your bank in a country ` +
    `where nothing else in Cairn puts you on those days (${list.length}). Add the trip (✈️ or 🚆 above), or ✕ when it was a purchase online.</p>` +
    `<div class="sugg-group">${list.map(r => `<div class="sugg" data-key="${escapeHTML(r.key)}"><div class="pics"><span class="pic-icon">${flagOf(r.country).trim() || '💳'}</span></div>` +
      `<div><b>${escapeHTML(country(r.country))}</b> · ${when(r)}<small>${r.payments} payment${r.payments > 1 ? 's' : ''}: ` +
      `${Object.entries(r.amounts).map(([c, v]) => `${v.toLocaleString()} ${c}`).join(', ')} · ${escapeHTML(r.examples.join('; '))}</small></div>` +
      '<div class="acts"><button class="btn btn-ghost" data-no-pay title="No trip: online, or already known">✕</button></div></div>').join('')}</div>`;
  box.querySelectorAll('[data-no-pay]').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('.sugg');
    await dismissKey(row.dataset.key);
    row.remove();
    if (!box.querySelector('.sugg')) box.innerHTML = '';
  }));
}

// --- gaps: trips abroad with no way there or back, and long runs of days with no place ---

async function renderGapSuggestions() {
  const box = document.getElementById('gap-suggestions');
  const d = await fetch('/api/suggestions/gaps').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!box || !d || (!d.unreached.length && !d.quiet.length)) { if (box) box.innerHTML = ''; return; }
  const range = (a, b) => (a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`), no = '<div class="acts"><button class="btn btn-ghost" data-no-gap title="Nothing to add">✕</button></div>';
  const miss = t => [!t.there && 'there', !t.back && 'back'].filter(Boolean).join(' or ');
  let html = '';
  if (d.unreached.length) {
    html += `<h3 class="sugg-title">Trips with no way there or back</h3><p class="subtitle">Trips abroad with no flight, train, bus, ferry, ride or rental car ` +
      `around their first or last day (${d.unreached.length}). Add how you went (✈️ or 🚆 above), or ✕ when there is nothing to add (a lift, your own car).</p>` +
      `<div class="sugg-group">${d.unreached.map(t => `<div class="sugg" data-key="${escapeHTML(t.key)}"><div class="pics"><span class="pic-icon">🧭</span></div>` +
        `<div><b>${tripLink(t)}</b> · ${range(t.start, t.end)}<small>${t.days} day${t.days !== 1 ? 's' : ''} · nothing on the way ${miss(t)}</small></div>${no}</div>`).join('')}</div>`;
  }
  if (d.quiet.length) {
    html += `<h3 class="sugg-title">Quiet stretches</h3><p class="subtitle">Runs of a month or more where nothing in Cairn has a place for you (${d.quiet.length}): ` +
      `photos, Timeline or a trip may be missing. ✕ when you were home.</p>` +
      `<div class="sugg-group">${d.quiet.map(g => `<div class="sugg" data-key="${escapeHTML(g.key)}"><div class="pics"><span class="pic-icon">🕳️</span></div>` +
        `<div><b>${g.days.toLocaleString()} days</b> · ${range(g.first, g.last)}</div>${no}</div>`).join('')}</div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('[data-no-gap]').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('.sugg'), group = row.parentNode;
    await dismissKey(row.dataset.key);
    row.remove();
    if (!group.querySelector('.sugg')) { group.previousElementSibling?.remove(); group.previousElementSibling?.remove(); group.remove(); }
  }));
}

// --- trains, buses and ferries your trip docs list that are not on the map: their day is known ---

async function renderTripdocSuggestions() {
  const box = document.getElementById('tripdoc-suggestions');
  const list = await fetch('/api/suggestions/tripdocs').then(r => (r.ok ? r.json() : [])).catch(() => []);
  if (!box || !list.length) { if (box) box.innerHTML = ''; return; }
  box.innerHTML = `<h3 class="sugg-title">Trains, buses and ferries in your trip docs</h3><p class="subtitle">Rows of the Transport tables of your trip docs ` +
    `that are not on the map (${list.length}). Many were plans ("plan", "implied", "only info", "no date given"): ✕ those, Add the ones you took.</p>` +
    `<div class="sugg-group">${list.map(r => `<div class="sugg" data-key="${escapeHTML(r.key)}"><div class="pics"><span class="pic-icon">${(MODES[r.mode] || '🚌').split(' ')[0]}</span></div>` +
      `<div><b>${escapeHTML(r.from)} → ${escapeHTML(r.to)}</b><small>${fmtDate(r.date)} · ${escapeHTML(r.doc)}${r.note ? ` · ${escapeHTML(r.note)}` : ''}</small></div>` +
      `<div class="acts"><select aria-label="How">${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${k === r.mode ? 'selected' : ''}>${v}</option>`).join('')}</select>` +
      `<button class="btn btn-primary" data-add-row>Add</button><button class="btn btn-ghost" data-no-row title="Not taken">✕</button></div></div>`).join('')}</div>`;
  const byKey = Object.fromEntries(list.map(r => [r.key, r]));
  const gone = row => { row.remove(); if (!box.querySelector('.sugg')) box.innerHTML = ''; };
  box.querySelectorAll('[data-no-row]').forEach(b => b.addEventListener('click', () => { const row = b.closest('.sugg'); dismissKey(row.dataset.key).then(() => gone(row)); }));
  box.querySelectorAll('[data-add-row]').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('.sugg'), r = byKey[row.dataset.key];
    allTrips.push(await post('/api/ground', { mode: row.querySelector('select').value, from: r.from, to: r.to, date: `${r.date} 12:00:00`, source: 'trip doc', event_id: r.key }));
    drawGround();
    await dismissKey(r.key);
    toast(`Added: ${r.from} → ${r.to}, ${r.date}`);
    gone(row);
  }));
}

// --- data health: what looks wrong, each with its fix (or "fine as it is") ---

const HEALTH_PAGE = 25;
async function renderHealth() {
  const box = document.getElementById('add-other');
  const d = await fetch('/api/health').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!d) { box.innerHTML = '<p class="subtitle">Could not check.</p>'; return; }
  const stayCard = st => `<div class="health-stay"><b>${escapeHTML(st.hotel || st.place || '')}</b><small>${escapeHTML(st.place || '')} · ${tripRange(st.start, st.end)} · ` +
    `${escapeHTML(st.provider || '')} (${escapeHTML(st.source)})</small><button class="btn btn-ghost" data-keep="${st.id}">Keep this one</button></div>`;
  const fine = key => `<button class="btn btn-ghost" data-fine="${escapeHTML(key)}" title="Fine as it is">Fine</button>`;
  let html = '<p class="subtitle">What looks wrong in your data, each with a fix. "Fine" sets it aside for good.</p>';
  if (d.copies) html += `<div class="sugg-group"><h4><span>🏨 ${d.copies} stays are copies of another (the same nights and place, from two sources)</span>` +
    `<button class="btn btn-primary" data-dedupe>Remove the copies</button></h4><small class="sp-note">The one that knows most is kept: its position, the hotel, the price. The others are deleted and do not come back.</small></div>`;
  if (d.twice.length) html += `<h3 class="sugg-title">Stays booked for the same nights (${d.twice.length})</h3><p class="subtitle">One was often cancelled, or a plan. Keep the one you slept in; "Fine" when both are right (two rooms, moving on the same day).</p>` +
    `<div class="sugg-group">${d.twice.slice(0, HEALTH_PAGE).map(x => `<div class="health-pair" data-key="${escapeHTML(x.key)}" data-ids="${x.stays.map(s => s.id).join(',')}">` +
      `<span>${x.nights} night${x.nights > 1 ? 's' : ''}</span>${x.stays.map(stayCard).join('')}${fine(x.key)}</div>`).join('')}` +
      (d.twice.length > HEALTH_PAGE ? `<small class="sp-note">… and ${d.twice.length - HEALTH_PAGE} more after these.</small>` : '') + '</div>';
  if (d.unplaced.length) html += `<h3 class="sugg-title">Not on the map: no place found (${d.unplaced.length})</h3><div class="sugg-group">${d.unplaced.map(x =>
    `<div class="sugg" data-key="health|unplaced|${x.kind}|${x.id}" data-kind="${x.kind}" data-id="${x.id}"><div class="pics"><span class="pic-icon">${x.kind === 'stay' ? '🏨' : '🚌'}</span></div>` +
    `<div><b>${escapeHTML(x.text)}</b><small>${fmtDate((x.date || '').slice(0, 10))}</small><div class="album-fields">` +
    (x.kind === 'stay' ? `<input data-f="place" value="${escapeHTML(x.place || '')}" aria-label="Place">` :
      `<input data-f="from" value="${escapeHTML(x.from)}" aria-label="From"><input data-f="to" value="${escapeHTML(x.to)}" aria-label="To">`) + '</div></div>' +
    `<div class="acts"><button class="btn btn-primary" data-rename>Look up</button>${fine(`health|unplaced|${x.kind}|${x.id}`)}</div></div>`).join('')}</div>`;
  if (d.straight.length) html += `<h3 class="sugg-title">Drawn as a straight line (${d.straight.length})</h3><div class="sugg-group">${d.straight.map(x =>
    `<div class="sugg" data-key="health|straight|${x.id}" data-id="${x.id}"><div class="pics"><span class="pic-icon">${(MODES[x.mode] || '🚌').split(' ')[0]}</span></div>` +
    `<div><b>${escapeHTML(x.from)} → ${escapeHTML(x.to)}</b><small>${fmtDate(x.date.slice(0, 10))} · no track found yet</small></div>` +
    `<div class="acts"><button class="btn btn-primary" data-retry>Look up again</button>${fine(`health|straight|${x.id}`)}</div></div>`).join('')}</div>`;
  if (d.flights.length) html += `<h3 class="sugg-title">Flights without their airline's code (${d.flights.length})</h3><p class="subtitle">"151" instead of "S4151": check-in to-dos and other lists name flights with the code.</p>` +
    `<div class="sugg-group">${d.flights.slice(0, HEALTH_PAGE).map(f => `<div class="sugg" data-key="health|flight|${f.id}" data-id="${f.id}"><div class="pics"><span class="pic-icon">✈️</span></div>` +
      `<div><b>${escapeHTML(f.from)} → ${escapeHTML(f.to)}</b><small>${fmtDate(f.date.slice(0, 10))} · ${escapeHTML(f.airline || 'airline not known')}</small>` +
      `<div class="album-fields"><input data-f="number" value="${escapeHTML(f.flight_number)}" placeholder="e.g. KL1234" aria-label="Flight number"></div></div>` +
      `<div class="acts"><button class="btn btn-primary" data-flight>Save</button>${fine(`health|flight|${f.id}`)}</div></div>`).join('')}` +
      (d.flights.length > HEALTH_PAGE ? `<small class="sp-note">… and ${d.flights.length - HEALTH_PAGE} more after these.</small>` : '') + '</div>';
  if (!d.copies && !d.twice.length && !d.unplaced.length && !d.straight.length && !d.flights.length) html += '<p class="subtitle">Nothing looks wrong. 🎉</p>';
  box.innerHTML = html;
  const gone = el => { el.remove(); };
  const put = (url, body, method = 'PUT') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
  box.querySelectorAll('[data-fine]').forEach(b => b.addEventListener('click', () => dismissKey(b.dataset.fine).then(() => gone(b.closest('[data-key]')))));
  box.querySelector('[data-dedupe]')?.addEventListener('click', async e => {
    if (!confirm(`Remove ${d.copies} stays that copy another one?`)) return;
    const r = await post('/api/health/dedupe', {});
    toast(`Removed ${r.removed} copies`);
    allStays = await fetch('/api/stays').then(x => x.json());
    renderHealth();
  });
  box.querySelectorAll('[data-keep]').forEach(b => b.addEventListener('click', async () => {
    const pair = b.closest('[data-ids]'), keep = b.dataset.keep, other = pair.dataset.ids.split(',').find(id => id !== keep);
    if (!confirm('Delete the other stay?')) return;
    await put(`/api/stays/${other}`, null, 'DELETE');
    allStays = allStays.filter(s => String(s.id) !== other);
    gone(pair);
  }));
  box.querySelectorAll('[data-rename]').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('[data-id]'), f = k => row.querySelector(`[data-f="${k}"]`)?.value.trim();
    if (row.dataset.kind === 'stay') { await put(`/api/stays/${row.dataset.id}`, { place: f('place'), unplaced: false }); await post(`/api/stays/${row.dataset.id}/retry`, {}); }
    else { await put(`/api/ground/${row.dataset.id}`, { from: f('from'), to: f('to'), unplaced: false }); await post(`/api/ground/${row.dataset.id}/retry`, {}); }
    toast('Looking it up again: on the map in a minute');
    gone(row);
  }));
  box.querySelectorAll('[data-retry]').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('[data-id]');
    await post(`/api/ground/${row.dataset.id}/retry`, {});
    toast('Looking it up again: on the map in a minute');
    gone(row);
  }));
  box.querySelectorAll('[data-flight]').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('[data-id]'), n = row.querySelector('[data-f="number"]').value.trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9]{2}\d{1,4}$/.test(n)) return toast('A flight number with its airline code, e.g. KL1234', 'error');
    await put(`/api/flights/${row.dataset.id}`, { flight_number: n });
    gone(row);
  }));
}

window.addEventListener('load', () => {
  document.querySelectorAll('.add-kinds [data-add]').forEach(b => b.addEventListener('click', () => showAddKind(b.dataset.add)));
});
