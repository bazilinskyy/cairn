'use strict';
// Ground trips (trains, buses, ferries) for the map: where their stations are and the track between them; and where
// stays and rental cars are. Places come from Photon (OpenStreetMap), biased towards where the traveller was just
// before; tracks from Transitous (timetabled trains and coaches) or OSRM (roads, for buses), else a straight line.
// Each trip or stay is looked up once, in the background, and the result is kept in it.

const UA = 'contrail (personal travel log; https://github.com/bazilinskyy/contrail)';
const PHOTON = 'https://photon.komoot.io/api/';
const PHOTON_REVERSE = 'https://photon.komoot.io/reverse';
const TRANSITOUS = 'https://api.transitous.org/api/v5/plan';
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
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
  return pts.length > 1 && km(pts[0], a) < 30 && km(pts[pts.length - 1], b) < 30 && pathKm(pts) < 2.2 * direct + 30;
}

// --- services ---

const last = {};
async function getJSON(url) {
  const host = new URL(url).host;  // at most one request a second per service
  const wait = (last[host] || 0) + 1100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last[host] = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (res.status === 429 || res.status >= 500) throw new Error(`${host}: HTTP ${res.status}`);
  return res.json();
}

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

async function geocode(name, bias, maxKm, lang = '') {
  const bare = BARE.find(([rx]) => rx.test((name || '').trim()));
  if (bare) return bias ? nearestOf(bare[1], bias) : null;  // with nothing to be near, any "Port" would be a guess
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
  const p = new URLSearchParams({
    fromPlace: `${a[0]},${a[1]}`, toPlace: `${b[0]},${b[1]}`, time, transitModes: TRANSIT_MODES[mode],
    numItineraries: '1', maxItineraries: '3', maxPreTransitTime: '1800', maxPostTransitTime: '1800'
  });
  const d = await getJSON(`${TRANSITOUS}?${p}`);
  for (const it of d.itineraries || []) {
    const pts = (it.legs || []).filter(l => !NOT_TRANSIT.has(l.mode) && l.legGeometry)
      .flatMap(l => decode(l.legGeometry.points, l.legGeometry.precision || 6));
    if (plausible(pts, a, b)) return pts;
  }
  return null;
}

async function osrm(a, b) {
  const d = await getJSON(`${OSRM}${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=polyline6`);
  const pts = d.code === 'Ok' && d.routes?.[0] ? decode(d.routes[0].geometry, 6) : [];
  return plausible(pts, a, b) ? pts : null;
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

async function place(trip, flights, trips, airports) {
  const near = startNear(trip, flights, trips, airports);
  let a = at(trip, 'from'), b = at(trip, 'to');
  if (!a) a = await geocode(trip.from, near, near ? START_KM : null);  // with no trip just before: the best known place
  if (!b) b = await geocode(trip.to, a || near, a || near ? LEG_KM : null);
  if (!b && !at(trip, 'from')) {  // no destination near the departure: the departure may be a namesake, trust the destination
    b = await geocode(trip.to, null, null);
    if (b) a = await geocode(trip.from, b, LEG_KM);
  } else if (!a && b) a = await geocode(trip.from, b, LEG_KM);
  if (a) [trip.from_lat, trip.from_lon] = a;
  if (b) [trip.to_lat, trip.to_lon] = b;
  if (!a || !b) trip.unplaced = true;
}

async function route(trip) {
  const a = at(trip, 'from'), b = at(trip, 'to');
  let pts = await transitous(a, b, trip.mode, trip.date), source = 'transitous';
  if (!pts && trip.mode === 'bus') pts = await osrm(a, b), source = 'osrm';
  if (pts) {
    trip.path = encode(simplify(pts));
    trip.distance = Math.round(pathKm(pts));
  } else {
    trip.path = '';
    trip.distance = Math.round(km(a, b));
    source = 'straight';
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
async function enrich(store, log = console.log) {
  const todo = [...store.trips].sort((x, y) => (x.date || '').localeCompare(y.date || ''));
  for (const trip of todo) {
    if (!store.trips.includes(trip)) continue;  // deleted meanwhile
    try {
      if ((!at(trip, 'from') || !at(trip, 'to')) && !trip.unplaced) {
        await place(trip, store.flights(), store.trips, store.airports());
        if (trip.unplaced) log(`[ground] could not place ${trip.date} ${trip.from} - ${trip.to}`);
        store.save();
      }
      if (at(trip, 'from') && at(trip, 'to') && !trip.path_source) {
        await route(trip);
        store.save();
      }
    } catch (e) {
      log(`[ground] lookups paused: ${e.message}`);
      return;
    }
  }
  for (const stay of [...(store.stays || [])]) {
    if (stay.lat != null || stay.unplaced || !store.stays.includes(stay)) continue;
    try {
      await placeStay(stay, store.flights(), store.trips, store.airports(), store.seen ? store.seen(stay.start, stay.end || stay.start) : []);
      if (stay.unplaced) log(`[ground] could not place stay ${stay.start} ${stay.place}`);
      store.saveStays();
    } catch (e) {
      log(`[ground] lookups paused: ${e.message}`);
      return;
    }
  }
}

// A stay whose place changes is looked up again
function forgetStay(stay, changes) {
  if (['place', 'country'].some(k => k in changes && changes[k] !== stay[k]) && !('lat' in changes)) {
    delete stay.lat, delete stay.lon, delete stay.unplaced;
  }
}

// Fields a change of station (or of its coordinates) makes stale
function forget(trip, changes) {
  for (const end of ['from', 'to']) {
    const renamed = end in changes && changes[end] !== trip[end];
    if (renamed && !(`${end}_lat` in changes)) delete trip[`${end}_lat`], delete trip[`${end}_lon`];
  }
  const moved = ['from', 'to', 'from_lat', 'from_lon', 'to_lat', 'to_lon', 'mode', 'date']
    .some(k => k in changes && changes[k] !== trip[k]);
  if (moved) delete trip.unplaced, delete trip.path, delete trip.path_source;
}

module.exports = { km, decode, encode, simplify, plausible, planTime, startNear, forget, forgetStay, enrich, pick, similar, geocode, placeStay };
