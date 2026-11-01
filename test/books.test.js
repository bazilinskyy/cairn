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
