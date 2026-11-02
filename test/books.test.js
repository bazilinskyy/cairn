'use strict';
// Books (books.js): the Goodreads library export read in; made-up books.

const { test } = require('node:test');
const assert = require('node:assert');
const books = require('../books');

const HEAD = 'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,' +
  'Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies';

test('quoted fields hold commas, quotes and line breaks', () => {
  assert.deepStrictEqual(books.parseCsv('a,"b, c","say ""hi""\nthere"\r\nd,,e\n'), [['a', 'b, c', 'say "hi"\nthere'], ['d', '', 'e']]);
});

test('the read shelf, with the day each was finished; not the books to read', () => {
  const csv = '﻿' + [HEAD,
    '1,"The Long Walk, Again",Ann Example,"Example, Ann",,"=""123""","=""978123""",5,4.1,Pub,Paperback,320,2001,1999,2021/06/14,2023/07/01,,,read,"A review\nover two lines",,,1,0',
    '2,Unfinished Business,Bo Sample,"Sample, Bo",,,,0,3.9,Pub,Hardcover,,2010,2010,,2020/01/02,,,read,,,,1,0',
    '3,Someday,Cy Test,"Test, Cy",,,,0,4.0,Pub,Kindle,200,2015,2015,,2024/05/05,to-read,to-read (#1),to-read,,,,0,0'].join('\n');
  const list = books.fromExport(csv);
  assert.deepStrictEqual(list.map(b => [b.title, b.author, b.rating, b.pages, b.year, b.finished]),
    [['The Long Walk, Again', 'Ann Example', 5, 320, 1999, '2021-06-14'], ['Unfinished Business', 'Bo Sample', 0, null, 2010, '']]);
});

test('another file is refused', () => {
  assert.throws(() => books.fromExport('Name,Date\nx,2020-01-01\n'), /not a Goodreads library export/);
});

// a zip of these files ({ name: Buffer or text }), deflated; no checksums (unzip does not check them)
function zip(files) {
  const local = [], central = [];
  let at = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content), data = require('zlib').deflateRawSync(raw), n = Buffer.from(name);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(8, 8); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(8, 10); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(at, 42);
    local.push(head, n, data); central.push(dir, n);
    at += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...local, cd, end]);
}
const note = { explanation: ['What this file holds.'] };
const download = () => zip({
  'shelvings.zip': zip({ 'shelvings.json': JSON.stringify([note,
    { book: 'The Long Walk, Again', read_status: 'read', created_at: '2023-07-01 10:00:00 UTC' },
    { book: 'Twice Told', read_status: 'read', created_at: '2015-01-01 10:00:00 UTC' },
    { book: 'Someday', read_status: 'to-read', created_at: '2024-05-05 10:00:00 UTC' }]) }),
  'reviews.zip': zip({ 'reviews.json': JSON.stringify([note, { reviews: [{ book: 'The Long Walk, Again', rating: 5.0 }, { book: 'Twice Told', rating: 3.0 }] }]) }),
  'reading_sessions.zip': zip({ 'reading_sessions.json': JSON.stringify([note,
    { book: 'The Long Walk, Again', started_at: '2021-06-01 00:00:00 UTC', ended_at: '2021-06-14 00:00:00 UTC', state: 'COMPLETED' },
    { book: 'Twice Told', started_at: '2016-03-01 00:00:00 UTC', ended_at: '2016-03-09 00:00:00 UTC', state: 'COMPLETED' },
    { book: 'Twice Told', started_at: '2015-02-01 00:00:00 UTC', ended_at: '2015-02-20 00:00:00 UTC', state: 'COMPLETED' },
    { book: 'Someday', started_at: '2024-06-01 00:00:00 UTC', ended_at: '(not provided)', state: 'COMPLETED' }]) }),
  README: 'About your data.'
});

test('the data download: the read shelf with your stars and the days you started and finished each time', () => {
  const list = books.fromDataDownload(download());
  assert.deepStrictEqual(list.map(b => [b.title, b.rating, b.started, b.finished, b.added, b.read_count]),
    [['The Long Walk, Again', 5, '2021-06-01', '2021-06-14', '2023-07-01', 1], ['Twice Told', 3, '2016-03-01', '2016-03-09', '2015-01-01', 2]]);
  assert.deepStrictEqual(list[1].reads, [{ started: '2015-02-01', finished: '2015-02-20' }, { started: '2016-03-01', finished: '2016-03-09' }]);
  assert.throws(() => books.fromDataDownload(zip({ 'other.json': '[]' })), /not a Goodreads data download/);
});

test('the library export and the data download each keep what only the other knew', () => {
  const file = require('path').join(require('os').tmpdir(), `books-${process.pid}.json`);
  const shelf = books.create({ file, log: () => {} });
  shelf.importExport(download());
  shelf.importExport([HEAD, '1,"The Long Walk, Again",Ann Example,"Example, Ann",,,,5,4.1,Pub,Paperback,320,2001,1999,2021/06/14,2023/07/01,,,read,,,,1,0'].join('\n'));
  assert.deepStrictEqual(shelf.list().map(b => [b.title, b.author, b.pages, b.started]), [['The Long Walk, Again', 'Ann Example', 320, '2021-06-01']]);
  shelf.importExport(download());
  assert.deepStrictEqual(shelf.list().map(b => [b.title, b.author, b.started]), [['The Long Walk, Again', 'Ann Example', '2021-06-01'], ['Twice Told', '', '2016-03-01']]);
  require('fs').unlinkSync(file);
});
