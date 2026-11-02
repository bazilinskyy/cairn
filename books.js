'use strict';
// What you read (Goodreads): the books of your library export (My Books → Import and export → Export library) or of
// your data download (Account settings → Download your data: a zip), kept in data/books.json; Cairn places each where
// you were the day you finished it. The library export has the day you finished a book ("Date Read") with its author
// and pages; the data download has the days you started and finished each time you read it, but no authors nor pages.
// Each keeps what the other gave before.

const fs = require('fs');
const zlib = require('zlib');

// RFC 4180: fields in double quotes may hold commas, line breaks and doubled quotes
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f !== ''));
}

// "2021/06/14" -> "2021-06-14"; anything else (empty, a year alone) -> ''
const dayOf = s => { const m = /^(\d{4})[/-](\d\d?)[/-](\d\d?)$/.exec((s || '').trim()); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };

// The books on your read shelf, from the export's text: { id, title, author, rating, pages, year, finished, added, read_count }
function fromExport(text) {
  const [head, ...rows] = parseCsv(text.replace(/^\uFEFF/, ''));
  const col = name => (head || []).indexOf(name);
  if (col('Title') < 0 || col('Date Read') < 0 || col('Exclusive Shelf') < 0) throw new Error('not a Goodreads library export (no Title, Date Read or Exclusive Shelf column)');
  const get = (r, name) => (col(name) < 0 ? '' : (r[col(name)] || '').trim());
  return rows.filter(r => get(r, 'Exclusive Shelf') === 'read').map(r => ({
    id: get(r, 'Book Id'), title: get(r, 'Title'), author: get(r, 'Author'), rating: Number(get(r, 'My Rating')) || 0,
    pages: Number(get(r, 'Number of Pages')) || null, year: Number(get(r, 'Original Publication Year') || get(r, 'Year Published')) || null,
    finished: dayOf(get(r, 'Date Read')), added: dayOf(get(r, 'Date Added')), read_count: Number(get(r, 'Read Count')) || 1
  })).filter(b => b.title);
}

// A zip's files, { name: Buffer }: stored or deflated, found through its central directory
function unzip(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip');
  const files = {};
  for (let i = 0, at = buf.readUInt32LE(end + 16); i < buf.readUInt16LE(end + 10); i++) {
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), n = buf.readUInt16LE(at + 28);
    const name = buf.toString('utf8', at + 46, at + 46 + n), local = buf.readUInt32LE(at + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), data = buf.subarray(start, start + size);
    if (!name.endsWith('/')) files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    at += 46 + n + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return files;
}

// The books on your read shelf, from the data download (a zip of zips of JSON files, each a list after a note on what
// it holds): shelvings for the shelf and the day added, reviews for your stars, reading_sessions for the days
function fromDataDownload(buf) {
  const files = {};
  const walk = b => Object.entries(unzip(b)).forEach(([name, data]) => (/\.zip$/i.test(name) ? walk(data) : (files[name.split('/').pop()] = data)));
  walk(buf);
  const records = name => (files[`${name}.json`] ? JSON.parse(files[`${name}.json`].toString('utf8')) : [])
    .flatMap(x => (x.explanation ? [] : Array.isArray(x[name]) ? x[name] : [x]));
  const shelved = records('shelvings'), sessions = records('reading_sessions'), reviews = records('reviews');
  if (!shelved.length && !sessions.length) throw new Error('not a Goodreads data download (no shelvings or reading_sessions)');
  const day = s => dayOf((s || '').slice(0, 10).replace(/-/g, '/'));  // "2020-01-31 00:00:00 UTC"; "(not provided)" is ''
  const stars = new Map(reviews.map(r => [r.book, Math.round(Number(r.rating)) || 0]));
  const added = new Map(shelved.map(s => [s.book, day(s.created_at)]));
  const reads = new Map(shelved.filter(s => s.read_status === 'read').map(s => [s.book, []]));
  for (const s of sessions) reads.get(s.book)?.push({ started: day(s.started_at), finished: day(s.ended_at) });
  return [...reads].map(([title, times]) => {
    times.sort((a, b) => (a.finished || a.started).localeCompare(b.finished || b.started));
    const last = [...times].reverse().find(t => t.finished) || times[times.length - 1] || {};
    return { id: '', title, author: '', rating: stars.get(title) || 0, pages: null, year: null, finished: last.finished || '', started: last.started || '',
      added: added.get(title) || '', read_count: Math.max(1, times.length), reads: times.filter(t => t.started || t.finished) };
  }).filter(b => b.title);
}

// what the other kind of file gave before, by the book's title: authors and pages, or the days you started
const KEPT = ['id', 'author', 'pages', 'year', 'finished', 'started', 'reads'];
const titleKey = t => (t || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
function keepWhatWasKnown(books, before) {
  const old = new Map(before.map(b => [titleKey(b.title), b]));
  return books.map(b => {
    const o = old.get(titleKey(b.title)), m = { ...b };
    if (o) KEPT.forEach(k => { if ((m[k] == null || m[k] === '' || (Array.isArray(m[k]) && !m[k].length)) && o[k] != null) m[k] = o[k]; });
    return m;
  });
}

function create({ file, log = console.log }) {
  let data = null;
  const load = () => {
    if (!data) { try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { data = { books: [] }; } }
    return data;
  };
  // a new export or data download replaces the books of the last one (it holds them all), keeping what only the other
  // kind knew; a zip is the data download, else the library export's CSV
  function importExport(content) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8');
    const read = buf.length > 3 && buf.readUInt32LE(0) === 0x04034b50 ? fromDataDownload(buf) : fromExport(buf.toString('utf8'));
    const books = keepWhatWasKnown(read, load().books);
    data = { books, imported: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(data));
    log(`[books] ${books.length} books read, ${books.filter(b => b.finished).length} with the day finished, ${books.filter(b => b.started).length} started`);
    return status();
  }
  const status = () => { const d = load(); return { books: d.books.length, dated: d.books.filter(b => b.finished).length, imported: d.imported || '' }; };
  return { list: () => load().books, importExport, status };
}

module.exports = { create, parseCsv, fromExport, fromDataDownload, unzip };
