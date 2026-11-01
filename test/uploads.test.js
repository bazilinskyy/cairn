'use strict';
// Imports from Settings (uploads.js): files uploaded into a batch, read by the source's import in the background,
// how it went kept, the uploaded copies removed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const uploads = require('../uploads');

const until = async ok => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 20)); };

test('a batch of files is read by its import, then removed; how it went is kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-uploads-')), seen = [];
  const u = uploads.create({ dir: path.join(dir, 'uploads'), statusFile: path.join(dir, 'uploads.json'), log: () => {}, sources: {
    notes: { label: 'Notes', run: async files => { seen.push(...files.map(f => fs.readFileSync(f, 'utf8')).sort()); return `${files.length} files`; } },
    broken: { label: 'Broken', run: async () => { throw new Error('not a download of that kind'); } }
  } });
  await u.receive('notes', 'abcdefgh', 'a.txt', Readable.from(['one']));
  await u.receive('notes', 'abcdefgh', '../../b.txt', Readable.from(['two']));  // only its name counts
  assert.deepStrictEqual(u.start('notes', 'abcdefgh'), { started: true });
  await until(() => !u.list()[0].running);
  assert.deepStrictEqual(seen, ['one', 'two']);
  assert.deepStrictEqual([u.list()[0].last.ok, u.list()[0].last.message, u.list()[0].last.files.sort()], [true, '2 files', ['a.txt', 'b.txt']]);
  assert.ok(!fs.existsSync(path.join(dir, 'uploads', 'abcdefgh')), 'the uploaded copies are removed');

  await u.receive('broken', 'ijklmnop', 'x.csv', Readable.from(['x']));
  u.start('broken', 'ijklmnop');
  await until(() => !u.list()[1].running);
  assert.deepStrictEqual([u.list()[1].last.ok, u.list()[1].last.message], [false, 'not a download of that kind']);
  assert.strictEqual(u.start('notes', 'zzzzzzzz').status, 400);  // nothing uploaded
  await assert.rejects(u.receive('nope', 'abcdefgh', 'a', Readable.from(['x'])), /no import called nope/);
});
