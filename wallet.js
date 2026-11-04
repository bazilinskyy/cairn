'use strict';
// Your Apple Wallet passes: boarding passes, train and bus tickets, and tickets to concerts, cinemas, museums and
// events. Read straight from this Mac, read-only: Wallet keeps every pass, the expired ones too, synced through iCloud
// in ~/Library/Passes/Cards, a folder per pass. Also the .pkpass files given in the settings (data/wallet/), for passes
// on a phone this Mac does not share a Wallet with. wallet_dir in config: "auto" (this Mac's), a folder, or "" for none.
//
// A boarding pass's barcode is IATA's (BCBP): the route, the flight, the seat and the booking code, the same for every
// airline; the day is a day of the year, its year from the pass's dates (a few have none: matched to the flight
// Cairn has on that day of any year).
// Train, bus and event passes are each airline's or company's own: their fields are read as well as they go.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { unzip } = require('./books');

const AUTO = path.join(os.homedir(), 'Library/Passes/Cards');
const FIELDS = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields'];
const TRAIN = /sncf|renfe|trainose|rail|bahn|\bdb\b|\bns\b|trenitalia|ouigo|eurostar|öbb|sbb|intercity|train|залізниц/i;

// pass.json as it comes: UTF-8 mostly, some UTF-16 or Latin-1, some with commas before a closing bracket
function readJson(buf) {
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le', 2) : buf.length > 1 && buf[1] === 0 ? buf.toString('utf16le')
    : (s => (s.includes('\ufffd') ? buf.toString('latin1') : s))(buf.toString('utf8'));
  const clean = text.replace(/^\ufeff/, '');
  try { return JSON.parse(clean); } catch (_) { return JSON.parse(clean.replace(/,\s*([}\]])/g, '$1')); }
}

// A boarding pass's barcode (IATA BCBP, its first leg): { name, booking, from, to, flight_number, julian, cabin, seat }
function bcbp(msg) {
  const m = /^M\d(.{20})[E ](.{7})([A-Z]{3})([A-Z]{3})(.{3})(.{5})(\d{3})(.)(.{4})/.exec(msg || '');
  if (!m) return null;
  const seat = m[9].trim().replace(/^0+/, '');
  return { name: m[1].trim(), booking: m[2].trim(), from: m[3], to: m[4], flight_number: `${m[5].trim()}${m[6].trim().replace(/^0+(?=\d)/, '')}`,
    julian: Number(m[7]), cabin: m[8].trim(), seat: /^\d{1,3}[A-Z]$/.test(seat) ? seat : '' };
}
// the cabin's letter as Cairn's class (OpenFlights': F first, C business, Y economy)
const classOf = c => (/[FA]/.test(c) ? 'F' : /[JCDIZ]/.test(c) ? 'C' : c ? 'Y' : '');

