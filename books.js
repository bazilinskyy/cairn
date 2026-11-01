'use strict';
// What you read (Goodreads): the books of your library export (My Books → Import and export → Export library), kept
// in data/books.json; Cairn places each where you were the day you finished it. The export has the day you finished a
// book ("Date Read"), not the day you started it, nor the earlier times of a book read again.

const fs = require('fs');

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
  const [head, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  const col = name => (head || []).indexOf(name);
  if (col('Title') < 0 || col('Date Read') < 0 || col('Exclusive Shelf') < 0) throw new Error('not a Goodreads library export (no Title, Date Read or Exclusive Shelf column)');
  const get = (r, name) => (col(name) < 0 ? '' : (r[col(name)] || '').trim());
  return rows.filter(r => get(r, 'Exclusive Shelf') === 'read').map(r => ({
    id: get(r, 'Book Id'), title: get(r, 'Title'), author: get(r, 'Author'), rating: Number(get(r, 'My Rating')) || 0,
    pages: Number(get(r, 'Number of Pages')) || null, year: Number(get(r, 'Original Publication Year') || get(r, 'Year Published')) || null,
    finished: dayOf(get(r, 'Date Read')), added: dayOf(get(r, 'Date Added')), read_count: Number(get(r, 'Read Count')) || 1
  })).filter(b => b.title);
}

function create({ file, log = console.log }) {
  let data = null;
  const load = () => {
    if (!data) { try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { data = { books: [] }; } }
    return data;
  };
  // a new export replaces the books of the last one (it holds them all)
  function importExport(text) {
    const books = fromExport(text);
    data = { books, imported: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(data));
    log(`[books] ${books.length} books read, ${books.filter(b => b.finished).length} with the day finished`);
    return status();
  }
  const status = () => { const d = load(); return { books: d.books.length, dated: d.books.filter(b => b.finished).length, imported: d.imported || '' }; };
  return { list: () => load().books, importExport, status };
}

module.exports = { create, parseCsv, fromExport };
