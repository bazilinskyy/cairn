'use strict';
// Ground trips (trains, buses, ferries, by car) for the map: where their stations are and the track between them; and where
// stays and rental cars are. Places come from Photon (OpenStreetMap), biased towards where the traveller was just
// before; tracks from Transitous (timetabled trains and coaches), else for a train the likeliest railway line
// (OpenStreetMap's tracks from Overpass, else BRouter),
// for a bus the roads (OSRM); else a straight line.
// Each trip or stay is looked up once, in the background, and the result is kept in it.

const UA = 'cairn (personal travel log; https://github.com/bazilinskyy/cairn)';
const PHOTON = 'https://photon.komoot.io/api/';
const PHOTON_REVERSE = 'https://photon.komoot.io/reverse';
const TRANSITOUS = 'https://api.transitous.org/api/v5/plan';
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const BIKE = 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/';  // FOSSGIS's OSRM with the bicycle profile
const BROUTER = 'https://brouter.de/brouter';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];  // the second when the first is busy
const TRANSIT_MODES = { train: 'RAIL', bus: 'COACH,BUS', ferry: 'FERRY' };
const NOT_TRANSIT = new Set(['WALK', 'BIKE', 'CAR', 'RENTAL', 'CAR_PARKING', 'FLEX', 'ODM']);
const PLACE_TAGS = ['place', 'boundary:administrative', 'railway:station', 'railway:halt', 'public_transport:station',
  'amenity:bus_station', 'amenity:ferry_terminal', 'aeroway:aerodrome'];  // towns, islands, stations, ports
// How much of a place a result is: a name that matches exactly only beats Photon's first answer when it is more of a
// place, or as much and about as near ("Málaga" the city over a house called Malaga; not "Pirot" a French hamlet over
// Пирот, the Serbian town Photon names in Cyrillic)
const RANK = { city: 6, town: 5, municipality: 4, island: 4, village: 3, administrative: 1 };
const rank = c => RANK[c.value] || (c.key === 'place' ? 2 : 4);  // stations, ports and airports count as towns-ish
const AIRPORT_RX =/airport|aeroport|aéroport|aeropuerto|flughafen|luchthaven|lotnisko/i;
const NEAR_DAYS = 21;    // the last arrival this many days before a trip is where it starts from
const START_KM = 1500;   // a trip starts at most this far from that last arrival
const LEG_KM = 1500;     // and is at most this long
const STAY_KM = 300;     // a stay is at most this far from where the rest of your data puts you on its days

// --- geometry ---

function km(a, b) {
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function pathKm(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += km(pts[i - 1], pts[i]);
  return s;
}

// Google's encoded polyline, 6 decimals (Transitous and OSRM's polyline6)
function decode(str, precision = 6) {
  const f = 10 ** precision, pts = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    pts.push([lat / f, lon / f]);
  }
  return pts;
}

function encode(pts, precision = 6) {
  const f = 10 ** precision;
  let out = '', pLat = 0, pLon = 0;
  const num = v => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of pts) {
    const a = Math.round(lat * f), b = Math.round(lon * f);
    out += num(a - pLat) + num(b - pLon);
    pLat = a; pLon = b;
  }
  return out;
}

// Ramer-Douglas-Peucker in degrees: drops points that stay within `eps` of the line (about 50 m by default)
function simplify(pts, eps = 0.0005) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [y1, x1] = pts[s], [y2, x2] = pts[e];
    const len = Math.hypot(x2 - x1, y2 - y1);
    let best = -1, far = eps;
    for (let i = s + 1; i < e; i++) {
      const [y, x] = pts[i];
      const d = len ? Math.abs((x2 - x1) * (y1 - y) - (x1 - x) * (y2 - y1)) / len : Math.hypot(x - x1, y - y1);
      if (d > far) { far = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([s, best], [best, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// A track belongs to this trip when it starts and ends near its stations and is not a long detour
function plausible(pts, a, b) {
  const direct = km(a, b);
  return pts.length > 1 && km(pts[0], a) < 30 && km(pts[pts.length - 1], b) < 30 && pathKm(pts) < 2.2 * direct + 30 && !overshoots(pts, b);
}

// A track that passes its end and comes back to it (a timetable's train on to Rotterdam and back to Breda): once
// within 5 km of the end, more than 20 km away again
function overshoots(pts, b) {
  const at = pts.findIndex(p => km(p, b) < 5);
  return at >= 0 && pts.slice(at).some(p => km(p, b) > 20);
}

// A timetable track that is really its stops joined by straight lines (a feed without shapes: a coach from London to
// Bristol in one 170 km jump, an Indian train with a point every 15 km): a step over 30 km and over a third of the
// whole, or fewer than one point per 5 km (a track from shapes has one every few hundred metres)
function gappy(pts) {
  const whole = pathKm(pts);
  if (whole > 30 && pts.length < whole / 5) return true;
  for (let i = 1; i < pts.length; i++) {
    const step = km(pts[i - 1], pts[i]);
    if (step > 30 && step > whole / 3) return true;
  }
  return false;
}

// --- services ---

const last = {};
const SPACING = { 'brouter.de': 3000 };  // BRouter's public server asks for fewer
const resting = {};  // host -> until when it is not asked again: it refused (too many requests)
async function getJSON(url) {
  const host = new URL(url).host;  // at most one request a second per service
  if (resting[host] > Date.now()) throw new Error(`${host}: resting after a refusal`);
  const wait = (last[host] || 0) + (SPACING[host] || 1100) - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last[host] = Date.now();
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(SLOW[host] || (OK_FAILS[host] ? 60000 : 30000)) });
  } catch (e) {
    if (OK_FAILS[host] && e.name === 'TimeoutError') return {};  // a route BRouter takes too long over: none, not an outage
    throw e;
  }
  if (res.status === 429 || res.status === 403) resting[host] = Date.now() + REST_MS;
  if (res.status === 429 || res.status === 403 || (res.status >= 500 && !OK_FAILS[host])) throw new Error(`${host}: HTTP ${res.status}`);
  return res.json().catch(() => ({}));  // BRouter's "no track found" is plain text: no route
}
const SLOW = { 'overpass-api.de': 300000, 'overpass.kumi.systems': 300000 };  // the railways along a long way take Overpass a while
const OK_FAILS = { 'brouter.de': true };  // a route BRouter gives up on (too long, no track) is an answer, not an outage
const REST_MS = 30 * 60e3;

const norm = s => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// "Lisbon (Oriente)", "Bruxelles Central/Brussel Centraal", "Chełm, Al. Armii Krajowej", "Paris Gare Lyon": the
// whole name first, then shorter ones down to its first word
function edits(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length];
}

// Photon also finds near misses ("Isntabul" -> İstanbul) and unrelated places ("Siem Riep" -> Ried): a result counts
// when its name is spelled close to the query or starts the same, or every word of the query is in it ("Paris Nord" ->
// Paris Gare du Nord).
// Names in another script cannot be compared and count.
function similar(q, name) {
  const a = norm(q).replace(/[^\p{L}\p{N}]+/gu, ' ').trim(), b = (name || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!/[a-z]/.test(b)) return true;
  if (edits(a, b) <= Math.max(2, Math.floor(a.length / 4)) || b.includes(a) || a.includes(b)) return true;
  if (a.length >= 4 && a.slice(0, 3) === b.slice(0, 3)) return true;  // Bucharest - București, Munich - München
  const words = b.split(' ');
  return a.split(' ').every(w => w.length < 3 || words.some(x => edits(w, x) <= (w.length > 5 ? 2 : 1)));
}

