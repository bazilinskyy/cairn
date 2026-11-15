'use strict';
// World Heritage sites and national parks (sites.js): the lists made from Wikidata's rows, and the days you were at each.
// Made-up sites, places and rides.

const { test } = require('node:test');
const assert = require('node:assert');
const ground = require('../ground');
const sites = require('../sites');

test('a site is been to on the days a place or a ride came within its reach; airports and other days not', () => {
  const lists = {
    unesco: [{ id: '100', name: 'Old Town of Exampleburg', cc: 'XA', year: 1990, pts: [[50.0, 10.0, 500]] },
      { id: '101', name: 'Abbeys of the Valley', cc: '', year: 2001, pts: [[45.0, 7.0, 300], [45.5, 7.5, 300]] }],
    park: [{ id: 'Q1', name: 'Example Hills National Park', cc: 'XA', pts: [[48.0, 12.0, 5000]] }]
  };
  const places = [
    { at: [50.003, 10.0], day: '2020-05-01' },  // 330 m from the old town: in it
    { at: [50.003, 10.0], day: '2020-05-01' },
    { at: [50.0, 10.0], day: '2021-01-01', air: true },  // an airport there: not a visit
    { at: [50.02, 10.0], day: '2022-02-02' },  // 2.2 km away: not
    { at: [45.501, 7.5], day: '2019-09-09' }  // the second part of the abbeys
  ];
  // a ride through the park, starting 20 km outside it
  const path = ground.encode([[48.2, 12.0], [48.1, 12.0], [48.02, 12.0], [47.9, 12.0]]);
  const activities = [{ id: 1, date: '2023-07-14 09:00:00', path }, { id: 2, date: '2023-07-15 09:00:00' }];
  const s = sites.create({ places: () => places, activities: () => activities, lists, ccAt: () => 'XB' });
  const out = s.list();
  assert.deepStrictEqual(out.unesco.map(x => [x.id, x.days, x.cc]), [['100', ['2020-05-01'], 'XA'], ['101', ['2019-09-09'], 'XB']]);
  assert.deepStrictEqual(out.unesco[1].at, [45.5, 7.5], 'where you were: the part you came to');
  assert.deepStrictEqual(out.park[0].days, ['2023-07-14']);
  assert.strictEqual(s.list(), out, 'worked out again only when the places or rides change');
});

test('reach: a circle of the area within bounds, a set one without an area', () => {
  assert.strictEqual(sites.reachOf('unesco', 0), 800);
  assert.strictEqual(sites.reachOf('unesco', 100), 300);  // a small building: at least 300 m
  assert.strictEqual(sites.reachOf('unesco', Math.PI * 2000 ** 2), 2000);
  assert.strictEqual(sites.reachOf('unesco', 1e12), 10000);
  assert.strictEqual(sites.reachOf('park', Math.PI * 10000 ** 2), 8000);  // parks: 0.8 of the circle, they are long
});

test('the lists from Wikidata: a site\'s parts under its number, a serial site\'s own item without its area; parks once each', () => {
  const W = 'http://www.wikidata.org/entity/';
  const listed = [
    { site: W + 'Q10', siteLabel: 'banks of the Example', id: '200', cc: 'XA', start: '1991-01-01T00:00:00Z' },
    { site: W + 'Q20', siteLabel: 'Example Chapels', id: '300', cc: 'XB', start: '2005-01-01T00:00:00Z' },
    { site: W + 'Q21', siteLabel: 'Chapel of St Example', id: '300-002', start: '2010-01-01T00:00:00Z' }
  ];
  const parts = [
    { item: W + 'Q10', itemLabel: 'banks of the Example', id: '200', coord: 'Point(2.3 48.86)', area: String(Math.PI * 1000 ** 2) },
    { item: W + 'Q20', itemLabel: 'Example Chapels', id: '300', coord: 'Point(10 45)', area: '1e12' },
    { item: W + 'Q21', itemLabel: 'Chapel of St Example', id: '300-002', coord: 'Point(10.1 45.1)' },
    { item: W + 'Q22', itemLabel: 'Chapel of St Other', id: '300-003', coord: 'Point(10.2 45.2)', area: '10000' },
    { item: W + 'Q99', itemLabel: 'Not listed', id: '999', coord: 'Point(0 0)' }
  ];
  assert.deepStrictEqual(sites.unescoSites(listed, parts), [
    { id: '200', name: 'Banks of the Example', cc: 'XA', year: 1991, pts: [[48.86, 2.3, 1000]] },
    { id: '300', name: 'Example Chapels', cc: 'XB', year: 2005, pts: [[45, 10, 800], [45.1, 10.1, 800], [45.2, 10.2, 300]] }
  ]);
  assert.deepStrictEqual(sites.parkSites([
    { park: W + 'Q5', parkLabel: 'Example Dunes National Park', coord: 'Point(4.5 52.4)', area: String(Math.PI * 5000 ** 2), cc: 'XA' },
    { park: W + 'Q5', parkLabel: 'Example Dunes National Park', coord: 'Point(4.5 52.4)', area: String(Math.PI * 5000 ** 2) },
    { park: W + 'Q6', parkLabel: 'Q6', coord: 'Point(1 1)' }  // no name in any language: left out
  ]), [{ id: 'Q5', name: 'Example Dunes National Park', cc: 'XA', pts: [[52.4, 4.5, 4000]] }]);
});