// "2019-05-01T08:51:22+02:00" -> "2019-05-01 08:51" (the time where it was, as written)
const isoLocal = s => { const m = /^(\d{4}-\d\d-\d\d)(?:[T ](\d\d:\d\d))?/.exec(s || ''); return m ? (m[2] ? `${m[1]} ${m[2]}` : m[1]) : ''; };
// a day written out in a field: 27/03/2017, 11.10.2019, 2024-05-28
function textDay(s) {
  let m = /\b(\d{4})-(\d\d)-(\d\d)\b/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/.exec(s);
  return m && +m[2] <= 12 ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

// a place's name from a field: the value, or the label when the value is a time, a date or a station's code
// ("ZARAG-MIRA": "08:55", "Athens": "ΑΘΗΝ"); names cut short lose their open bracket
function placeName(f) {
  const junk = v => !v || /^\d{1,2}:\d\d|^\d{4}-\d\d-\d\d|_/.test(v) || /^(from|to|departure|arrival|origin|destination)$/i.test(v);
  const code = v => /^[A-ZÀ-ÖØ-ÞΑ-ΩА-Я]{2,4}$/.test(v);
  const v = String(f?.value ?? '').trim(), l = String(f?.label ?? '').trim();
  const name = !junk(v) && !(code(v) && !junk(l)) ? v : !junk(l) ? l : '';
  const tidy = name.replace(/[-\s]+$/, '').replace(/\s*\([^)]*$/, '').trim();
  return tidy === tidy.toUpperCase() ? tidy.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : tidy;
}

// pass.json as Cairn's pass: { id, kind (flight, train, bus, ferry, event), org, date ("YYYY-MM-DD HH:MM" or a day, ""
// when only a boarding pass's day of the year is known), julian, from, to, flight_number, seat, class, booking,
// passenger, title, venue, at }
function parse(d, { id } = {}) {
  const body = d.boardingPass || d.eventTicket;
  if (!body || d.voided) return null;
  const fields = FIELDS.flatMap(k => (body[k] || []).map(f => ({ ...f, at: k })));
  const byKey = re => fields.find(f => re.test(f.key || ''));
  const values = fields.map(f => String(f.value ?? ''));
  // when: a field's own time where it was, before relevantDate (sometimes in UTC), before a day written out
  const iso = values.find(v => /^\d{4}-\d\d-\d\dT\d\d:\d\d.*[+-]\d\d:?\d\d$/.test(v));
  const date = iso ? isoLocal(iso) : d.relevantDate ? isoLocal(d.relevantDate)
    : values.map(textDay).find(Boolean) || (d.expirationDate ? isoLocal(d.expirationDate).slice(0, 10) : '');
  const who = byKey(/passenger|pasajero|attendee|^name$|lastname|nom$/i);
  const out = { id, org: d.organizationName || '', date, passenger: who ? String(who.value || '').trim() : '' };
  if (d.eventTicket) {
    const title = fields.find(f => /event|title|film|show|performance/i.test(f.key || '') && !/date|time|type/i.test(f.key) && f.value && !textDay(String(f.value)));
    const venue = byKey(/venue|location|lokatie|place|where/i);
    const loc = (d.locations || [])[0];
    return { ...out, kind: 'event', title: String(title?.value || d.description || d.organizationName || 'Ticket').trim(),
      venue: venue ? String(venue.value || '').split('\n')[0].trim() : '', at: loc && Number.isFinite(loc.latitude) ? [loc.latitude, loc.longitude] : null };
  }
  const type = body.transitType || '';
  const msg = (d.barcode || (d.barcodes || [])[0] || {}).message || '';
  if (type === 'PKTransitTypeAir') {
    const b = bcbp(msg);
    if (!b) return null;
    return { ...out, kind: 'flight', date: date && Math.abs(Date.parse(date.slice(0, 10)) - dayOfYear(date.slice(0, 4), b.julian)) <= 2 * 864e5 ? date : '',
      julian: b.julian, from: b.from, to: b.to, flight_number: b.flight_number, seat: b.seat, class: classOf(b.cabin), booking: b.booking, passenger: b.name };
  }
  const kind = type === 'PKTransitTypeTrain' ? 'train' : type === 'PKTransitTypeBus' ? 'bus' : type === 'PKTransitTypeBoat' ? 'ferry'
    : TRAIN.test(d.organizationName || '') ? 'train' : 'bus';
  let from = placeName(byKey(/departure_station/)), to = placeName(byKey(/arrival_station/));
  if (!from || !to) {
    const [a, b] = body.primaryFields || [];
    from = placeName(a); to = placeName(b);
  }
  if ((!from || !to) && / - /.test(d.organizationName || '')) [from, to] = d.organizationName.split(' - ').map(s => s.trim());
  return from && to && from !== to ? { ...out, kind, from, to } : null;
}
const dayOfYear = (year, n) => Date.UTC(+year, 0, 1) + (n - 1) * 864e5;

// the pass's day; "" for a boarding pass with only its day of the year (julian): when it came into this Mac's Wallet is
// when iCloud brought it, not when you got it, so its year is left to the flights it matches
const dayOf = p => (p.date ? p.date.slice(0, 10) : '');

// whether the pass is yours: no readable name on it, no names in config, or each word of its name begins one of your
// names' words or is begun by one, initials aside ("DOE/JANEMRS", "J.DOE" for "Jane Doe"; not "DOE/JOHN")
const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR', 'MSTR']);
const nameWords = s => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().split(/[^A-Z]+/).filter(w => w && !TITLES.has(w));
function yours(p, names) {
  const words = /[_\d]/.test(p.passenger || '') ? [] : nameWords(p.passenger || '').filter(w => w.length > 2);
  if (!words.length || !names.length) return true;
  return names.some(n => { const mine = nameWords(n).filter(w => w.length > 1); return words.every(w => mine.some(m => w.startsWith(m) || m.startsWith(w))); });
}

function create({ dir = () => 'auto', uploads, names = () => [], log = console.log }) {
  const folder = () => { const v = dir(); return v === 'auto' ? AUTO : v ? v.replace(/^~/, os.homedir()) : ''; };
  // [{ name, path, kind: 'folder' (an unpacked pass) | 'file' (a .pkpass) }] in both places, and their last change
  function entries() {
    const out = [];
    const scan = (where, kind) => {
      try {
        fs.readdirSync(where).filter(n => /\.pkpass$/i.test(n)).forEach(n => {
          const p = path.join(where, n), st = fs.statSync(p);
          out.push({ name: n, path: p, kind: st.isDirectory() ? 'folder' : 'file', mtime: st.mtimeMs });
        });
      } catch (_) {}
    };
    const f = folder();
    if (f) scan(f, 'folder');
    if (uploads) scan(uploads, 'file');
    return out;
  }
  let memo = { key: '', list: [] };
  function list() {
    const all = entries(), key = all.length + '|' + all.reduce((m, e) => Math.max(m, e.mtime), 0) + '|' + names().join(',');
    if (memo.key === key) return memo.list;
    const out = [], seen = new Set();
    let bad = 0;
    for (const e of all) {
      try {
        const buf = e.kind === 'folder' ? fs.readFileSync(path.join(e.path, 'pass.json')) : unzip(fs.readFileSync(e.path))['pass.json'];
        if (!buf) continue;
        const d = readJson(buf), id = `${d.passTypeIdentifier || ''}|${d.serialNumber || e.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const p = parse(d, { id });
        if (!p) continue;
        p.day = dayOf(p);
        p.yours = yours(p, names());
        if (p.day || p.julian) out.push(p);
      } catch (err) { bad++; }
    }
    if (bad) log(`[wallet] ${bad} pass${bad > 1 ? 'es' : ''} not readable`);
    memo = { key, list: out.sort((a, b) => b.day.localeCompare(a.day) || a.julian - b.julian) };
    return memo.list;
  }
  // a .pkpass given in the settings, kept in data/wallet/ under its own name
  function keep(file) {
    const buf = fs.readFileSync(file), pass = unzip(buf)['pass.json'];
    if (!pass) throw new Error(`${path.basename(file)}: not a Wallet pass`);
    const d = readJson(pass);
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, `${String(d.serialNumber || path.basename(file, '.pkpass')).replace(/[^\w.-]+/g, '_').slice(0, 80)}.pkpass`), buf);
    return d;
  }
  return { list, keep, folder, available: () => !!folder() && fs.existsSync(folder()) };
}

module.exports = { create, parse, bcbp, readJson, dayOf, dayOfYear, yours };