// (query, shortened):a shortened name ("Paris" of "Paris Gare Lyon") only counts when it is a town of that name
function variants(name) {
  const n = (name || '').replace(/…$/, '').trim();
  const v = [n, n.replace(/\s*\([^)]*\)?/g, ''), n.split('/')[0], n.split(',')[0]].map(s => s.trim()).filter(Boolean);
  const words = (v[1] || '').split(/\s+/), out = [...new Set(v)].map(q => [q, false]);
  for (let i = words.length - 1; i > 0; i--) out.push([words.slice(0, i).join(' '), true]);
  return out;
}

const geoCache = new Map();
// A place named only by what it is ("Port", "Bus station"): the nearest such place to the other end of the trip, as
// a calendar entry "Valverde - Port" means El Hierro's ferry port, not a town called Port somewhere else
const BARE = [
  [/^(the )?(port|harbou?r|ferry( terminal| port)?)$/i, 'amenity:ferry_terminal'],  // not "Porto" or "Puerto": towns
  [/^(the )?(central )?bus (station|terminal)$/i, 'amenity:bus_station'],
  [/^(the )?((central|main|train|railway) )?station$/i, 'railway:station'],
];
const BARE_KM = 40;

// The stations (or other places of a kind) around a place, nearest first, at most n
async function placesNear(tag, around, n, radius = BARE_KM) {
  const key = `reverse${n}|${tag}|${around.map(x => x.toFixed(2)).join(',')}|${radius}`;
  if (!geoCache.has(key)) {
    const p = new URLSearchParams({ lat: around[0], lon: around[1], radius, limit: String(n), osm_tag: tag });
    const d = await getJSON(`${PHOTON_REVERSE}?${p}`);
    geoCache.set(key, (d.features || []).map(f => ({ at: [f.geometry.coordinates[1], f.geometry.coordinates[0]] })));
  }
  return geoCache.get(key).map(x => x.at);
}

async function nearestOf(tag, around) {
  const key = `reverse|${tag}|${around.map(x => x.toFixed(2)).join(',')}`;
  if (!geoCache.has(key)) {
    const p = new URLSearchParams({ lat: around[0], lon: around[1], radius: BARE_KM, limit: '1', osm_tag: tag });
    const d = await getJSON(`${PHOTON_REVERSE}?${p}`);
    const f = (d.features || [])[0];
    geoCache.set(key, f ? [{ at: [f.geometry.coordinates[1], f.geometry.coordinates[0]] }] : []);
  }
  return geoCache.get(key)[0]?.at || null;
}

// "Zurich central station (Sihlquai car park)", "Munich central bus station", "Pattaya Minivan Station": a town and a
// station of it, as booking emails name them
const TOWN_STATION = /^(.+?)[\s-]+(?:central\s+|main\s+|north\s+|south\s+)?(train|railway|bus|coach|minivan)?\s*station\b/i;

async function geocode(name, bias, maxKm, lang = '') {
  const bare = BARE.find(([rx]) => rx.test((name || '').trim()));
  if (bare) return bias ? nearestOf(bare[1], bias) : null;  // with nothing to be near, any "Port" would be a guess
  // the town first, then its station nearest to it (the whole name would find a station of that name anywhere)
  const plain = (name || '').replace(/\s*\(.*?\)/g, '').trim(), inside = ((name || '').match(/\((.*?)\)/) || [])[1] || '';
  const ts = TOWN_STATION.exec(plain) || (/station/i.test(inside) ? TOWN_STATION.exec(`${plain} ${inside}`) : null);  // "Metz (central bus station)"
  if (ts && ts[1].length > 2) {
    const town = await geocode(ts[1], bias, maxKm, lang);
    if (!town) return null;
    const st = await nearestOf(/bus|coach|minivan/i.test(ts[2] || '') ? 'amenity:bus_station' : 'railway:station', town);
    return st && km(st, town) < 15 ? st : town;
  }
  const tags = AIRPORT_RX.test(name || '') ? ['aeroway:aerodrome'] : PLACE_TAGS;
  for (const [q, shortened] of variants(name)) {
    const key = `${q}|${bias ? bias.map(x => x.toFixed(0)).join(',') : ''}|${lang}`;
    if (!geoCache.has(key)) {
      const p = new URLSearchParams({ q, limit: '8' });
      if (lang) p.set('lang', lang);  // names in that language ("Lisbon"), else each place's own ("Lisboa")
      tags.forEach(t => p.append('osm_tag', t));
      if (bias) p.set('lat', bias[0]), p.set('lon', bias[1]), p.set('zoom', '10'), p.set('location_bias_scale', '0.2');
      const d = await getJSON(`${PHOTON}?${p}`);
      geoCache.set(key, (d.features || []).map(f => ({
        name: norm(f.properties?.name), key: f.properties?.osm_key, value: f.properties?.osm_value,
        at: [f.geometry.coordinates[1], f.geometry.coordinates[0]]
      })));
    }
    const anyAirport = AIRPORT_RX.test(q) && !/\p{L}/u.test(q.replace(AIRPORT_RX, ''));  // "airport", "Airport"
    const hit = pick(geoCache.get(key), q, { shortened, bias, maxKm, anyAirport });
    if (hit) return hit.at;
  }
  return null;
}

// The candidate (Photon's answers, in its order) that is this place, or undefined. A bare "airport" is the one
// nearest to the bias; other airport names are Photon's first answer, whatever their language.
function pick(cands, q, { shortened = false, bias = null, maxKm = null, anyAirport = false } = {}) {
  const reach = cands.filter(c => !bias || !maxKm || km(c.at, bias) <= maxKm);
  if (anyAirport) return bias ? [...reach].sort((x, y) => km(x.at, bias) - km(y.at, bias))[0] : reach[0];
  if (AIRPORT_RX.test(q)) return reach[0];
  const near = reach.filter(c => similar(q, c.name)), top = near[0];
  const exact = near.filter(c => c.name === norm(q)).sort((x, y) => rank(y) - rank(x));  // biggest first
  if (shortened) return exact.find(c => rank(c) >= 5);  // "Paris" of "Paris Gare Lyon": only a town of that name
  const ref = bias || top?.at;
  const better = exact.filter(c => rank(c) > rank(top) || (rank(c) === rank(top) && km(c.at, ref) <= km(top.at, ref) + 50));
  // the biggest when that is a real town; among villages and hamlets the nearest (San Andrés next to Valverde)
  return (better[0] && rank(better[0]) >= 4 ? better[0] : better.sort((x, y) => km(x.at, ref) - km(y.at, ref))[0]) || top;
}

// A day in Transitous' timetable window (about a year ahead) with the trip's weekday and clock time: the track of a
// past trip is looked up on the same weekday next week.
function planTime(date, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(date || '');
  if (!m) return null;
  let d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const soon = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 2);
  if (d < soon || d > soon + 300 * 864e5) {
    const t = new Date(soon + ((d.getUTCDay() - new Date(soon).getUTCDay() + 7) % 7) * 864e5);
    d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), +m[4], +m[5]));
  }
  return d.toISOString().slice(0, 16) + ':00Z';  // local clock time read as UTC: a few hours off is fine
}

async function transitous(a, b, mode, date) {
  const time = planTime(date);
  if (!TRANSIT_MODES[mode] || !time) return null;
  return timetableTrack(a, b, mode, time, true);
}

