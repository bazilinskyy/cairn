'use strict';
// UNESCO World Heritage sites (unesco.json) and national parks (parks.json), both from Wikidata, and which of them you
// have been to. A site is one or more places, each a point with a reach: a circle as big as its area (in Wikidata)
// within bounds, else a set one; a serial site (the Struve Geodetic Arc, Le Corbusier's buildings) has a place per
// part, and any part counts. You have been to a site on a day when a place of that day (a photo, check-in, Timeline
// visit, stay, or where an activity started; not an airport) or a point of an activity's track is within its reach.
// A park's area is seldom a circle, so near its edge "been" can mean "nearby".
//
//   node sites.js build    the lists again from Wikidata (query.wikidata.org), into unesco.json and parks.json

const fs = require('fs');
const path = require('path');
const ground = require('./ground');

const SLACK_M = 300;  // a photo from across the square still counts
const KINDS = {
  unesco: { file: 'unesco.json', min: 300, max: 10000, none: 800, share: 1 },
  park: { file: 'parks.json', min: 800, max: 20000, none: 2500, share: 0.8 }  // a park's circle a bit smaller than its area: parks are long
};
const read = file => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8')); } catch (_) { return []; } };
// the reach of a place of this area (m²): a circle of that area (times share), within [min, max] metres
const reachOf = (kind, area) => {
  const k = KINDS[kind];
  return area > 0 ? Math.round(Math.min(k.max, Math.max(k.min, k.share * Math.sqrt(area / Math.PI)))) : k.none;
};

