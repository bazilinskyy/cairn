'use strict';
// The Add tab beyond flights: a train, bus or ferry, or a stay, entered by hand, with the date as well as you remember
// it (a day, a month or only a year; a trip taken many times as one entry), and the journeys your photos show but
// nothing else does, to add with a click. Uses the page's globals (allTrips, allStays, drawGround, drawStays, toast).

let addKind = 'flight';
const rand = () => Math.random().toString(36).slice(2, 10);
const MODES = { train: '🚆 Train', bus: '🚌 Bus', ferry: '⛴️ Ferry' };

function showAddKind(kind) {
  addKind = kind;
  document.querySelectorAll('.add-kinds [data-add]').forEach(b => b.className = `btn ${b.dataset.add === kind ? 'btn-primary' : 'btn-ghost'}`);
  document.getElementById('add-flight').hidden = kind !== 'flight';
  document.querySelector('.add-page').classList.toggle('wide', kind === 'suggest');
  const box = document.getElementById('add-other');
  box.innerHTML = kind === 'ground' ? groundForm() : kind === 'stay' ? stayForm() : kind === 'suggest' ? '<p class="subtitle">Looking at your photos…</p>' : '';
  if (kind === 'ground') hookGroundForm();
  if (kind === 'stay') hookStayForm();
  if (kind === 'suggest') renderSuggestions();
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
  return `<div class="form-step"><h3>A train, bus or ferry</h3>` +
    `<div class="form-row">${field('How', `<select id="g-mode">${Object.entries(MODES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`, 'flex:0 0 150px')}` +
    field('From', '<input id="g-from" placeholder="Chernihiv" autocomplete="off">') + field('To', '<input id="g-to" placeholder="Simferopol" autocomplete="off">') + '</div>' +
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
  if (!list.length) { box.innerHTML = '<p class="subtitle">Nothing to suggest: every move your photos show is already connected.</p>'; return; }
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
  box.innerHTML = `<p class="subtitle">Where your photos jump from one town to another far away (${list.length} times) and no flight, train, bus, ferry or ride of yours connects them: ` +
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
  box.querySelectorAll('[data-no]').forEach(b => b.addEventListener('click', () => dismiss(b.closest('.sugg'))));
  box.querySelectorAll('[data-none]').forEach(b => b.addEventListener('click', () => b.closest('.sugg-group').querySelectorAll('.sugg').forEach(dismiss)));
  box.querySelectorAll('[data-add-leg]').forEach(b => b.addEventListener('click', async () => {
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

window.addEventListener('load', () => {
  document.querySelectorAll('.add-kinds [data-add]').forEach(b => b.addEventListener('click', () => showAddKind(b.dataset.add)));
});