async function timetableTrack(a, b, mode, time, fill) {
  const p = new URLSearchParams({
    fromPlace: `${a[0]},${a[1]}`, toPlace: `${b[0]},${b[1]}`, time, transitModes: TRANSIT_MODES[mode],
    numItineraries: '1', maxItineraries: '3', maxPreTransitTime: '1800', maxPostTransitTime: '1800'
  });
  const d = await getJSON(`${TRANSITOUS}?${p}`);
  for (const it of d.itineraries || []) {
    let pts = (it.legs || []).filter(l => !NOT_TRANSIT.has(l.mode) && l.legGeometry)
      .flatMap(l => decode(l.legGeometry.points, l.legGeometry.precision || 6));
    if (fill && mode !== 'ferry') pts = await fillGaps(pts, mode, time);
    if (plausible(pts, a, b) && (mode === 'ferry' || !gappy(pts))) return pts;
  }
  return null;
}

// A leg the timetable has no track for (a regional line in the middle of a long journey) leaves a straight
// jump between the legs around it: each jump over GAP_KM (a few at most) is looked up on its own, and its track put in
// when one is found
const GAP_KM = 20, GAPS = 3;
async function fillGaps(pts, mode, time) {
  const out = pts.slice(0, 1);
  let tries = 0;
  for (let i = 1; i < pts.length; i++) {
    if (km(pts[i - 1], pts[i]) > GAP_KM && tries++ < GAPS) {
      const piece = await timetableTrack(pts[i - 1], pts[i], mode, time, false);
      if (piece) out.push(...piece);
    }
    out.push(pts[i]);
  }
  return out;
}

// The likeliest railway line between two places (BRouter's rail profile on OpenStreetMap's tracks): a best guess for
// trains no timetable Cairn can ask knows (Ukraine, India), drawn like a timetable's track
async function railGuess(a, b) {
  const d = await getJSON(`${BROUTER}?lonlats=${a[1]},${a[0]}|${b[1]},${b[0]}&profile=rail&alternativeidx=0&format=geojson`);  // busy: the lookups pause
  const pts = (d?.features?.[0]?.geometry?.coordinates || []).map(([lon, lat]) => [lat, lon]);
  return plausible(pts, a, b) ? pts : null;
}

// A long one in pieces (BRouter's public server gives up after 8 seconds): the road route's stations about every
// LEG_STEP_KM, and the railway between each two of them
const LEG_STEP_KM = 150;
async function railGuessLong(a, b) {
  const road = await osrmPoints(a, b);
  if (!road) return null;
  const samples = [];
  let run = 0;
  for (let i = 1; i < road.length; i++) {
    run += km(road[i - 1], road[i]);
    if (run >= LEG_STEP_KM && km(road[i], b) > LEG_STEP_KM / 2) { samples.push(road[i]); run = 0; }
  }
  // from station to station: at each sample the first of the stations around it the railway reaches (a station off
  // the main lines, a museum railway, is passed over); a sample with none is skipped
  const pts = [];
  let prev = a;
  for (const p of samples) {
    for (const st of (await placesNear('railway:station', p, 3)).filter(x => km(x, p) < 30)) {
      const leg = await railPiece(prev, st, 1);
      if (leg) { pts.push(...leg); prev = st; break; }
    }
  }
  const last = await railPiece(prev, b, 2);
  if (!last) return null;
  pts.push(...last);
  return plausible(pts, a, b) ? pts : null;
}

