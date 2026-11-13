'use strict';
// The railway guess when Overpass times out on a long way at once: asked again box by box, not counted as down.
// No network: fetch is a stand-in.
const { test } = require('node:test');
const assert = require('node:assert');

test('a railway piece too big for Overpass at once is asked for box by box', async () => {
  const a = [50.0, 10.0], b = [50.9, 10.0];  // about 100 km: three boxes, asked together first
  const nodes = Array.from({ length: 21 }, (_, i) => ({ type: 'node', id: i + 1, lat: a[0] + (b[0] - a[0]) * i / 20, lon: 10.0 }));
  const asked = [];
  global.fetch = async url => {
    const u = new URL(url);
    if (!/interpreter/.test(u.pathname)) return new Response(JSON.stringify({ code: 'NoRoute' }), { status: 200 });  // no road: the straight line
    const boxes = (u.searchParams.get('data').match(/way\["railway"/g) || []).length;
    asked.push(boxes);
    if (boxes > 1) return new Response('', { status: 504 });  // every server gives up on all three at once
    return new Response(JSON.stringify({ elements: [...nodes, { type: 'way', id: 1, nodes: nodes.map(n => n.id) }] }), { status: 200 });
  };
  const g = require('../ground.js');
  const log = console.log; console.log = () => {};
  try {
    const pts = await g.railOverpass(a, b);
    assert.ok(pts && pts.length > 2, 'a track along the railway');
    assert.deepStrictEqual(asked, [3, 3, 3, 3, 1, 1, 1]);  // the four servers with all three, then each box alone
  } finally { console.log = log; }
});