// Sites by 1° cell, for finding those whose reach a point may be in: [[site, place]] per cell of each place
function cellsOf(sites) {
  const cells = new Map();
  sites.forEach(s => s.pts.forEach(p => {
    const k = `${Math.floor(p[0])}|${Math.floor(p[1])}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push([s, p]);
  }));
  return cells;
}
function near(cells, lat, lon, fn) {
  const a = Math.floor(lat), b = Math.floor(lon);
  for (let i = a - 1; i <= a + 1; i++) for (let j = b - 1; j <= b + 1; j++) {
    const list = cells.get(`${i}|${j < -180 ? j + 360 : j >= 180 ? j - 360 : j}`);
    if (list) list.forEach(([s, p]) => { if (ground.km([lat, lon], [p[0], p[1]]) * 1000 <= p[2] + SLACK_M) fn(s, p); });
  }
}

// Which sites you have been to, and on which days: [{ ...site, days: [YYYY-MM-DD], at: [lat, lon] of the place you
// were at (the first part you reached) }] for each kind, the ones not been to with days []
// places(): [{ at: [lat, lon], day, air }] (air: an airport, left out); activities(): [{ path (encoded), date }]
function visits(sites, places, activities) {
  const cells = cellsOf(sites), days = new Map(), at = new Map();
  const seen = (s, p, day) => {
    if (!days.has(s.id)) { days.set(s.id, new Set()); at.set(s.id, [p[0], p[1]]); }
    days.get(s.id).add(day);
  };
  places.forEach(p => { if (p.at && p.day && !p.air) near(cells, p.at[0], p.at[1], (s, q) => seen(s, q, p.day.slice(0, 10))); });
  activities.forEach(a => {
    if (!a.path || !a.date) return;
    const day = a.date.slice(0, 10);
    let last = null;
    ground.decode(a.path).forEach(q => {  // a point every 200 m or so
      if (last && Math.abs(q[0] - last[0]) + Math.abs(q[1] - last[1]) < 0.002) return;
      last = q;
      near(cells, q[0], q[1], (s, p) => seen(s, p, day));
    });
  });
  return sites.map(s => ({ ...s, days: days.has(s.id) ? [...days.get(s.id)].sort() : [], at: at.get(s.id) || [s.pts[0][0], s.pts[0][1]] }));
}

// sources: places() (the places of the days that have been), activities(); both read again when they change.
// ccAt(lat, lon): the country there, for a site Wikidata gives none (the Netherlands' are the Kingdom's, without a code)
function create({ places, activities, lists = null, ccAt = () => '' }) {
  const all = lists || Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, read(v.file)]));
  let memo = { key: '', out: null }, filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    Object.values(all).forEach(sites => sites.forEach(s => { if (!s.cc) s.cc = ccAt(s.pts[0][0], s.pts[0][1]) || ''; }));
  };
  return {
    // { unesco: [...], park: [...] }, each site with the days you were there
    list() {
      fill();
      const pl = places(), acts = activities(), key = `${pl.length}|${pl[0]?.day}|${pl[pl.length - 1]?.day}|${acts.length}|${acts[0]?.id}`;
      if (memo.key !== key) memo = { key, out: Object.fromEntries(Object.entries(all).map(([k, sites]) => [k, visits(sites, pl, acts)])) };
      return memo.out;
    },
    total: kind => (all[kind] || []).length
  };
}

// --- the lists, from Wikidata ---

const SPARQL = 'https://query.wikidata.org/sparql';
async function sparql(query) {
  const r = await fetch(`${SPARQL}?query=${encodeURIComponent(query)}`, {
    headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'cairn (open-source travel atlas; sites.js build)' } });
  if (!r.ok) throw new Error(`Wikidata: ${r.status}`);
  return (await r.json()).results.bindings.map(b => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
}
const point = wkt => { const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(wkt || ''); return m ? [+(+m[2]).toFixed(5), +(+m[1]).toFixed(5)] : null; };
const qid = uri => uri.replace(/^.*\//, '');

// Rows of the two queries below into sites: [{ id, name, cc, year, pts: [[lat, lon, reach m]] }]
function unescoSites(listed, parts) {
  const base = id => (/^\d+/.exec(id) || [id])[0];
  const sites = new Map();
  listed.forEach(r => {  // the inscribed sites (their designation not ended): name, country, year
    const id = base(r.id);
    const s = sites.get(id) || { id, name: '', cc: '', year: 0, main: new Set(), pts: [] };
    if (!s.name || r.id === id) s.name = r.siteLabel;
    if (!s.cc && r.cc) s.cc = r.cc;
    const y = r.start ? +r.start.slice(0, 4) : 0;
    if (y && (!s.year || y < s.year)) s.year = y;
    s.main.add(r.site);
    sites.set(id, s);
  });
  const byItem = new Map();  // item → its place and area (a part of a site may come in several rows)
  parts.forEach(r => {
    const id = base(r.id), at = point(r.coord);
    if (!sites.has(id) || !at) return;
    const k = `${id}|${r.item}|${at}`;
    if (!byItem.has(k)) byItem.set(k, { id, item: r.item, at, area: +r.area || 0, label: r.itemLabel });
  });
  const items = [...byItem.values()];
  sites.forEach(s => {
    const mine = items.filter(i => i.id === s.id), serial = new Set(mine.map(i => i.item)).size > 1;
    // a serial site's own item stands for all its parts: its area is theirs together, not a circle round its point
    mine.forEach(i => s.pts.push([i.at[0], i.at[1], reachOf('unesco', serial && s.main.has(i.item) ? 0 : i.area)]));
    if (!s.name && mine[0]) s.name = mine[0].label;
    s.name = s.name.charAt(0).toUpperCase() + s.name.slice(1);  // "banks of the Seine"
    delete s.main;
  });
  return [...sites.values()].filter(s => s.pts.length && s.name && !/^Q\d+$/.test(s.name)).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}
function parkSites(rows) {
  const parks = new Map();
  rows.forEach(r => {
    const id = qid(r.park), at = point(r.coord);
    if (!at || !r.parkLabel || /^Q\d+$/.test(r.parkLabel)) return;
    const p = parks.get(id) || { id, name: r.parkLabel, cc: r.cc || '', area: 0, at: [] };
    if (!p.cc && r.cc) p.cc = r.cc;
    if (+r.area > p.area) p.area = +r.area;
    if (!p.at.some(a => a[0] === at[0] && a[1] === at[1])) p.at.push(at);
    parks.set(id, p);
  });
  return [...parks.values()].map(p => ({ id: p.id, name: p.name, cc: p.cc, pts: p.at.slice(0, 5).map(a => [a[0], a[1], reachOf('park', p.at.length > 1 ? 0 : p.area)]) }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

const Q_LISTED = `SELECT ?site ?siteLabel ?id ?cc ?start WHERE {
  ?site p:P1435 ?st . ?st ps:P1435 wd:Q9259 . FILTER NOT EXISTS { ?st pq:P582 ?end }
  ?site wdt:P757 ?id . OPTIONAL { ?st pq:P580 ?start } OPTIONAL { ?site wdt:P17 ?c . ?c wdt:P297 ?cc }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`;
const Q_PARTS = `SELECT ?item ?itemLabel ?id ?coord ?area WHERE {
  ?item wdt:P757 ?id ; wdt:P625 ?coord . OPTIONAL { ?item p:P2046/psn:P2046/wikibase:quantityAmount ?area }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`;
const Q_PARKS = `SELECT ?park ?parkLabel ?coord ?area ?cc WHERE {
  ?park wdt:P31/wdt:P279* wd:Q46169 ; wdt:P625 ?coord . FILTER NOT EXISTS { ?park wdt:P576 ?gone }
  OPTIONAL { ?park p:P2046/psn:P2046/wikibase:quantityAmount ?area } OPTIONAL { ?park wdt:P17 ?c . ?c wdt:P297 ?cc }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr,de,es,pt,it,nl,ru,uk,pl,sv,ja,zh". } }`;

async function build() {
  const unesco = unescoSites(await sparql(Q_LISTED), await sparql(Q_PARTS));
  const parks = parkSites(await sparql(Q_PARKS));
  const write = (file, list) => fs.writeFileSync(path.join(__dirname, file), '[\n' + list.map(s => JSON.stringify(s)).join(',\n') + '\n]\n');
  write(KINDS.unesco.file, unesco);
  write(KINDS.park.file, parks);
  console.log(`${unesco.length} World Heritage sites (${unesco.reduce((n, s) => n + s.pts.length, 0)} places), ${parks.length} national parks`);
}

module.exports = { create, visits, reachOf, unescoSites, parkSites };
if (require.main === module && process.argv[2] === 'build') build().catch(e => { console.error(e.message); process.exit(1); });