// one piece; one that fails is split at the station halfway, at most `depth` times
async function railPiece(a, b, depth) {
  const pts = await railGuess(a, b);
  if (pts || !depth) return pts;
  const mid = await nearestOf('railway:station', [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  if (!mid || km(mid, a) < 10 || km(mid, b) < 10) return null;
  const first = await railPiece(a, mid, depth - 1), second = first && await railPiece(mid, b, depth - 1);
  return first && second ? [...first, ...second] : null;
}

// The railway between two stations on OpenStreetMap's tracks, worked out here: the main lines (no sidings, yards or
// industrial spurs) within about RAIL_KM of the road between them (from Overpass, once; wider when they do not connect: at
// RAIL_MAIN_KM the main lines alone, as a railway can run far from the road), and
// the shortest way along them from the track nearest one end to the track nearest the other. Without BRouter: its
// public server turns Cairn away.
const RAIL_KM = [25, 60, 150], RAIL_MAIN_KM = 150, RAIL_BRIDGES = 3, RAIL_OLD = '2014', RAIL_DETOUR = 1.5, RAIL_END_KM = 10, RAIL_SAMPLE_KM = 40, RAIL_BOXES = 3;
const railCache = new Map();
// each piece Overpass gave, kept on disk (setRailCache: a folder), so a lookup cut short goes on from where it was
let railDir = null;
const setRailCache = dir => { railDir = dir; };
function keptPiece(q) {
  if (!railDir) return null;
  try { return JSON.parse(require('fs').readFileSync(require('path').join(railDir, require('crypto').createHash('sha1').update(q).digest('hex') + '.json'), 'utf8')); } catch (_) { return null; }
}
function keepPiece(q, elements) {
  if (!railDir) return;
  const fs = require('fs');
  fs.mkdirSync(railDir, { recursive: true });
  fs.writeFileSync(require('path').join(railDir, require('crypto').createHash('sha1').update(q).digest('hex') + '.json'), JSON.stringify(elements));
}
const railRest = new Map();  // after Overpass failed on a train: until when its railway guess waits (the other trains go on)
const RAIL_REST_MS = 5 * 60e3;  // a few minutes: Overpass is slow at busy times, but most of its answers come
async function railOverpass(a, b, old = false) {
  const key = [...a, ...b].map(x => x.toFixed(2)).join(',') + (old ? '|old' : '');
  if (railCache.has(key)) return railCache.get(key);
  if ((railRest.get(key) || 0) > Date.now()) throw new Error('overpass: resting after a failure');
  // along the road, or the straight line every RAIL_SAMPLE_KM: when there is no road (OSRM busy), or it goes far round
  // (more than RAIL_DETOUR times the way: round by another border crossing, those on the way being closed)
  const steps = Math.ceil(km(a, b) / 10);
  const straight = Array.from({ length: steps + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps]);
  const byRoad = await osrmPoints(a, b), road = byRoad && pathKm(byRoad) <= RAIL_DETOUR * km(a, b) ? byRoad : straight;
  const line = [road[0]];
  let run = 0;
  for (let i = 1; i < road.length; i++) {
    run += km(road[i - 1], road[i]);
    if (run >= RAIL_SAMPLE_KM || i === road.length - 1) { line.push(road[i]); run = 0; }
  }
  // a piece of Overpass' answer: kept on disk, else asked for (the second server when the first fails)
  const piece = async q => {
    const kept = keptPiece(q);
    if (kept) return kept;
    let d = null;
    for (const [j, host] of OVERPASS.entries()) {
      try { d = await getJSON(`${host}?data=${encodeURIComponent(q)}`); break; } catch (e) {
        if (j === OVERPASS.length - 1) { railRest.set(key, Date.now() + RAIL_REST_MS); throw new Error(`overpass: ${e.message}`); }
      }
    }
    if (d.remark) throw new Error(`overpass: ${d.remark}`);  // cut off (timeout, memory): not a piece to keep
    keepPiece(q, d.elements || []);
    return d.elements || [];
  };
  const rails = (bb, which, kind = 'rail') => `way["railway"="${kind}"]${which}(${bb});`, LINES = '[!"service"]["usage"!~"industrial|military|tourism"]';
  let pts = null;
  const elements = [];  // every corridor's tracks together
  const add = list => { for (const e of list) elements.push(e); };  // (one by one: a piece of the Ruhr's is too many to spread)
  for (const r of RAIL_KM) {
    // a box around each stretch of the road, widened by r (Overpass finds what lies in boxes quickly, near a line slowly)
    const pad = r / 111, boxes = line.slice(1).map((p, i) => {
      const q = line[i], wide = pad / Math.cos(p[0] * Math.PI / 180);
      return [Math.min(p[0], q[0]) - pad, Math.min(p[1], q[1]) - wide, Math.max(p[0], q[0]) + pad, Math.max(p[1], q[1]) + wide].map(x => x.toFixed(3)).join(',');
    });
    // in pieces of RAIL_BOXES boxes (about 120 km): one query for a long way is too much for Overpass at a busy time
    const which = r >= RAIL_MAIN_KM ? '["usage"="main"]' : LINES;  // the widest: main lines only
    // a train of before 2014 (old) also on the main lines closed since (cut by a war or at a border)
    const lines = bb => rails(bb, which) + (old ? rails(bb, '["usage"="main"]', 'disused') : '');
    const ask = list => piece(`[out:json][timeout:240];(${list.map(lines).join('')});(._;>;);out skel qt;`);
    for (let i = 0; i < boxes.length; i += RAIL_BOXES) {
      const some = boxes.slice(i, i + RAIL_BOXES);
      try {
        add(await ask(some));
      } catch (e) {  // too much for Overpass at once (the Ruhr's tracks): each box alone
        if (some.length === 1 || !/overpass/.test(e.message)) throw e;
        railRest.delete(key);
        for (const bb of some) add(await ask([bb]));
      }
    }
    pts = shortestRail(elements, a, b);
    if (pts) break;
  }
  // still two networks that do not meet (a main line marked disused since, used by the trains of years before; lines
  // joined only by a station's sidings): every track in a box around where they come closest, sidings and disused lines
  // too, at most RAIL_BRIDGES times
  for (let k = 0; !pts && k < RAIL_BRIDGES; k++) {
    const gap = railGap(elements, a, b);
    if (!gap || gap.km > 150) break;
    const [p, q] = gap.ends, pad = 0.2;
    const bb = [Math.min(p[0], q[0]) - pad, Math.min(p[1], q[1]) - pad * 1.5, Math.max(p[0], q[0]) + pad, Math.max(p[1], q[1]) + pad * 1.5].map(x => x.toFixed(3)).join(',');
    add(await piece(`[out:json][timeout:240];(${rails(bb, '')}${rails(bb, '[!"service"]', 'disused')});(._;>;);out skel qt;`));
    pts = shortestRail(elements, a, b);
  }
  pts = pts && plausible(pts, a, b) ? pts : null;
  railCache.set(key, pts);
  return pts;
}

// The tracks as a graph: each node's position and neighbours (with the km between), and the size of the network
// (connected part) each node is in
function railGraph(elements) {
  const at = new Map(), next = new Map();
  for (const e of elements) if (e.type === 'node') at.set(e.id, [e.lat, e.lon]);
  const link = (x, y, w) => { if (!next.has(x)) next.set(x, []); next.get(x).push([y, w]); };
  for (const e of elements) {
    if (e.type !== 'way') continue;
    for (let i = 1; i < e.nodes.length; i++) {
      const p = at.get(e.nodes[i - 1]), q = at.get(e.nodes[i]);
      if (!p || !q) continue;
      const w = km(p, q);
      link(e.nodes[i - 1], e.nodes[i], w); link(e.nodes[i], e.nodes[i - 1], w);
    }
  }
  const part = new Map(), size = [];
  for (const id of next.keys()) {
    if (part.has(id)) continue;
    const n = size.length, stack = [id];
    part.set(id, n); size.push(0);
    while (stack.length) {
      size[n]++;
      for (const [m] of next.get(stack.pop())) if (!part.has(m)) { part.set(m, n); stack.push(m); }
    }
  }
  return { at, next, part, size };
}

// The few nodes nearest a place (within RAIL_END_KM), on a network of some size when there is one near: a station's
// own tracks are yards and sidings, left out, which leaves bits of line near it that lead nowhere
const RAIL_NET = 500;
function railEnds({ at, next, part, size }, c, n = 5) {
  const near = [...next.keys()].map(id => [id, km(at.get(id), c)]).filter(([, d]) => d < RAIL_END_KM).sort((x, y) => x[1] - y[1]);
  const big = near.filter(([id]) => size[part.get(id)] >= RAIL_NET);
  return (big.length ? big : near).slice(0, n);
}

// Dijkstra over the tracks' nodes, from the few nodes nearest a to the first of those nearest b
function shortestRail(elements, a, b) {
  const graph = railGraph(elements), { at, next } = graph;
  const starts = railEnds(graph, a), ends = new Map(railEnds(graph, b));
  if (!starts.length || !ends.size) return null;
  const dist = new Map(), prev = new Map(), heap = [];
  const push = (id, d) => {
    heap.push([d, id]);
    for (let i = heap.length - 1; i > 0;) { const j = (i - 1) >> 1; if (heap[j][0] <= heap[i][0]) break; [heap[i], heap[j]] = [heap[j], heap[i]]; i = j; }
  };
  const pop = () => {
    const top = heap[0], end = heap.pop();
    if (heap.length) {
      heap[0] = end;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]]; i = m;
      }
    }
    return top;
  };
  for (const [id, d] of starts) { dist.set(id, d); push(id, d); }
  let best = null, bestCost = Infinity;
  while (heap.length) {
    const [d, id] = pop();
    if (d > (dist.get(id) ?? Infinity) || d >= bestCost) continue;
    if (ends.has(id) && d + ends.get(id) < bestCost) { best = id; bestCost = d + ends.get(id); }
    for (const [n, w] of next.get(id) || []) {
      if (d + w < (dist.get(n) ?? Infinity)) { dist.set(n, d + w); prev.set(n, id); push(n, d + w); }
    }
  }
  if (best == null) return null;
  const path = [];
  for (let id = best; id != null; id = prev.get(id)) path.push(at.get(id));
  return [a, ...path.reverse(), b];
}

// Where the network reached from a and the one reached from b come closest: { km, ends: [on a's side, on b's side] }
function railGap(elements, a, b) {
  const graph = railGraph(elements), { at, part } = graph;
  const [sa] = railEnds(graph, a, 1), [sb] = railEnds(graph, b, 1);
  if (!sa || !sb) return null;
  const pa = part.get(sa[0]), pb = part.get(sb[0]);
  if (pa === pb) return null;
  const from = [], to = [];
  for (const [id, n] of part) { if (n === pa) from.push(at.get(id)); else if (n === pb) to.push(at.get(id)); }
  // a few thousand points a side are enough to find the spot; flat distances to compare (cheap), the true one for it
  const thin = list => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / 3000)) === 0);
  const cos = Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180), some = thin(to);
  let best = null, d2 = Infinity;
  for (const p of thin(from)) for (const q of some) {
    const dy = p[0] - q[0], dx = (p[1] - q[1]) * cos, e = dy * dy + dx * dx;
    if (e < d2) d2 = e, best = [p, q];
  }
  return best && { km: km(...best), ends: best };
}

