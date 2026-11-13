'use strict';
// No two functions of one name at the top of a file: the later one silently replaces the first everywhere (a second
// fillGaps in ground.js once turned every timetable's track away).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('no two top-level functions share a name in a file', () => {
  const root = path.join(__dirname, '..');
  const files = [...fs.readdirSync(root).filter(f => f.endsWith('.js')),
    ...fs.readdirSync(path.join(root, 'public')).filter(f => f.endsWith('.js')).map(f => path.join('public', f))];
  const twice = [];
  for (const f of files) {
    const seen = new Set();
    for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/^(?:async )?function\*? ?([A-Za-z0-9_$]+)/gm)) {
      if (seen.has(m[1])) twice.push(`${f}: ${m[1]}`);
      seen.add(m[1]);
    }
  }
  assert.deepStrictEqual(twice, []);
});
