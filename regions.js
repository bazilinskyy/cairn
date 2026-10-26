'use strict';
// Ways to count the countries you have been to. A place is put in the state or province it lies in, from Natural
// Earth's admin-1 map (data/admin1.geojson, downloaded on first use), and that in a country of the list chosen:
//   iso: ISO 3166-1, the 249 countries and territories with a country code (Greenland, Puerto Rico, Hong Kong,
//        Réunion, Svalbard each count apart)
//   un:  the 200 countries the Travelers' Century Club counts as countries: 193 UN members, the Vatican and Palestine,
//        Cook Islands, Niue, Kosovo, Taiwan and Northern Cyprus. A territory counts for none of them.
//   tcc: the Travelers' Century Club's 330 countries and territories, which split off islands, parts of countries
//        and claims (Canary Islands, Scotland, Sicily, Alaska, Russia in Asia, Antarctic claims)
// The two lists are country-lists.json: each TCC place has rules (whole countries by ISO code or Natural Earth's
// adm0_a3, units by iso_3166_2 or adm1_code, boxes for islands Natural Earth does not hold apart). A box wins over a
// unit, a unit named over a whole country, and an earlier place over a later one.

const fs = require('fs');
const path = require('path');

const ADMIN1_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson';
const LISTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'country-lists.json'), 'utf8'));
const ISO = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW ' +
  'BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
  'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO ' +
  'JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS ' +
  'MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU ' +
  'RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA ' +
  'UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK').split(' ');  // XK, Kosovo: user-assigned, used by all
const NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
const SPLIT = {  // units Natural Earth files under one country that ISO gives a code of their own, or that are elsewhere
  'FR-GP': 'GP', 'FR-MQ': 'MQ', 'FR-GF': 'GF', 'FR-RE': 'RE', 'FR-YT': 'YT', 'NO-21': 'SJ', 'NO-X01~': 'BV',
  'NL-BQ1': 'BQ', 'NL-BQ2': 'BQ', 'NL-BQ3': 'BQ', 'UA-43': 'UA', 'UA-40': 'UA'
};
const NO_ISO = {  // Natural Earth's units with no ISO code: the country they are in (Akrotiri and Dhekelia: Cyprus)
  CYN: 'CY', SOL: 'SO', KAB: 'KZ', KAS: 'IN', USG: 'CU', CSI: 'AU', CLP: 'FR', WSB: 'CY', ESB: 'CY'
};
const NEAR = 0.2;  // a point off the coastline (a port, a beach) goes to the unit within this many degrees

// --- the map: units, each made of parts (polygons: outer ring and holes, as flat [x0, y0, x1, y1, ...]) ---

function readUnits(file) {
  const geo = JSON.parse(fs.readFileSync(file, 'utf8'));
  return geo.features.filter(f => f.geometry).map(f => {
    const p = f.properties, g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    const parts = polys.map(rings => {
      const flat = rings.map(r => Float64Array.from(r.flat()));
      let w = 180, s = 90, e = -180, n = -90;
      for (let i = 0; i < flat[0].length; i += 2) {
        const x = flat[0][i], y = flat[0][i + 1];
        if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
      }
      return { box: [w, s, e, n], rings: flat };
    });
    return { iso: p.iso_a2, a3: p.adm0_a3, code: p.iso_3166_2, acode: p.adm1_code, parts };
  });
}