async function osrmPoints(a, b) {
  const d = await getJSON(`${OSRM}${a[1]},${a[0]};${b[1]},${b[0]}?overview=simplified&geometries=polyline6`);
  return d?.code === 'Ok' && d.routes?.[0] ? decode(d.routes[0].geometry, 6) : null;
}

// A car journey's likeliest road: through the places your photos (and Timeline) put you on the way. Of the clues
// ([lat, lon] in time order, from leaving until arriving), those that lie roughly between the two ends (a detour of
// at most DETOUR), at least VIA_KM from the ends and from each other, at most VIA_MAX of them, evenly spread
const VIA_KM = 10, VIA_MAX = 20, DETOUR = 1.5;
function viaPoints(a, b, clues) {
  const direct = km(a, b), out = [];
  for (const p of clues) {
    if (km(p, a) < VIA_KM || km(p, b) < VIA_KM || km(a, p) + km(p, b) > direct * DETOUR + 30) continue;
    if (out.length && km(out[out.length - 1], p) < VIA_KM) continue;
    out.push(p);
  }
  return out.length > VIA_MAX ? Array.from({ length: VIA_MAX }, (_, i) => out[Math.round(i * (out.length - 1) / (VIA_MAX - 1))]) : out;
}

// A drive with its times known: through all the places its photos put you, in time order, however far off the straight
// line (a loop round a region, or out and back to the same town), VIA_KM apart, at most TRACK_MAX of them
const TRACK_MAX = 30;
// the hours from leaving to arriving (both local times: a drive across a time zone is an hour off), or null when the
// drive knows only its day (noon, no arrival): its photos are the whole day's, not the drive's
function driveHours(t) {
  const time = s => { const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d)/.exec(s || ''); return m ? Date.parse(`${m[1]}T${m[2]}:00Z`) : null; };
  if (!t.arrival && /12:00:00$/.test(t.date || '')) return null;
  const a = time(t.date), b = time(t.arrival);
  return a == null ? null : b > a ? (b - a) / 36e5 : 24;  // no arrival: a day's driving at most
}
function trackPoints(a, b, clues) {
  const out = [];
  for (const p of clues) {
    if (km(p, a) < VIA_KM || km(p, b) < VIA_KM || (out.length && km(out[out.length - 1], p) < VIA_KM)) continue;
    out.push(p);
  }
  return out.length > TRACK_MAX ? Array.from({ length: TRACK_MAX }, (_, i) => out[Math.round(i * (out.length - 1) / (TRACK_MAX - 1))]) : out;
}
// the road through them, when it is like the line through them (no long ways round a closed border) and can be driven
// in the hours the journey took (with some to spare)
async function osrmTrack(pts, hours) {
  const d = await getJSON(`${OSRM}${pts.map(p => `${p[1]},${p[0]}`).join(';')}?overview=full&geometries=polyline6`);
  const r = d.code === 'Ok' && d.routes?.[0], path = r ? decode(r.geometry, 6) : [];
  if (path.length < 2 || km(path[0], pts[0]) > 30 || km(path[path.length - 1], pts[pts.length - 1]) > 30) return null;
  if (pathKm(path) > 2.2 * pathKm(pts) + 30 || (hours && r.duration / 3600 > hours * 1.3 + 1)) return null;
  return path;
}

async function osrmVia(pts) {
  const d = await getJSON(`${OSRM}${pts.map(p => `${p[1]},${p[0]}`).join(';')}?overview=full&geometries=polyline6`);
  const path = d.code === 'Ok' && d.routes?.[0] ? decode(d.routes[0].geometry, 6) : [];
  return plausible(path, pts[0], pts[pts.length - 1]) ? path : null;
}

// Along the roads through stops you named (a drive back via Valjevo): only its ends are checked, as a way round is
// what was asked for
async function osrmStops(pts) {
  const d = await getJSON(`${OSRM}${pts.map(p => `${p[1]},${p[0]}`).join(';')}?overview=full&geometries=polyline6`);
  const path = d.code === 'Ok' && d.routes?.[0] ? decode(d.routes[0].geometry, 6) : [];
  return path.length > 1 && km(path[0], pts[0]) < 30 && km(path[path.length - 1], pts[pts.length - 1]) < 30 ? path : null;
}

// The places of the stops a trip names (stops: ["Valjevo"]), each looked up near the one before it: stops_at, in order
async function placeStops(trip) {
  const a = at(trip, 'from'), b = at(trip, 'to'), out = [];
  let prev = a;
  for (const name of trip.stops) {
    const p = await geocode(name, prev, Math.max(150, km(a, b)));
    if (p) out.push(p), prev = p;
  }
  trip.stops_at = out;
}

async function osrm(a, b) {
  const d = await getJSON(`${OSRM}${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=polyline6`);
  const pts = d.code === 'Ok' && d.routes?.[0] ? decode(d.routes[0].geometry, 6) : [];
  return plausible(pts, a, b) ? pts : null;
}

// A ferry's ports: of the ferry terminals within PORT_KM of each end (and nearer to it than to the other end: an
// island's search also finds the next island's), the two closest to each other, a little nearer to their places
// counting too (Tenerife to La Gomera: Los Cristianos to San Sebastián, not Santa Cruz); null when an end has none
// An end with no terminal Cairn can find (Sal, Karpathos: none tagged on the map) takes the coast instead: the
// points of the coastline around it (setCoast: Natural Earth's closed coastlines, each an island or a land), the
// smallest one it lies in, so never the next island's coast.
const PORT_KM = 60;
let coastRings = () => [];
const setCoast = f => { coastRings = f; };
function inside(pt, ring) {  // ring: [[lon, lat], ...]
  let yes = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[0]) !== (yj > pt[0]) && pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi) yes = !yes;
  }
  return yes;
}
function coastNear(at) {
  const ring = (coastRings() || []).filter(r => at[0] >= r.box[1] && at[0] <= r.box[3] && at[1] >= r.box[0] && at[1] <= r.box[2] && inside(at, r.pts))
    .sort((a, b) => a.pts.length - b.pts.length)[0];
  return ring ? ring.pts.map(([lon, lat]) => [lat, lon]).filter(p => km(p, at) <= PORT_KM) : [];
}
async function ports(a, b) {
  const near = async end => { const t = await placesNear('amenity:ferry_terminal', end, 10, PORT_KM); return t.length ? t : coastNear(end); };
  return bestPorts(await near(a), await near(b), a, b);
}
// Of the terminals near each end, the pair with the shortest way: the crossing and the way from each place to its port
// (the next islands' ports are near each other, but far from the places: Naxos to Ios is not Koufonisia to Schinoussa)
function bestPorts(as, bs, a, b) {
  const mine = (list, end, other) => list.filter(p => km(p, end) < km(p, other));
  let best = null, score = Infinity;
  for (const pa of mine(as, a, b)) for (const pb of mine(bs, b, a)) {
    const sc = km(pa, pb) + km(pa, a) + km(pb, b);
    if (sc < score) { score = sc; best = [pa, pb]; }
  }
  return best;
}

// A ferry with no timetable track: the ferry lines OpenStreetMap maps, as OSRM's car route takes them between the two
// ports; only an answer that crosses by ferry, and of it the part from the first ferry to the last (not the drive to
// the port). Most ferries are in no timetable Cairn can ask.
async function seaRoute(a, b) {
  const d = await getJSON(`${OSRM}${a[1]},${a[0]};${b[1]},${b[0]}?overview=false&steps=true&geometries=polyline6`);
  const steps = d.code === 'Ok' ? d.routes?.[0]?.legs?.[0]?.steps || [] : [];
  const first = steps.findIndex(x => x.mode === 'ferry'), last = steps.map(x => x.mode).lastIndexOf('ferry');
  if (first < 0) return null;
  const pts = steps.slice(first, last + 1).flatMap(x => decode(x.geometry, 6));
  return pts.length > 1 && km(pts[0], a) < FERRY_PORT_KM && km(pts[pts.length - 1], b) < FERRY_PORT_KM && pathKm(pts) < 2.2 * km(a, b) + 30 ? pts : null;
}

// A binary heap of [key, value], the smallest key first (the shortest-way searches)
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a;
    a.push([k, v]);
    for (let i = a.length - 1; i && a[(i - 1) >> 1][0] > a[i][0]; i = (i - 1) >> 1) [a[i], a[(i - 1) >> 1]] = [a[(i - 1) >> 1], a[i]];
  }
  pop() {
    const a = this.a, top = a[0], end = a.pop();
    if (a.length) {
      a[0] = end;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top[1];
  }
}

// A ferry along the ferry lines OpenStreetMap maps (route=ferry: the ships' own, not only those cars can take, as
// OSRM's), the shortest way over them from a line's end near one port to one near the other (FERRY_PORT_KM), with
// the lines' ends within FERRY_JOIN_KM of each other joined (a port where one line ends and the next begins); null
// when they do not reach (then the way through the water). Overpass' answers are kept on disk, as the railways'.
const FERRY_PORT_KM = 5, FERRY_JOIN_KM = 1;
async function ferryLines(a, b) {
  const pad = Math.max(0.3, 0.3 * Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])));
  const bb = [Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad].map(x => x.toFixed(2)).join(',');
  const q = `[out:json][timeout:120];way["route"="ferry"](${bb});(._;>;);out skel qt;`;
  let elements = keptPiece(q);
  if (!elements) {
    let d = null;
    for (const [j, host] of OVERPASS.entries()) {
      try { d = await getJSON(`${host}?data=${encodeURIComponent(q)}`); break; } catch (e) { if (j === OVERPASS.length - 1) throw new Error(`overpass: ${e.message}`); }
    }
    if (d.remark) throw new Error(`overpass: ${d.remark}`);
    elements = d.elements || [];
    keepPiece(q, elements);
  }
  const at = new Map(elements.filter(e => e.type === 'node').map(e => [e.id, [e.lat, e.lon]]));
  const edges = new Map(), link = (x, y) => {
    const w = km(at.get(x), at.get(y));
    if (!edges.has(x)) edges.set(x, []);
    if (!edges.has(y)) edges.set(y, []);
    edges.get(x).push([y, w]); edges.get(y).push([x, w]);
  };
  const ends = [];
  for (const w of elements.filter(e => e.type === 'way')) {
    const ns = w.nodes.filter(n => at.has(n));
    for (let i = 1; i < ns.length; i++) link(ns[i - 1], ns[i]);
    if (ns.length > 1) ends.push(ns[0], ns[ns.length - 1]);
  }
  for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
    if (ends[i] !== ends[j] && km(at.get(ends[i]), at.get(ends[j])) <= FERRY_JOIN_KM) link(ends[i], ends[j]);
  }
  // Dijkstra from the nodes near a (starting at their distance from it) to the nearest finish near b
  const dist = new Map(), prev = new Map(), done = new Set(), todo = new Heap();
  for (const [id, p] of at) if (edges.has(id) && km(p, a) <= FERRY_PORT_KM) { dist.set(id, km(p, a)); todo.push(km(p, a), id); }
  let best = null, bestKm = Infinity;
  while (todo.size) {
    const id = todo.pop();
    if (done.has(id)) continue;
    done.add(id);
    const d = dist.get(id), toB = km(at.get(id), b);
    if (d >= bestKm) break;
    if (toB <= FERRY_PORT_KM && d + toB < bestKm) { bestKm = d + toB; best = id; }
    for (const [n, w] of edges.get(id) || []) {
      if (!done.has(n) && d + w < (dist.get(n) ?? Infinity)) { dist.set(n, d + w); prev.set(n, id); todo.push(d + w, n); }
    }
  }
  if (best == null || bestKm > 1.8 * km(a, b) + 15) return null;  // not a chain of other crossings far round
  const path = [];
  for (let id = best; id != null; id = prev.get(id)) path.push(at.get(id));
  return [a, ...path.reverse(), b];
}

// A ferry with no line mapped: the shortest way through the water between its ports, round the coasts (Natural
// Earth's coastlines, setCoast) on a grid of about WATER_CELLS cells a side over the two and some sea around them;
// null without the coastlines or a way. The ports' own cells count as water (a coarse coastline puts a pier ashore).
const WATER_CELLS = 160;
async function waterRoute(a, b) {
  const rings = coastRings() || [];
  if (!rings.length) return null;
  const pad = Math.max(0.3, 0.4 * Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])));
  const box = [Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad];
  const step = Math.max(0.005, Math.max(box[2] - box[0], box[3] - box[1]) / WATER_CELLS);
  const rows = Math.ceil((box[2] - box[0]) / step) + 1, cols = Math.ceil((box[3] - box[1]) / step) + 1;
  const lat = r => box[0] + r * step, lon = c => box[1] + c * step;
  // land: for each row, where the coastlines cross its latitude; a cell is ashore with an odd number of them east of it
  const near = rings.filter(r => r.box[1] <= box[2] && r.box[3] >= box[0] && r.box[0] <= box[3] && r.box[2] >= box[1]);
  const land = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const y = lat(r), xs = [];
    for (const ring of near) {
      if (y < ring.box[1] || y > ring.box[3]) continue;
      const pts = ring.pts;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y)) xs.push((xj - xi) * (y - yi) / (yj - yi) + xi);
      }
    }
    xs.sort((p, q) => p - q);
    for (let c = 0, k = 0; c < cols; c++) {
      const x = lon(c);
      while (k < xs.length && xs[k] <= x) k++;
      if ((xs.length - k) % 2 === 1) land[r * cols + c] = 1;
    }
  }
  const cell = p => [Math.round((p[0] - box[0]) / step), Math.round((p[1] - box[1]) / step)];
  const [s0, s1] = [cell(a), cell(b)], start = s0[0] * cols + s0[1], goal = s1[0] * cols + s1[1];
  for (const [r, c] of [s0, s1]) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) land[rr * cols + cc] = 0;
  }
  // A* over the water cells, eight ways round, by km
  const kmOf = i => [lat(Math.floor(i / cols)), lon(i % cols)];
  const g = new Float64Array(rows * cols).fill(Infinity), from = new Int32Array(rows * cols).fill(-1), done = new Uint8Array(rows * cols);
  const heap = new Heap();
  heap.push(km(kmOf(start), b), start);
  g[start] = 0;
  while (heap.size) {
    const i = heap.pop();
    if (done[i]) continue;
    done[i] = 1;
    if (i === goal) break;
    const r = Math.floor(i / cols), c = i % cols, here = kmOf(i);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc, j = rr * cols + cc;
      if ((!dr && !dc) || rr < 0 || rr >= rows || cc < 0 || cc >= cols || land[j] || done[j]) continue;
      const cost = g[i] + km(here, kmOf(j));
      if (cost < g[j]) { g[j] = cost; from[j] = i; heap.push(cost + km(kmOf(j), b), j); }
    }
  }
  if (!done[goal]) return null;
  const path = [];
  for (let i = goal; i >= 0; i = from[i]) path.push(kmOf(i));
  path.reverse();
  path[0] = a, path[path.length - 1] = b;
  return simplify(path, step / 2);
}