function inPart(part, x, y) {
  let inside = false;
  for (const r of part.rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function distToPart(part, x, y) {  // degrees, longitude shrunk by the latitude
  const k = Math.cos(y * Math.PI / 180);
  let best = Infinity;
  for (const r of part.rings) {
    for (let i = 2; i < r.length; i += 2) {
      const ax = (r[i - 2] - x) * k, ay = r[i - 1] - y, bx = (r[i] - x) * k, by = r[i + 1] - y;
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      const d = (ax + t * dx) ** 2 + (ay + t * dy) ** 2;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

const inBox = ([w, s, e, n], x, y, pad = 0) => x >= w - pad && x <= e + pad && y >= s - pad && y <= n + pad;
const boxIn = (a, b) => a[0] >= b[0] && a[2] <= b[2] && a[1] >= b[1] && a[3] <= b[3];

function index(units) {  // 1-degree cells -> [unit, part] whose box reaches into the cell
  const grid = new Map();
  units.forEach((u, ui) => u.parts.forEach((p, pi) => {
    const [w, s, e, n] = p.box;
    for (let y = Math.floor(s); y <= Math.floor(n); y++) for (let x = Math.floor(w); x <= Math.floor(e); x++) {
      const key = y + ',' + x;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push([ui, pi]);
    }
  }));
  return grid;
}

// The unit a point is in, or the nearest within NEAR degrees; -1 when none
function unitAt(m, lat, lon) {
  const key = (Math.round(lat * 100) / 100) + ',' + (Math.round(lon * 100) / 100);
  if (m.memo.has(key)) return m.memo.get(key);
  let hit = -1;
  for (const [ui, pi] of m.grid.get(Math.floor(lat) + ',' + Math.floor(lon)) || []) {
    const part = m.units[ui].parts[pi];
    if (inBox(part.box, lon, lat) && inPart(part, lon, lat)) { hit = ui; break; }
  }
  if (hit < 0) {
    let best = NEAR;
    const seen = new Set();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const [ui, pi] of m.grid.get((Math.floor(lat) + dy) + ',' + (Math.floor(lon) + dx)) || []) {
        const part = m.units[ui].parts[pi];
        if (seen.has(part) || !inBox(part.box, lon, lat, NEAR)) continue;
        seen.add(part);
        const d = distToPart(part, lon, lat);
        if (d < best) { best = d; hit = ui; }
      }
    }
  }
  m.memo.set(key, hit);
  return hit;
}

// --- the lists: the place (an index into the list) of each unit, and boxes that win over units ---

function compile(units, scheme) {
  if (scheme === 'iso') {
    const places = ISO.map(id => ({ id, name: NAMES.of(id) }));
    const at = new Map(ISO.map((id, i) => [id, i]));
    const of = u => at.get(SPLIT[u.code] || (u.a3 === 'IOA' ? null : NO_ISO[u.a3]) || u.iso) ?? -1;
    return { places, unitPlace: units.map(of), boxes: [{ box: [100, -11, 106, -10], place: at.get('CX') }, { box: [96, -13, 97.5, -11.5], place: at.get('CC') }] };
  }
  if (scheme === 'un') {
    const places = LISTS.un.map(p => ({ id: p.id, name: p.id.length === 2 ? NAMES.of(p.id) : 'Northern Cyprus', group: p.group }));
    const at = new Map(LISTS.un.map((p, i) => [p.id, i]));
    const of = u => {  // a territory with an ISO code of its own (Réunion, Svalbard, Bonaire), or of none, counts for none
      if (u.a3 === 'CYN') return at.get('CYN');
      const iso = SPLIT[u.code] || (['CSI', 'CLP', 'WSB', 'ESB', 'IOA'].includes(u.a3) ? null : NO_ISO[u.a3]) || u.iso;
      return (iso === u.iso || iso === 'UA' || NO_ISO[u.a3] ? at.get(iso) : null) ?? -1;
    };
    return { places, unitPlace: units.map(of), boxes: [] };
  }
  const list = LISTS.tcc;
  const places = list.map(p => ({ id: p.id, name: p.name, region: p.region }));
  const byCode = new Map(), whole = new Map(), boxes = [];
  list.forEach((p, i) => p.rules.forEach(r => {
    if (r.bbox) boxes.push({ box: r.bbox, place: i });
    else if (r.adm1) r.adm1.forEach(c => { if (!byCode.has(c)) byCode.set(c, i); });
    else {
      const k = r.iso ? 'iso:' + r.iso : 'a3:' + r.adm0_a3;
      if (!whole.has(k)) whole.set(k, i);
    }
  }));
  const of = u => byCode.get(u.code) ?? byCode.get(u.acode) ?? whole.get('iso:' + u.iso) ?? whole.get('a3:' + u.a3) ?? -1;
  return { places, unitPlace: units.map(of), boxes };
}

function placeAt(m, s, lat, lon) {
  const b = s.boxes.find(b => inBox(b.box, lon, lat));
  if (b) return b.place;
  const ui = unitAt(m, lat, lon);
  return ui < 0 ? -1 : s.unitPlace[ui];
}

// --- outlines of a place, to draw: its units' parts, simplified (a part inside one of its boxes goes to the box) ---

function simplify(r, tol) {  // Douglas-Peucker on a flat ring; a ring that would vanish keeps a few of its points
  const n = r.length / 2, keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = r[2 * a], ay = r[2 * a + 1], dx = r[2 * b] - ax, dy = r[2 * b + 1] - ay, len = Math.hypot(dx, dy);
    let far = -1, fd = tol;
    for (let i = a + 1; i < b; i++) {  // from the line a-b; from a itself when b is a again (a closed ring)
      const px = r[2 * i] - ax, py = r[2 * i + 1] - ay;
      const d = len ? Math.abs(dy * px - dx * py) / len : Math.hypot(px, py);
      if (d > fd) { fd = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  let out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push([r[2 * i], r[2 * i + 1]]);
  if (out.length < 4) {
    const step = Math.max(1, Math.floor(n / 6));
    out = [];
    for (let i = 0; i < n; i += step) out.push([r[2 * i], r[2 * i + 1]]);
    out.push([r[0], r[1]]);
  }
  return out.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
}

function outline(m, s, place) {
  const polys = [];
  m.units.forEach((u, ui) => u.parts.forEach(part => {
    const box = s.boxes.find(b => boxIn(part.box, b.box));
    if ((box ? box.place : s.unitPlace[ui]) !== place) return;
    polys.push(part.rings.map(r => simplify(r, 0.025)));
  }));
  s.boxes.forEach(b => {  // a box with no land of the map in it (an island Natural Earth lacks): the box itself
    if (b.place !== place || m.units.some(u => u.parts.some(p => boxIn(p.box, b.box)))) return;
    const [w, so, e, n] = b.box;
    polys.push([[[w, so], [e, so], [e, n], [w, n], [w, so]]]);
  });
  return { type: 'MultiPolygon', coordinates: polys };
}

// --- the map, loaded once (downloaded first when missing) ---

function create({ file, download }) {
  let loading = null, loaded = null;
  const schemes = {}, shapes = new Map();
  function ready() {
    if (!loading) {
      loading = (async () => {
        if (!fs.existsSync(file)) {
          console.log('[regions] Downloading the Natural Earth admin-1 map...');
          fs.writeFileSync(file, await download(ADMIN1_URL));
        }
        const units = readUnits(file);
        return (loaded = { units, grid: index(units), memo: new Map() });
      })().catch(e => { loading = null; throw e; });
    }
    return loading;
  }
  const scheme = (m, name) => (schemes[name] = schemes[name] || compile(m.units, name));
  return {
    SCHEMES: ['iso', 'un', 'tcc'],
    ready,
    // The places of the list visited by these points ({ at: [lat, lon], day }), with their days and outlines
    async visited(name, points) {
      const m = await ready(), s = scheme(m, name);
      const seen = new Map();
      points.forEach(p => {
        const i = placeAt(m, s, p.at[0], p.at[1]);
        if (i < 0) return;
        if (!seen.has(i)) seen.set(i, new Set());
        seen.get(i).add(p.day);
      });
      const places = [...seen].map(([i, days]) => {
        const sorted = [...days].sort(), key = name + ':' + i;
        if (!shapes.has(key)) shapes.set(key, outline(m, s, i));
        return { ...s.places[i], days: sorted.length, first: sorted[0], last: sorted[sorted.length - 1], shape: shapes.get(key) };
      });
      return { scheme: name, total: s.places.length, places };
    },
    async placeOf(name, lat, lon) {
      await ready();
      return this.placeNow(name, lat, lon);
    },
    placeNow(name, lat, lon) {  // once ready
      const s = scheme(loaded, name), i = placeAt(loaded, s, lat, lon);
      return i < 0 ? null : s.places[i];
    }
  };
}

module.exports = { create, ISO };