// A ferry's line from its port to its port: a mapped ferry line that starts or ends off them (another pier, a line that
// stops at the island before) is joined to them
function toPorts(pts, a, b) {
  const out = [...pts];
  if (km(out[0], a) > 0.3) out.unshift(a);
  if (km(out[out.length - 1], b) > 0.3) out.push(b);
  return out;
}

// --- trips ---

const at = (t, end) => t[`${end}_lat`] != null ? [t[`${end}_lat`], t[`${end}_lon`]] : null;

// Where the traveller was just before this trip: the last flight or trip that ended in the NEAR_DAYS before it
function startNear(trip, flights, trips, airports) {
  const from = new Date(new Date(trip.date.slice(0, 10)).getTime() - NEAR_DAYS * 864e5).toISOString().slice(0, 10);
  let best = null;
  for (const f of flights) {
    const ap = airports[f.to];
    if (ap && f.date < trip.date && f.date >= from && (!best || f.date > best.date)) best = { date: f.date, at: [ap.lat, ap.lon] };
  }
  for (const t of trips) {
    const p = at(t, 'to');
    if (t !== trip && p && t.date < trip.date && t.date >= from && (!best || t.date > best.date)) best = { date: t.date, at: p };
  }
  return best && best.at;
}

// known(name): the biggest town of that name Cairn knows (GeoNames: { lat, lon, pop }), or null. A town of 100,000 or
// more is the one meant (Paris, not Paris in Tennessee; Skopje, not a farm of that name near the trip before) unless
// it is an ocean away from the trip before; a smaller one only within SMALL_KM of that trip (a village near the border
// crossed, not a bigger town of that name across the sea). Then the name is looked up near it.
const KNOWN_KM = 40, BIG_TOWN = 100000, FAR_KM = 3000, SMALL_KM = 1000;  // not even a big town an ocean away (Santiago de Chile for Cape Verde's)
async function nearKnown(name, near, known) {
  const t = known((name || '').replace(/\s*\(.*?\)/g, '').split('/')[0].trim());
  if (!t || (near && km([t.lat, t.lon], near) > (t.pop < BIG_TOWN ? SMALL_KM : FAR_KM))) return null;
  return await geocode(name, [t.lat, t.lon], KNOWN_KM) || [t.lat, t.lon];
}

async function place(trip, flights, trips, airports, known = () => null) {
  const near = startNear(trip, flights, trips, airports);
  let a = at(trip, 'from'), b = at(trip, 'to');
  if (!a) a = await nearKnown(trip.from, near, known) || await geocode(trip.from, near, near ? START_KM : null);  // with no trip just before: the best known place
  if (!b) b = await nearKnown(trip.to, a || near, known) || await geocode(trip.to, a || near, a || near ? LEG_KM : null);
  if (!b && !at(trip, 'from')) {  // no destination near the departure: the departure may be a namesake, trust the destination
    b = await geocode(trip.to, null, null);
    if (b) a = await geocode(trip.from, b, LEG_KM);
  } else if (!a && b) a = await geocode(trip.from, b, LEG_KM);
  if (a) [trip.from_lat, trip.from_lon] = a;
  if (b) [trip.to_lat, trip.to_lon] = b;
  if (!a || !b) trip.unplaced = true;
}

// A trip with no track from where its ends were placed (a town's middle, too far to walk to its station) is tried
// again from the nearest station or port at each end
const STATION_TAGS = { train: 'railway:station', bus: 'amenity:bus_station', ferry: 'amenity:ferry_terminal' };
const ROUTE_VERSION = 10;  // straight lines from before the station retry, the railway guess and the ferry lines are tried once more

async function route(trip, clues = null) {
  if (trip.mode === 'ferry' && !trip.ports) {  // from port to port, not between the middles of the places
    const pr = await ports(at(trip, 'from'), at(trip, 'to'));
    if (pr) [[trip.from_lat, trip.from_lon], [trip.to_lat, trip.to_lon]] = pr;
    trip.ports = !!pr;
  }
  const a = at(trip, 'from'), b = at(trip, 'to');
  let pts = await transitous(a, b, trip.mode, trip.date), source = 'transitous', sa = null, sb = null;
  if (!pts && STATION_TAGS[trip.mode]) {
    [sa, sb] = [await nearestOf(STATION_TAGS[trip.mode], a), await nearestOf(STATION_TAGS[trip.mode], b)];
    if (!(sa && sb && km(sa, a) < 15 && km(sb, b) < 15)) sa = sb = null;
    if (sa) pts = await transitous(sa, sb, trip.mode, trip.date);
  }
  if (!pts && trip.stops_at?.length && ['bus', 'hitch', 'drive'].includes(trip.mode)) {  // through the stops you named
    pts = await osrmStops([a, ...trip.stops_at, b]);
    if (pts) source = 'stops';
  }
  if (!pts && trip.mode === 'drive' && clues) {  // by car: through where your photos put you on the way
    const seen = clues(trip, a, b), hours = driveHours(trip), track = hours ? trackPoints(a, b, seen) : [];
    if (track.length) { pts = await osrmTrack([a, ...track, b], hours); if (pts) source = 'clues', trip.via = track.length; }
    const via = pts ? [] : viaPoints(a, b, seen);  // only its day known, or no road like the photos' line: those near the way
    if (via.length) { pts = await osrmVia([a, ...via, b]); if (pts) source = 'clues', trip.via = via.length; }
  }
  if (!pts && ['bus', 'hitch', 'drive'].includes(trip.mode)) pts = await osrm(a, b), source = 'osrm';  // hitchhiking and by car: along the roads
  if (!pts && trip.mode === 'ferry') pts = await ferryLines(a, b), source = 'ferry';  // the ships' lines OpenStreetMap maps
  if (!pts && trip.mode === 'ferry') pts = await seaRoute(a, b), source = 'sea';
  if (!pts && trip.mode === 'train') {  // from stations: BRouter starts on a track (the nearest may be a park railway: then the next)
    const [as, bs] = [await placesNear('railway:station', a, 3), await placesNear('railway:station', b, 3)];
    pts = await railOverpass(as[0] && km(as[0], a) < 15 ? as[0] : a, bs[0] && km(bs[0], b) < 15 ? bs[0] : b, (trip.date || '') < RAIL_OLD);
    const pairs = [[0, 0], [1, 1], [0, 1], [1, 0], [2, 2]].filter(([i, j]) => as[i] && bs[j] && km(as[i], a) < 15 && km(bs[j], b) < 15);
    try {  // else BRouter, when it answers; when it does not, Overpass' "no railway" stands: the road for now (tried again later)
      for (const [i, j] of pairs) if (!pts) pts = await railGuess(as[i], bs[j]);
      if (!pts) pts = await railGuess(a, b);
      if (!pts && km(a, b) > LEG_STEP_KM) pts = await railGuessLong(as[0] || a, bs[0] || b);
    } catch (e) {
      if (!/brouter\.de/.test(e.message)) throw e;
    }
    source = 'rail';
  }
  if (!pts && trip.mode === 'train') pts = await osrm(a, b), source = 'road';  // no railway found: along the roads, a guess
  if (!pts && trip.mode === 'ferry') pts = await waterRoute(a, b), source = 'water';  // no ferry line known: through the water
  if (!pts && trip.mode === 'ferry') pts = [a, b], source = 'direct';  // ferries mostly go straight across: drawn so
  if (pts && trip.mode === 'ferry') pts = toPorts(pts, a, b);
  if (pts) {
    trip.path = encode(simplify(pts));
    trip.distance = Math.round(pathKm(pts));
  } else {
    trip.path = '';
    trip.distance = Math.round(km(a, b));
    source = 'straight';
    trip.route_v = ROUTE_VERSION;
  }
  trip.path_source = source;
}

// Where a hotel, Airbnb or rental car pick-up is: "Gradsko, North Macedonia", near the traveller's last arrival
// Where a stay is: near where the rest of your data (flights, trains, photos, activities, Timeline: `seen`, points
// [lat, lon] on its days) puts you then; with none of that, near your last arrival before it; else the biggest place of
// that name ("Beijing" the city, not a village called Beijing).
async function placeStay(stay, flights, trips, airports, seen = []) {
  const ap = /^[A-Z]{3}$/.test(stay.place || '') && airports[stay.place];  // a car picked up at an airport, by its code
  if (ap) { [stay.lat, stay.lon] = [ap.lat, ap.lon]; return; }
  const name = stay.country ? `${stay.place}, ${stay.country}` : stay.place;
  // English names first: trip docs and booking mails say "Lisbon" and "Naples", which Photon's own names ("Lisboa",
  // "Napoli") do not match, leaving Lisbon, Iowa and Naples, Florida
  const look = async (bias, maxKm) => await geocode(name, bias, maxKm, 'en') || await geocode(name, bias, maxKm);
  const there = seen.length ? seen[Math.floor(seen.length / 2)] : null;
  const near = startNear({ date: `${stay.start} 12:00:00` }, flights, trips, airports);
  const p = (there && await look(there, STAY_KM)) || (!there && near && await look(near, START_KM)) || await look(null, null);
  // a campsite or an area the map does not know ("Noah Beach camping area"): where your data puts you then
  const at = p || there;
  if (at) [stay.lat, stay.lon] = at;
  else stay.unplaced = true;
}

// Look up every trip that still needs it, oldest first (so earlier trips give later ones their starting point),
// then every stay. A service that is down stops the pass; the next pass tries again.
// Returns { later: true } when some trips wait for BRouter or Overpass, which refused (tried again once they have
// rested; the other trips go on meanwhile), or when a service was down and the pass stopped
const FAILS_IN_A_ROW = 3;
async function enrich(store, log = console.log) {
  const todo = [...store.trips].sort((x, y) => (x.date || '').localeCompare(y.date || ''));
  let later = false, failed = 0;
  for (const trip of todo) {
    if (!store.trips.includes(trip)) continue;  // deleted meanwhile
    try {
      if ((!at(trip, 'from') || !at(trip, 'to')) && !trip.unplaced) {
        await place(trip, store.flights(), store.trips, store.airports(), store.known);
        if (trip.unplaced) log(`[ground] could not place ${trip.date} ${trip.from} - ${trip.to}`);
        store.save();
      }
      if (at(trip, 'from') && at(trip, 'to') && trip.stops?.length && !trip.stops_at) {
        await placeStops(trip);
        if (trip.stops_at.length < trip.stops.length) log(`[ground] could not place every stop of ${trip.date} ${trip.from} - ${trip.to}`);
        delete trip.path_source;  // its road again, through them
        store.save();
      }
      if (at(trip, 'from') && at(trip, 'to') && (!trip.path_source || (trip.path_source === 'straight' && (trip.route_v || 1) < ROUTE_VERSION)
        || (trip.mode === 'ferry' && trip.ports === undefined)  // ferries from before the ports: once more
        || (trip.path_source === 'road' && !(resting['brouter.de'] > Date.now()) && (trip.road_tries || 0) < 3))) {  // a train put on the road: the railway again, a few times
        if (trip.path_source === 'road') trip.road_tries = (trip.road_tries || 0) + 1;
        await route(trip, store.clues);
        store.save();
      }
    } catch (e) {
      if (/brouter\.de|overpass/.test(e.message)) {  // the railway guess: this train waits, the rest go on
        if (!later) log(`[ground] railway guesses wait: ${e.message}`);
        later = true;
        continue;
      }
      // a service slow or down for this trip: it waits for the next pass, the others go on; a service down for
      // FAILS_IN_A_ROW trips in a row stops the pass (the next in a while)
      later = true;
      log(`[ground] ${trip.date} ${trip.from} - ${trip.to} waits: ${e.message}`);
      if (++failed >= FAILS_IN_A_ROW) { log('[ground] lookups paused'); return { later }; }
      continue;
    }
    failed = 0;
  }
  for (const stay of [...(store.stays || [])]) {
    if (stay.lat != null || stay.unplaced || !store.stays.includes(stay)) continue;
    try {
      await placeStay(stay, store.flights(), store.trips, store.airports(), store.seen ? store.seen(stay.start, stay.end || stay.start) : []);
      if (stay.unplaced) log(`[ground] could not place stay ${stay.start} ${stay.place}`);
      store.saveStays();
    } catch (e) {
      log(`[ground] lookups paused: ${e.message}`);
      return { later: true };  // a service down: the pass again in a while
    }
  }
  return { later };
}

// A stay whose place changes is looked up again
// A stay's place changed: where it is is looked up again. Only its country: the same, unless the spot already lies in
// that country (inCountry(lat, lon, country): the name put right, as a region's name to its country's code)
function forgetStay(stay, changes, inCountry = () => false) {
  if ('lat' in changes) return;
  const changed = k => k in changes && changes[k] !== stay[k];
  if (changed('place') || (changed('country') && !(stay.lat != null && inCountry(stay.lat, stay.lon, changes.country)))) {
    delete stay.lat, delete stay.lon, delete stay.unplaced;
  }
}

// Fields a change of station (or of its coordinates) makes stale
function forget(trip, changes) {
  for (const end of ['from', 'to']) {
    const renamed = end in changes && changes[end] !== trip[end];
    if (renamed && !(`${end}_lat` in changes)) delete trip[`${end}_lat`], delete trip[`${end}_lon`];
  }
  if ('stops' in changes && JSON.stringify(changes.stops || []) !== JSON.stringify(trip.stops || [])) delete trip.stops_at;
  const moved = ['from', 'to', 'from_lat', 'from_lon', 'to_lat', 'to_lon', 'mode', 'date']
    .some(k => k in changes && changes[k] !== trip[k]) || ('stops' in changes && !trip.stops_at);
  if (moved) delete trip.unplaced, delete trip.path, delete trip.path_source, delete trip.route_v, delete trip.ports, delete trip.via;
}

// A bike route through the points ([lat, lon], in order) along OpenStreetMap's roads and paths: { path, km }, or null
async function bikeRoute(points) {
  const r = await getJSON(BIKE + points.map(p => `${(+p[1]).toFixed(5)},${(+p[0]).toFixed(5)}`).join(';') + '?overview=full&geometries=geojson');
  const route = r.routes?.[0];
  return route ? { path: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]), km: route.distance / 1000 } : null;
}

module.exports = { ROUTE_VERSION, bestPorts, waterRoute, toPorts, ferryLines, setRailCache, shortestRail, railGap, railOverpass, viaPoints, trackPoints, driveHours, bikeRoute, setCoast, km, decode, encode, simplify, plausible, gappy, planTime, startNear, forget, forgetStay, enrich, pick, similar, geocode, placeStay };
