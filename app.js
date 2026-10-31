'use strict';
process.env.PWD = process.cwd();

const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { randomBytes, createHmac } = require('crypto');
const ground = require('./ground');
const stravaSync = require('./strava');
const activitySources = require('./activities');
const cities = require('./cities');
const regionLists = require('./regions');
const zlib = require('zlib');

// --- Config & Secret ---

function loadJSON(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    console.error(`[error] ${label} not found: ${filePath}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[error] ${label} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

const defaults = loadJSON(path.join(__dirname, 'default.config'), 'default.config');
const overrides = loadJSON(path.join(__dirname, 'config'), 'config');
const config = { ...defaults, ...overrides };

const secret = loadJSON(path.join(__dirname, 'secret'), 'secret');

const DATA_DIR      = path.join(__dirname, config.data_dir);
// tripmail's section of config and secret (called flightmail before, which still works)
const mailSection = c => ({ ...(c?.flightmail || {}), ...(c?.tripmail || {}) });
const homeAirports = () => mailSection(config).home_airports || ['AMS', 'EIN', 'RTM'];
const AIRPORTS_FILE = path.join(__dirname, config.airports_file);
const FLIGHTS_FILE  = path.join(__dirname, config.flights_file);
const GROUND_FILE   = path.join(__dirname, config.ground_file);
const STAYS_FILE    = path.join(__dirname, config.stays_file);
const PHOTOS_FILE   = path.join(__dirname, config.photos_file);
const TIMELINE_FILE = path.join(__dirname, config.timeline_file);
const GARMIN_FILE   = path.join(__dirname, config.garmin_file);

// Strava: the keys are read from secret each time, so adding them needs no restart
const strava = stravaSync.create({
  tokenFile: path.join(__dirname, config.strava_token_file), dataFile: path.join(__dirname, config.strava_file),
  redirectUri: `http://localhost:${config.port}/auth/strava/callback`,
  keys() {
    let s = secret;  // what was read at startup, while the file is being edited
    try { s = JSON.parse(fs.readFileSync(path.join(__dirname, 'secret'), 'utf8')); } catch (_) {}
    return { id: String(s.strava_client_id || ''), secret: s.strava_client_secret || '' };
  }
});
const AIRPORTS_URL  = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat';

// --- In-memory stores ---

let airports = {}; // IATA -> {name, city, country, lat, lon}
let flights  = [];
let trips    = []; // trains, buses and ferries (ground.js)
let stays    = []; // hotels, Airbnbs and rental cars

// --- Helpers ---

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}


function parseCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; }
    else if (c === ',' && !inQuote) { fields.push(cur); cur = ''; }
    else { cur += c; }
  }
  fields.push(cur);
  return fields;
}

function parseAirports(dat) {
  const result = {};
  for (const line of dat.split('\n')) {
    if (!line.trim()) continue;
    const f = parseCSVLine(line);
    if (f.length < 8) continue;
    const iata = f[4].replace(/"/g, '').trim();
    if (!iata || iata === '\\N' || iata === '-') continue;
    result[iata] = {
      name:    f[1].replace(/"/g, '').trim(),
      city:    f[2].replace(/"/g, '').trim(),
      country: f[3].replace(/"/g, '').trim(),
      lat:     parseFloat(f[6]),
      lon:     parseFloat(f[7]),
      tz:      (f[11] || '').replace(/"/g, '').trim()
    };
  }
  return result;
}

function parseFlightsCSV(csv) {
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  return lines.slice(1).map((line, idx) => {
    if (!line.trim()) return null;
    const f = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (f[i] || '').trim(); });
    return {
      id:            idx + 1,
      date:          obj['date'] || '',
      from:          obj['from'] || '',
      to:            obj['to'] || '',
      flight_number: obj['flight_number'] || '',
      airline:       obj['airline'] || '',
      // openflights CSV exports distance in statute miles; convert to km
      distance:      Math.round((parseInt(obj['distance']) || 0) * 1.60934),
      duration:      obj['duration'] || '',
      seat:          obj['seat'] || '',
      seat_type:     obj['seat_type'] || '',
      class:         obj['class'] || '',
      reason:        obj['reason'] || '',
      plane:         obj['plane'] || '',
      registration:  obj['registration'] || '',
      trip:          obj['trip'] || '',
      note:          obj['note'] || ''
    };
  }).filter(Boolean);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// bumped on every save: what is worked out from the data (placesAndDays) is worked out again
let dataVersion = 0;
function saveFlights() {
  fs.writeFileSync(FLIGHTS_FILE, JSON.stringify(flights, null, 2));
  dataVersion++;
}

function nextId(list = flights) {
  return list.reduce((max, f) => Math.max(max, f.id || 0), 0) + 1;
}

function saveTrips() {
  fs.writeFileSync(GROUND_FILE, JSON.stringify(trips, null, 2));
  dataVersion++;
}

function saveStays() {
  fs.writeFileSync(STAYS_FILE, JSON.stringify(stays, null, 2));
  dataVersion++;
}

// Booking codes of stays you deleted (a cancelled booking, a plan that did not happen): a mail sending one again, such as
// the history import, does not bring it back. Next to the stays file, as <name>.removed.json.
const REMOVED_FILE = STAYS_FILE.replace(/(\.json)?$/, '.removed.json');
let removedStays = new Set();
try { removedStays = new Set(JSON.parse(fs.readFileSync(REMOVED_FILE, 'utf8'))); } catch (_) {}
function removeStayCode(code) {
  if (!code) return;
  removedStays.add(code);
  fs.writeFileSync(REMOVED_FILE, JSON.stringify([...removedStays], null, 2));
}

// A file an import script wrote (photos, Timeline), read again when it changes; [] or {} when there is none
const imported = {};
function readImport(file, empty) {
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (imported[file]?.mtime !== mtime) imported[file] = { mtime, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
    return imported[file].data;
  } catch (_) {  // no such file: the same empty value each time, so what is worked out from it is kept (one per shape asked)
    if (imported[file]?.mtime !== 'missing') imported[file] = { mtime: 'missing', empties: {} };
    const shape = JSON.stringify(empty);
    return imported[file].empties[shape] ??= empty;
  }
}

// Places and tracks of new ground trips and places of stays, one pass at a time, when ground_lookups is on
let lookingUp = false, lookAgain = false;
// Where your photos and Timeline put you during a car journey, in time order (ground.js routes it through them): from
// leaving until arriving, or with no arrival time as long as the road would take and two hours more; a journey that
// knows only its day (noon, no arrival) the whole day. Up to the first one at the far end.
function journeyClues(t, a, b) {
  const unix = (s, lon) => { const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d)/.exec(s || ''); return m ? Date.parse(`${m[1]}T${m[2]}:00Z`) / 1000 - Math.round(lon / 15) * 3600 : null; };
  const dayOnly = !t.arrival && /12:00:00$/.test(t.date || ''), start = unix(dayOnly ? `${t.date.slice(0, 10)} 00:00` : t.date, a[1]);
  if (start == null) return [];
  const end = t.arrival ? unix(t.arrival, b[1]) : start + (dayOnly ? 30 : ground.km(a, b) / 50 + 2) * 3600;
  const flying = flyingSpans().filter(([off, on]) => on > start && off < end);  // a flight home after the drive: its photos are no road
  const seen = ownPlacePhotos().filter(p => p[1] >= start && p[1] <= end && !flying.some(([off, on]) => p[1] > off && p[1] < on)).map(p => [p[1], p[2], p[3]]);
  (readImport(TIMELINE_FILE, {}).visits || []).forEach(v => { const s = unix(v.start, v.lon); if (s >= start && s <= end) seen.push([s, v.lat, v.lon]); });
  // nor one too far from the last to have been driven to (over 200 km/h: a flight with no times, its photos the plane's)
  const out = [];
  let last = [start, ...a];
  for (const [t, lat, lon] of seen.sort((x, y) => x[0] - y[0])) {
    if (ground.km([lat, lon], last.slice(1)) > 200 * Math.max(t - last[0], 60) / 3600) continue;
    out.push([lat, lon]);
    last = [t, lat, lon];
    if (ground.km([lat, lon], b) < 10) break;
  }
  return out;
}

function lookUpTrips() {
  if (!config.ground_lookups) return;
  if (lookingUp) { lookAgain = true; return; }
  lookingUp = true;
  // seen: where everything but the stays puts you on those days, to place a stay by
  const seen = (from, to) => placesAndDays(from, to, { stays: false }).map(p => p.at);
  loadTowns();
  const known = name => (towns ? cities.biggestNamed(towns, name) : null);
  const store = { trips, stays, flights: () => flights, airports: () => airports, save: saveTrips, saveStays, seen, known, clues: journeyClues };
  ground.enrich(store).then(r => { if (r?.later) setTimeout(lookUpTrips, 6 * 60e3).unref(); })  // trains waiting for Overpass or BRouter
    .catch(e => console.warn('[ground]', e.message)).finally(() => {
    lookingUp = false;
    if (lookAgain) { lookAgain = false; lookUpTrips(); }
  });
}

// --- AeroDataBox lookup ---

function lookupFlightAPI(flightNumber, date) {
  const fn = flightNumber.replace(/\s+/g, '').toUpperCase();
  const options = {
    hostname: 'aerodatabox.p.rapidapi.com',
    path: `/flights/number/${fn}/${date}`,
    method: 'GET',
    headers: {
      'x-rapidapi-key':  secret.rapidapi_key,
      'x-rapidapi-host': 'aerodatabox.p.rapidapi.com'
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!Array.isArray(json) || json.length === 0) return reject(new Error('Flight not found'));
          const f = json[0];
          const fromIata = f.departure?.airport?.iata || '';
          const toIata   = f.arrival?.airport?.iata   || '';

          let distance = Math.round(f.greatCircleDistance?.km || 0);
          if (!distance && airports[fromIata] && airports[toIata]) {
            const a = airports[fromIata], b = airports[toIata];
            distance = haversine(a.lat, a.lon, b.lat, b.lon);
          }

          let duration = '';
          const depTime = f.departure?.scheduledTime?.utc || f.departure?.scheduledTime?.local;
          const arrTime = f.arrival?.scheduledTime?.utc   || f.arrival?.scheduledTime?.local;
          if (depTime && arrTime) {
            const mins = Math.round((new Date(arrTime) - new Date(depTime)) / 60000);
            const h = Math.floor(Math.abs(mins) / 60);
            const m = Math.abs(mins) % 60;
            duration = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          }

          resolve({
            from:           fromIata,
            to:             toIata,
            airline:        f.airline?.name  || '',
            plane:          f.aircraft?.model || '',
            distance,
            duration,
            departure_time: f.departure?.scheduledTime?.local || '',
            arrival_time:   f.arrival?.scheduledTime?.local   || ''
          });
        } catch (e) {
          reject(new Error('Failed to parse API response: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// --- Startup ---

async function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(AIRPORTS_FILE)) {
    console.log('[init] Downloading airports.dat from OpenFlights...');
    try {
      const dat = await httpsGet(AIRPORTS_URL);
      fs.writeFileSync(AIRPORTS_FILE, dat);
      console.log('[init] airports.dat saved');
    } catch (e) {
      console.warn('[warn] Could not download airports.dat:', e.message);
    }
  }

  if (fs.existsSync(AIRPORTS_FILE)) {
    airports = parseAirports(fs.readFileSync(AIRPORTS_FILE, 'utf8'));
    console.log(`[init] Loaded ${Object.keys(airports).length} airports`);
  }

  if (fs.existsSync(FLIGHTS_FILE)) {
    flights = JSON.parse(fs.readFileSync(FLIGHTS_FILE, 'utf8'));
    console.log(`[init] Loaded ${flights.length} flights from ${config.flights_file}`);
  } else {
    const csvFile = path.join(__dirname, config.csv_backup);
    if (fs.existsSync(csvFile)) {
      console.log('[init] Importing flights from CSV backup...');
      flights = parseFlightsCSV(fs.readFileSync(csvFile, 'utf8'));
      // Fill in missing distances using airport coordinates
      flights.forEach(f => {
        if (!f.distance && airports[f.from] && airports[f.to]) {
          const a = airports[f.from], b = airports[f.to];
          f.distance = haversine(a.lat, a.lon, b.lat, b.lon);
        }
      });
      saveFlights();
      console.log(`[init] Imported and saved ${flights.length} flights`);
    } else {
      console.log('[init] No CSV backup found — starting with empty flight list');
    }
  }

  if (fs.existsSync(GROUND_FILE)) {
    trips = JSON.parse(fs.readFileSync(GROUND_FILE, 'utf8'));
    console.log(`[init] Loaded ${trips.length} ground trips from ${config.ground_file}`);
  }
  if (fs.existsSync(STAYS_FILE)) {
    stays = JSON.parse(fs.readFileSync(STAYS_FILE, 'utf8'));
    console.log(`[init] Loaded ${stays.length} stays and rental cars from ${config.stays_file}`);
  }
}

// --- Express ---

const app = express();
// Who may ask. Cairn has no login: it listens on this computer only (config.host), and answers only requests for its
// own names (not for a site whose name was pointed at 127.0.0.1 to read your data: DNS rebinding); config.hosts adds
// names (a reverse proxy's). Another site's page in your browser may not change anything nor read through Cairn (CSRF):
// only following a link to Cairn from elsewhere is let through (a Strava sign-in coming back). Nor may another site
// show Cairn in a frame (clicks made for you there). Other sites are told only Cairn's address, not its pages: the
// OpenStreetMap tile servers refuse requests without a Referer.
const HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', ...(config.hosts || [])].map(h => String(h).toLowerCase()));
const hostOf = h => String(h || '').toLowerCase().replace(/:\d+$/, '');
const foreignOrigin = o => { try { return !HOSTS.has(hostOf(new URL(o).host)); } catch (_) { return true; } };
app.use((req, res, next) => {
  if (!HOSTS.has(hostOf(req.headers.host))) return res.status(403).type('text').send('Cairn answers only for this computer');
  const site = req.headers['sec-fetch-site'], origin = req.headers.origin;
  const foreign = site === 'cross-site' || (origin != null && foreignOrigin(origin));
  const followed = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate';
  if (foreign && !followed) return res.status(403).type('text').send('Not from another site');
  res.set({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/flights', (_req, res) => {
  res.json(flights);
});

app.get('/api/airports', (_req, res) => {
  const used = new Set(flights.flatMap(f => [f.from, f.to]).filter(Boolean));
  const result = {};
  used.forEach(iata => { if (airports[iata]) result[iata] = airports[iata]; });
  res.json(result);
});

app.post('/api/flights/lookup', async (req, res) => {
  const { flight_number, date } = req.body;
  if (!flight_number || !date) return res.status(400).json({ error: 'flight_number and date required' });
  if (!secret.rapidapi_key) return res.status(503).json({ error: 'No RapidAPI key in secret file' });
  try {
    const result = await lookupFlightAPI(flight_number, date);
    res.json(result);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// What a flight, a trip or a stay sent from the browser or an import may hold: airport codes as codes, dates as dates,
// a known way of travel; other fields text or numbers (what is shown is escaped too, but nothing odd is kept)
const WHEN = /^\d{4}-\d\d-\d\d( \d\d:\d\d(:\d\d)?)?$/, DAY = /^\d{4}-\d\d-\d\d$/, CODE = /^[A-Z0-9]{3,4}$/;
const RULES = {
  flight: { from: CODE, to: CODE, date: WHEN, arrival: WHEN },
  ground: { date: WHEN, arrival: WHEN, mode: /^(train|bus|ferry|hitch|drive)$/ },
  stay: { start: DAY, end: DAY, what: /^(stay|car)$/ }
};
function badField(kind, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'a JSON object is needed';
  for (const [k, v] of Object.entries(body)) {
    const rule = RULES[kind][k];
    if (rule && v != null && v !== '' && !(typeof v === 'string' && rule.test(v))) return `${k} is not valid`;
    if (v != null && typeof v === 'object' && !(k === 'stops' && Array.isArray(v) && v.every(x => typeof x === 'string'))) return `${k} must be text or a number`;
  }
  return null;
}

app.post('/api/flights', (req, res) => {
  const f = req.body, bad = badField('flight', f);
  if (bad) return res.status(400).json({ error: bad });
  if (!f.from || !f.to || !f.date) return res.status(400).json({ error: 'from, to, and date are required' });
  if (!f.distance && airports[f.from] && airports[f.to]) {
    const a = airports[f.from], b = airports[f.to];
    f.distance = haversine(a.lat, a.lon, b.lat, b.lon);
  }
  f.id = nextId();
  flights.unshift(f);
  saveFlights();
  res.json(f);
});

app.put('/api/flights/:id', (req, res) => {
  const f = flights.find(x => x.id === Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'no such flight' });
  const bad = badField('flight', req.body);
  if (bad) return res.status(400).json({ error: bad });
  const { id, ...changes } = req.body;
  const moved = ('from' in changes && changes.from !== f.from) || ('to' in changes && changes.to !== f.to);
  Object.assign(f, changes);
  if (moved && !('distance' in changes) && airports[f.from] && airports[f.to]) {
    const a = airports[f.from], b = airports[f.to];
    f.distance = haversine(a.lat, a.lon, b.lat, b.lon);
  }
  saveFlights();
  res.json(f);
});

app.delete('/api/flights/:id', (req, res) => {
  const i = flights.findIndex(x => x.id === Number(req.params.id));
  if (i < 0) return res.status(404).json({ error: 'no such flight' });
  const [f] = flights.splice(i, 1);
  saveFlights();
  res.json({ deleted: f.id });
});

// --- Ground trips (trains, buses, ferries) ---

const { stayKind, groundKind, commuteSince, sideTrip, awayNights, sleptNights } = require('./stats');

// each train between the towns you live and work in marked commute: true (stats.js), for the map
app.get('/api/ground', (_req, res) => {
  const home = homePlaces(), since = commuteSince(trips, home);
  res.json(trips.map(t => (groundKind(t, home, since) === 'commute' ? { ...t, commute: true } : t)));
});

// One trip per calendar event, and one per departure minute and mode: posting the same trip again updates it
app.post('/api/ground', (req, res) => {
  const t = req.body, bad = badField('ground', t);
  if (bad) return res.status(400).json({ error: bad });
  if (!t.mode || !t.from || !t.to || !t.date) return res.status(400).json({ error: 'mode, from, to and date are required' });
  // the same trip again: by its calendar event, the same departure minute, or the same towns that day within three
  // hours (a calendar's time and an email's, in two time zones); not for ones added by hand with only a year or a
  // month known: several trips can share it
  const town = n => (n || '').toLowerCase().replace(/\s*\(.*?\)/g, '').split(/[\s,-]+/)[0];
  const hours = (a, b) => Math.abs(Date.parse(a.replace(' ', 'T')) - Date.parse(b.replace(' ', 'T'))) / 36e5;
  const same = trips.find(x => (t.event_id && x.event_id === t.event_id)
    || (!t.approx && !x.approx && x.mode === t.mode && ((x.date || '').slice(0, 16) === t.date.slice(0, 16)
      || ((x.date || '').slice(0, 10) === t.date.slice(0, 10) && town(x.from) === town(t.from) && town(x.to) === town(t.to) && hours(x.date, t.date) <= 3))));
  if (same) {
    const { id, ...changes } = t;
    ground.forget(same, changes);
    Object.assign(same, changes);
    saveTrips();
    lookUpTrips();
    return res.json(same);
  }
  t.id = nextId(trips);
  trips.push(t);
  saveTrips();
  lookUpTrips();
  res.json(t);
});

// The car journeys' roads again (after new photos or Timeline came in): { mode: 'drive' } by default; { ids: [..] }
// those trips
app.post('/api/ground/reroute', (req, res) => {
  const { mode = 'drive', ids } = req.body || {};
  const again = trips.filter(t => (ids ? ids.includes(t.id) : t.mode === mode) && t.path_source);
  again.forEach(t => ground.forget(t, { from_lat: null }));
  saveTrips();
  lookUpTrips();
  res.json({ rerouting: again.length });
});

app.put('/api/ground/:id', (req, res) => {
  const t = trips.find(x => x.id === Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'no such trip' });
  const bad = badField('ground', req.body);
  if (bad) return res.status(400).json({ error: bad });
  const { id, ...changes } = req.body;
  ground.forget(t, changes);
  Object.assign(t, changes);
  saveTrips();
  lookUpTrips();
  res.json(t);
});

app.delete('/api/ground/:id', (req, res) => {
  const i = trips.findIndex(x => x.id === Number(req.params.id));
  if (i < 0) return res.status(404).json({ error: 'no such trip' });
  const [t] = trips.splice(i, 1);
  saveTrips();
  res.json({ deleted: t.id });
});

// --- Stays and rental cars (from tripmail), photos and Timeline (from the import scripts) ---

// each with its kind of bed (stats.js: Hostel, Friend's place, ...), for the map, and the nights spent away on side
// trips (stats.js awayNights)
app.get('/api/stays', (_req, res) => {
  const away = awayNights(stays);
  res.json(stays.map(s => (s.what === 'car' ? s : { ...s, kind: stayKind(s), ...(away.has(s) && { away: away.get(s).nights }) })));
});

// One per booking code: posting the same booking again updates it
app.post('/api/stays', (req, res) => {
  const s = req.body, bad = badField('stay', s);
  if (bad) return res.status(400).json({ error: bad });
  if (!s.code || !s.place || !s.start) return res.status(400).json({ error: 'code, place and start are required' });
  if (removedStays.has(s.code)) return res.json({ ignored: 'deleted before', code: s.code });
  const same = stays.find(x => x.code === s.code);
  // the same stay from Booking.com's data export (other numbers, same dates): it takes the mail's code and keeps its
  // hotel's position, which a mail does not give
  const exported = !same && stays.find(x => x.source === 'booking' && x.what === s.what && x.start === s.start && (x.end || '') === (s.end || ''));
  if (exported) {
    Object.assign(exported, { code: s.code, price: s.price || exported.price, type: s.type || exported.type });
    saveStays();
    return res.json(exported);
  }
  if (same) {
    const { id, ...changes } = s;
    if (same.source === 'booking') delete changes.place, delete changes.country;  // the hotel's place beats the mail's town
    ground.forgetStay(same, changes, inCountry);
    Object.assign(same, changes);
  } else {
    s.id = nextId(stays);
    stays.push(s);
  }
  saveStays();
  lookUpTrips();
  res.json(same || s);
});

// whether a spot lies in a country (a code, or its English name): the country of the town nearest it
let countryCodes = null;
function inCountry(lat, lon, country) {
  if (!countryCodes) {
    countryCodes = new Map();
    try {
      const dn = new Intl.DisplayNames(['en'], { type: 'region' });
      for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) { const cc = String.fromCharCode(a, b), name = dn.of(cc); if (name && name !== cc) countryCodes.set(name.toLowerCase(), cc); }
    } catch (_) {}
  }
  const c = String(country || '').trim(), cc = /^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : countryCodes.get(c.toLowerCase());
  if (!cc) return false;
  loadTowns();
  return !!towns && cities.townAt(towns, lat, lon)?.cc === cc;
}

app.put('/api/stays/:id', (req, res) => {
  const s = stays.find(x => x.id === Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'no such stay' });
  const bad = badField('stay', req.body);
  if (bad) return res.status(400).json({ error: bad });
  const { id, ...changes } = req.body;
  ground.forgetStay(s, changes, inCountry);
  Object.assign(s, changes);
  saveStays();
  lookUpTrips();
  res.json(s);
});

app.delete('/api/stays/:id', (req, res) => {
  const i = stays.findIndex(x => x.id === Number(req.params.id));
  if (i < 0) return res.status(404).json({ error: 'no such stay' });
  const [s] = stays.splice(i, 1);
  saveStays();
  removeStayCode(s.code);
  res.json({ deleted: s.id });
});

app.get('/api/photos', (_req, res) => res.json(readImport(PHOTOS_FILE, [])));

// Every photo with its place and time (photos.js): [[id, unix time, lat, lon, video 1/0]], gzipped, with an ETag
// the photo index, with the photos you placed by hand (#place-photos, below) and those of Google Photos albums that
// have no place of their own at the album's (albums.js)
const PHOTO_PLACES = path.join(DATA_DIR, 'photo_places.json'), PHOTO_UNPLACED = path.join(DATA_DIR, 'photo_unplaced.json');
let placedMemo = { places: null, albums: null, out: [] };
function placedPhotos() {
  const places = readImport(PHOTO_PLACES, {}), al = typeof albums !== 'undefined' ? albums.photoEntries() : [];
  if (placedMemo.places !== places || placedMemo.albums !== al) {
    // a photo placed here, by you or by itself, is not also at its album's place
    // (a 'c': placed by Cairn itself, a guess: not for what needs the exact spot, nor for placing more)
    placedMemo = { places, albums: al, out: [...Object.entries(places).map(([file, v]) => [v.t, v.lat, v.lon, file, v.auto ? 'c' : '']), ...al.filter(e => !places[e[3]])] };
  }
  return placedMemo.out;
}
const photoIndex = require('./photos').create({ file: path.join(DATA_DIR, 'photo_points.json'), cache: path.join(DATA_DIR, 'photo_cache'), readImport,
  extra: placedPhotos });
// the photos as each use wants them: with a date of their own (not only an album's year: those make no day), and with
// a place of their own (not their album's: for what needs the exact spot, the climbs and the photo suggestions)
const photosBy = test => { let seen = null, out = []; return () => { const l = photoIndex.list(); if (l !== seen) { seen = l; out = l.filter(test); } return out; }; };
const datedPhotos = photosBy(p => p[5] !== 'y'), ownPlacePhotos = photosBy(p => !p[5]);
app.get('/api/photos/points', (req, res) => {
  const { json, gz, etag } = photoIndex.payload();
  res.set({ ETag: etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', 'Content-Type': 'application/json' });
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return res.set('Content-Encoding', 'gzip').send(gz);
  res.send(json);
});
// one photo: a thumbnail (/thumb) or the whole of it (/full), from the file on this Mac
app.get('/api/photos/:id/:size(thumb|full)', async (req, res) => {
  const made = await (req.params.size === 'thumb' ? photoIndex.thumb(req.params.id) : photoIndex.full(req.params.id));
  if (!made) return res.status(404).json({ error: 'no such photo here (or it could not be converted)' });
  res.set('Cache-Control', 'max-age=604800').type(made.type).sendFile(made.file);
});

// --- Placing photos by hand (#place-photos): the library's photos with no place (data/photo_unplaced.json, from
// imports/photos.py --unplaced), placed in a town or at a spot on the map; kept in data/photo_places.json
// ({file: {lat, lon, t, name, at, written}}) and so on the map and in your days at once, and written into the Photos
// library itself in the background (imports/photos_place.py), one run at a time and never while another job drives
// Photos ---

const photoId = file => require('crypto').createHash('sha1').update(file).digest('hex').slice(0, 12);
let unplacedMemo = { raw: null, byId: new Map() };
function unplacedById() {
  const raw = readImport(PHOTO_UNPLACED, []);
  if (unplacedMemo.raw !== raw) unplacedMemo = { raw, byId: new Map(raw.map(r => [photoId(r[1]), r])) };
  return unplacedMemo.byId;
}
// A photo with no place taken within NEAR_MIN minutes of one with a place (a camera beside the phone): that one's
// spot, [lat, lon, minutes from it (+: the photo with the place was taken after)], else null
const NEAR_MIN = 30;
let nearMemo = { list: null, sorted: [] };
function nearSpot(t) {
  const list = ownPlacePhotos();
  if (nearMemo.list !== list) nearMemo = { list, sorted: list.filter(p => p[1]).sort((a, b) => a[1] - b[1]) };
  const g = nearMemo.sorted;
  if (!t || !g.length) return null;
  let lo = 0, hi = g.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (g[m][1] < t) lo = m + 1; else hi = m; }
  const best = [g[lo - 1], g[lo]].filter(Boolean).sort((a, b) => Math.abs(a[1] - t) - Math.abs(b[1] - t))[0];
  return Math.abs(best[1] - t) <= NEAR_MIN * 60 ? [best[2], best[3], Math.round((best[1] - t) / 60)] : null;
}
// Placing the rest without you (POST /api/photos/auto): each photo not placed yet, by what else puts you somewhere then.
// near: a photo with a place within NEAR_MIN (nearSpot); day: a day when all your places (flights, trips, stays,
// activities, other photos) lie within DAY_KM of one town, at that town; between: a day with none of them, between days
// at most NO_DATA_DAYS before and after spent in the same town (a week at home with no photo placed). A photo taken near
// midnight (UTC: the day may be the next or the one before where you were) needs that day to agree too. Travel days
// are left to you, and so are photos whose time is not when they were taken: one of BURST or more within an hour, or
// of a run of RUN or more each at most RUN_S seconds after the one before (a batch copied or uploaded at once, the
// time of that), in an album named for another year ("Rome 2011" photos dated 2012), or in one of photos posted
// again later (profile and cover pictures). [{ id, file, t, at: [lat, lon], name, how }]
const DAY_KM = 20, NO_DATA_DAYS = 3, MIDNIGHT_H = 3, BURST = 40, RUN = 10, RUN_S = 30;
const REPOSTED = /(profile pictures|cover photos|instagram photos|bitstrips photos|mobile uploads|timeline photos)$/i;
function autoPlaces() {
  // each day's town (as dayTownMap) and how far from it the day's places go, from places that are not guesses of this
  loadTowns();
  const places = readImport(PHOTO_PLACES, {}), mine = placesAndDays('', '').filter(p => !p.guess), count = new Map(), spread = new Map();
  mine.forEach(p => { const t = townOfAt(p.at, p.city); if (!t) return; const m = count.get(p.day) || new Map(); m.set(t, (m.get(t) || 0) + 1); count.set(p.day, m); });
  const where = new Map([...count].map(([d, m]) => [d, [...m].sort((x, y) => y[1] - x[1])[0][0]]));
  for (const p of mine) {
    const t = where.get(p.day);
    if (t) spread.set(p.day, Math.max(spread.get(p.day) || 0, ground.km([t.lat, t.lon], p.at)));
  }
  const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
  const oneTown = d => where.has(d) && spread.get(d) <= DAY_KM ? where.get(d) : null;
  const townOn = d => {
    if (where.has(d)) return oneTown(d);
    let before = null, after = null;
    for (let i = 1; i <= NO_DATA_DAYS && before === null; i++) if (where.has(addDays(d, -i))) before = oneTown(addDays(d, -i)) || false;
    for (let i = 1; i <= NO_DATA_DAYS && after === null; i++) if (where.has(addDays(d, i))) after = oneTown(addDays(d, i)) || false;
    return before && after && before.id === after.id ? { ...before, between: true } : null;
  };
  const all = [...unplacedById()].filter(([, [t, , , al]]) => t && !(al || []).some(a => /^To delete/.test(a)));
  const rows = all.filter(([, [, file]]) => !places[file]);
  const times = all.map(([, r]) => r[0]).sort((a, b) => a - b), burst = new Set();  // all of them, placed or not
  for (let i = 0, j = 0; j < times.length; j++) {
    while (times[j] - times[i] > 3600) i++;
    if (j - i + 1 >= BURST) for (let k = i; k <= j; k++) burst.add(times[k]);
  }
  for (let i = 0, j = 1; j <= times.length; j++) {
    if (j < times.length && times[j] - times[j - 1] <= RUN_S) continue;
    if (j - i >= RUN) for (let k = i; k < j; k++) burst.add(times[k]);
    i = j;
  }
  const otherYear = (t, al) => {
    const y = new Date(t * 1000).getUTCFullYear();
    return (al || []).some(a => { const named = (a.match(/\b(19|20)\d\d\b/g) || []).map(Number); return named.length && !named.includes(y); })
      || (al || []).some(a => REPOSTED.test(a));
  };
  const out = [];
  for (const [id, [t, file, , albumList]] of rows) {
    if (burst.has(t) || otherYear(t, albumList)) continue;
    const near = nearSpot(t);
    if (near) { out.push({ id, file, t, at: [near[0], near[1]], name: 'near a photo with a place', how: 'near' }); continue; }
    const day = new Date(t * 1000).toISOString().slice(0, 10), h = new Date(t * 1000).getUTCHours();
    const town = townOn(day);
    if (!town) continue;
    const edge = h < MIDNIGHT_H ? addDays(day, -1) : h >= 24 - MIDNIGHT_H ? addDays(day, 1) : null, other = edge && townOn(edge);
    if (edge && where.has(edge) && other?.id !== town.id) continue;
    out.push({ id, file, t, at: [town.lat, town.lon], name: town.name, how: town.between ? 'between' : 'day' });
  }
  return out;
}
app.get('/api/photos/auto', (req, res) => {
  const list = autoPlaces(), count = { near: 0, day: 0, between: 0 };
  if (req.query.list) return res.json(list.map(({ file, ...x }) => ({ ...x, albums: unplacedById().get(x.id)[3] || [] })));
  list.forEach(x => count[x.how]++);
  const places = readImport(PHOTO_PLACES, {});
  res.json({ ...count, total: list.length, placed: Object.values(places).filter(v => v.auto).length });
});
// places them all, marked auto (kept in Cairn: not written into Photos, a guess at the town); { undo: true } takes all
// the auto ones back
app.post('/api/photos/auto', (req, res) => {
  const places = { ...readImport(PHOTO_PLACES, {}) };
  let n = 0;
  if (req.body?.undo) for (const [f, v] of Object.entries(places)) { if (v.auto) { delete places[f]; n++; } }
  else for (const x of autoPlaces()) {
    places[x.file] = { lat: Math.round(x.at[0] * 1e6) / 1e6, lon: Math.round(x.at[1] * 1e6) / 1e6, t: x.t, name: x.name, at: new Date().toISOString(), auto: x.how };
    n++;
  }
  fs.writeFileSync(PHOTO_PLACES, JSON.stringify(places));
  res.json(req.body?.undo ? { removed: n } : { placed: n });
});
// [{ id, t, name, albums: [index], video, near }], the ones not placed yet, by time; the albums' names; and per day
// where Cairn has you that day (the town most of the day's places are in), to place a day's photos there in one go
app.get('/api/photos/unplaced', (_req, res) => {
  const places = readImport(PHOTO_PLACES, {}), names = [], index = new Map(), photos = [], days = {};
  const where = dayTownMap();
  for (const [id, [t, file, name, albumList, video]] of unplacedById()) {
    if (places[file] || (albumList || []).some(a => /^To delete/.test(a))) continue;  // nor the copies waiting to be deleted
    const albumIdx = (albumList || []).map(a => { if (!index.has(a)) { index.set(a, names.length); names.push(a); } return index.get(a); });
    photos.push({ id, t, name, albums: albumIdx, video: video ? 1 : 0, near: nearSpot(t) });
    const day = t ? new Date(t * 1000).toISOString().slice(0, 10) : '';
    if (day && !(day in days)) days[day] = where.get(day) || null;
  }
  photos.sort((a, b) => (a.t || 0) - (b.t || 0));
  res.json({ photos, albums: names, days, placed: Object.keys(places).length });
});
app.get('/api/photos/unplaced/:id/:size(thumb|full)', async (req, res) => {
  const row = unplacedById().get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such photo' });
  const made = await (req.params.size === 'thumb' ? photoIndex.thumbOfFile(row[1]) : photoIndex.fullOfFile(row[1]));
  if (!made) return res.status(404).json({ error: 'could not be converted' });
  res.set('Cache-Control', 'max-age=604800').type(made.type).sendFile(made.file);
});
// { ids, lat, lon, name }: these photos taken there (name: the town, or empty for a spot on the map); { ids, near: true }
// each at the spot of the photo with a place taken nearest in time (nearSpot; those with none are left); { ids, undo:
// true } takes the places back
app.post('/api/photos/place', (req, res) => {
  const { ids, lat, lon, name, near, undo } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
  if (!undo && !near && !(Number.isFinite(+lat) && Number.isFinite(+lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return res.status(400).json({ error: 'lat and lon required' });
  const places = { ...readImport(PHOTO_PLACES, {}) }, rows = unplacedById();
  let n = 0;
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) continue;
    if (undo) { if (places[row[1]]) { delete places[row[1]]; n++; } continue; }
    const at = near ? nearSpot(row[0]) : [+lat, +lon];
    if (!at) continue;
    places[row[1]] = { lat: Math.round(at[0] * 1e6) / 1e6, lon: Math.round(at[1] * 1e6) / 1e6, t: row[0], name: near ? 'near a photo with a place' : String(name || ''), at: new Date().toISOString() };
    n++;
  }
  fs.writeFileSync(PHOTO_PLACES, JSON.stringify(places));
  if (!undo) writePlacesSoon();
  res.json({ placed: undo ? 0 : n, removed: undo ? n : 0 });
});
// imports/photos_place.py, a while after the last change, one run at a time; a photo it set is marked written
let placesTimer = null, placesRunning = false;
let placesStatus = null;  // how the last write into Photos went, for the health page: { at, ok, error?, written? }
const placesFailed = error => {
  placesRunning = false;
  placesStatus = { at: Date.now(), ok: false, error };
  console.log(`[photos] could not write places into Photos: ${error}`);
  writePlacesSoon(3600e3);  // again in an hour
};
function writePlacesSoon(ms = 30000) {
  if (config.photos_write_back === false || process.platform !== 'darwin') return;
  clearTimeout(placesTimer);
  placesTimer = setTimeout(writePlaces, ms);
}
function writePlaces() {
  if (placesRunning) return writePlacesSoon();
  placesRunning = true;
  const uv = config.uv || path.join(require('os').homedir(), '.local/bin/uv');
  const child = require('child_process').spawn(uv, ['run', '-q', '--with', 'osxphotos', '--with', 'pyobjc<13', 'python', path.join(__dirname, 'imports', 'photos_place.py'), PHOTO_PLACES]);
  let out = '', err = '', failed = false;
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('error', e => { failed = true; placesFailed(e.message); });
  child.on('close', code => {
    if (failed) return;
    placesRunning = false;
    const done = new Set(), lines = out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return {}; } });
    if (code !== 0 && !lines.some(l => l.path || l.busy)) return placesFailed(err.trim().split('\n').pop() || `ended with code ${code}`);
    const bad = lines.filter(l => l.ok === false);
    if (lines.some(l => l.path)) placesStatus = bad.length ? { at: Date.now(), ok: false, error: `${bad.length} photo${bad.length > 1 ? 's' : ''} not written: ${bad[0].error}`, written: lines.length - bad.length }
      : { at: Date.now(), ok: true, written: lines.length };
    lines.forEach(l => { if (l.ok) done.add(l.path); });
    if (done.size) {
      const places = { ...readImport(PHOTO_PLACES, {}) };
      done.forEach(f => { if (places[f]) places[f] = { ...places[f], written: true }; });
      fs.writeFileSync(PHOTO_PLACES, JSON.stringify(places));
      console.log(`[photos] ${done.size} places written into Photos`);
    }
    if (lines.some(l => l.busy || l.ok === false)) writePlacesSoon(10 * 60000);  // Photos busy or a photo failed: later
  });
}
setTimeout(() => writePlacesSoon(60000), 0);  // what was left at the last stop
app.get('/api/timeline', (_req, res) => res.json(readImport(TIMELINE_FILE, { visits: [], paths: [] })));
// places you were at a known time from data downloads: Facebook, Instagram, VK, Maps reviews, Uber, Bolt
const CHECKINS_FILE = path.join(DATA_DIR, 'checkins.json');
// the check-ins, without the places you were tagged in that your other data says you were not at (see allPlacesAndDays)
app.get('/api/checkins', (_req, res) => { placesAndDays('', ''); res.json(readImport(CHECKINS_FILE, []).filter(c => !untrusted.has(c))); });

// --- Strava ---

// --- Sports activities: Garmin and Strava (activities.js) ---

const NO_GARMIN = { activities: [] };
const activities = activitySources.create({ garmin: () => readImport(GARMIN_FILE, NO_GARMIN), strava });

// Thousands of activities: gzipped, and nothing at all when the browser already has this version
app.get('/api/activities', (req, res) => {
  const { json, gz, etag } = activities.payload();
  res.set({ ETag: etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' });
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.type('json');
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return res.set('Content-Encoding', 'gzip').send(gz);
  res.send(json);
});
app.get('/api/activities/status', (_req, res) => res.json(activities.status()));

// Famous cycling climbs and which your rides went over (climbs.js); [] when there are no rides
const climbs = require('./climbs').create({
  activities: () => activities.list(), key: () => activities.payload().etag, file: path.join(DATA_DIR, 'climb_ascents.json'),
  profile: () => readImport(GARMIN_FILE, NO_GARMIN).profile, trackDir: path.join(DATA_DIR, 'tracks'), photos: ownPlacePhotos,
  towns: loadTowns
});
app.get('/api/climbs', (_req, res) => res.json(climbs.list()));
// A ride to a climb's top and back (a GPX file for the bike computer): ?from=lat,lon (a stay), &name= its name. The
// route is FOSSGIS's bicycle routing on OpenStreetMap; it does not know which side of the climb is the famous one
const bikeRoutes = new Map();
app.get('/api/climbs/:id/gpx', async (req, res) => {
  const c = climbs.list().find(x => x.id === req.params.id), from = String(req.query.from || '').split(',').map(Number);
  if (!c || from.length !== 2 || !from.every(Number.isFinite) || Math.abs(from[0]) > 90 || Math.abs(from[1]) > 180) return res.status(400).json({ error: 'climb and from=lat,lon needed' });
  if (ground.km(from, [c.lat, c.lon]) > 150) return res.status(400).json({ error: 'too far for a ride' });
  const key = `${c.id}|${from.map(n => n.toFixed(4)).join(',')}`;
  try {
    if (!bikeRoutes.has(key)) bikeRoutes.set(key, await ground.bikeRoute([from, [c.lat, c.lon], from]));
  } catch (e) {
    return res.status(502).json({ error: `no route now (${e.message})` });
  }
  const route = bikeRoutes.get(key);
  if (!route) return res.status(404).json({ error: 'no route found' });
  const x = s => String(s).replace(/[<>&"']/g, ch => `&#${ch.charCodeAt(0)};`), start = String(req.query.name || 'start').slice(0, 80);
  const name = `${c.name} from ${start}`;
  res.type('application/gpx+xml').set('Content-Disposition', `attachment; filename="${c.name.replace(/[^\w.-]+/g, '_').slice(0, 60)}.gpx"`).send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Cairn" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `<metadata><name>${x(name)}</name><desc>${x(`${Math.round(route.km)} km there and back; the top at ${c.ele ? `${c.ele} m` : 'its marker'}`)}</desc></metadata>\n` +
    `<wpt lat="${c.lat}" lon="${c.lon}">${c.ele ? `<ele>${c.ele}</ele>` : ''}<name>${x(c.name)}</name></wpt>\n` +
    `<trk><name>${x(name)}</name><trkseg>\n${route.path.map(([lat, lon]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`).join('\n')}\n</trkseg></trk>\n</gpx>\n`);
});
app.get('/api/climbs/:id/photos', (req, res) => {
  const list = climbs.photos(req.params.id);
  return list ? res.json(list) : res.status(404).json({ error: 'no such climb' });
});
// one effort up a climb, point by point: /api/climbs/Q209064/efforts/<activity id>?from=Bédoin
app.get('/api/climbs/:id/efforts/:ride', (req, res) => {
  const e = climbs.effort(req.params.id, req.params.ride, req.query.from || '');
  e ? res.json(e) : res.status(404).json({ error: 'no such effort (or no timed track for it)' });
});
app.get('/api/strava/status', (_req, res) => res.json(strava.status()));

// Where you ride, run and so on: start towns and countries per kind of sport (as the Sports tab groups them)
const SPORT_KINDS = { ride: /Ride|Velomobile|Handcycle|Wheelchair/, run: /Run/, walk: /Walk|Hike|Snowshoe/ };
app.get('/api/activities/places', (_req, res) => {
  loadTowns();
  if (!towns) return res.json({});
  const kindOf = s => Object.keys(SPORT_KINDS).find(k => SPORT_KINDS[k].test(s || '')) || 'sport';
  const acts = activities.list().filter(a => a.at && !a.trainer)
    .map(a => ({ at: a.at, km: a.distance || 0, date: (a.date || '').slice(0, 10), kind: kindOf(a.sport) }));
  const out = { all: cities.starts(towns, acts) };
  ['ride', 'run', 'walk', 'sport'].forEach(k => { out[k] = cities.starts(towns, acts.filter(a => a.kind === k)); });
  res.json(out);
});
app.post('/api/strava/sync', (_req, res) => { strava.sync(); res.json({ started: true }); });

app.get('/auth/strava', (_req, res) => {
  if (!strava.status().configured) return res.status(503).send('Strava is not configured: put strava_client_id and strava_client_secret in secret.');
  res.redirect(strava.authorizeUrl());
});

app.get('/auth/strava/callback', async (req, res) => {
  if (req.query.error) return res.redirect('/?strava=denied');
  try {
    await strava.connect(req.query.code, req.query.scope);
    res.redirect('/?strava=ok');
  } catch (e) {
    res.status(502).send(e.message);
  }
});

// --- Most visited cities ---

let towns;  // GeoNames towns, read on first use (tripmail downloads data/cities1000.txt)
function loadTowns() {
  if (towns === undefined) towns = cities.load(path.join(DATA_DIR, 'cities1000.txt'));
  return towns;
}

// Each day and place you were somewhere, in the period ?from=YYYY-MM-DD&to=YYYY-MM-DD (both optional)
// The town of a place (to about 1 km; an airport's by its city's name), and its ISO country: looked up once for every
// request (the towns and the countries do not change while Cairn runs)
const townMemo = new Map(), isoMemo = new Map();
function townOfAt(at, city) {
  if (!at || !loadTowns()) return null;
  const key = at[0].toFixed(2) + ',' + at[1].toFixed(2) + (city ? '|' + city : '');
  if (!townMemo.has(key)) townMemo.set(key, (city && cities.townNamed(towns, city, at[0], at[1])) || cities.townAt(towns, at[0], at[1]));
  return townMemo.get(key);
}

// Every place you were on every day, worked out once and kept until anything it comes from changes (a save, a file
// read again, the photo index); a period is a cut of it
const placesMemo = new Map();
function placesAndDays(from, to, { stays: withStays = true } = {}) {
  const refs = [dataVersion, flights.length, trips.length, stays.length, activities.list(), readImport(PHOTOS_FILE, []), readImport(TIMELINE_FILE, {}),
    readImport(CHECKINS_FILE, []), datedPhotos()];
  let m = placesMemo.get(withStays);
  if (!m || m.refs.some((r, i) => r !== refs[i])) placesMemo.set(withStays, m = { refs, list: allPlacesAndDays(withStays) });
  return from || to ? m.list.filter(p => (!from || p.day >= from) && (!to || p.day <= to)) : m.list.slice();
}
// Unix seconds of a local time ("2017-02-12 06:25") in a time zone (an airport's); null without a time or zone
// Each flight's time in the air, [unix take-off, unix landing, [lat, lon] of the airports], a quarter of an hour short at
// each end (taxiing): photos then were taken from the plane
function flyingSpans() {
  const at = code => airports[code] && [airports[code].lat, airports[code].lon];
  return flights.filter(f => f.date && at(f.from) && at(f.to)).map(f => {
    const off = localTime(f.date, airports[f.from].tz);
    if (off == null) return null;
    const [h, m] = (f.duration || '').split(':').map(Number), landed = localTime(f.arrival, airports[f.to].tz);
    const on = landed > off ? landed : off + (h * 60 + m > 0 ? (h * 60 + m) * 60 : ((f.distance || 0) / 800 + 0.5) * 3600);
    return [off + 900, on - 900, at(f.from), at(f.to)];
  }).filter(Boolean);
}
function localTime(s, tz) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/.exec(s || '');
  if (!m || !tz || tz === '\\N') return null;
  const guess = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric' }).formatToParts(guess).map(x => [x.type, x.value]));
    return (2 * guess - Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute)) / 1000;
  } catch (_) { return null; }
}

const TAGGED_KM = 300;
let untrusted = new Set();  // the check-ins left out (allPlacesAndDays)
function allPlacesAndDays(withStays) {
  const from = '', to = '';
  const pts = [], inPeriod = d => d && (!from || d >= from) && (!to || d <= to);
  const add = (at, d, city, guess) => { if (at && inPeriod(d)) pts.push(guess ? { at, day: d, city, guess } : { at, day: d, city }); };
  const eachDay = (a, b, fn) => {  // a stay or Timeline visit: every day from the first to the last, at most 90
    for (let t = Date.parse(a), n = 0; t <= Date.parse(b || a) && n < 90; t += 864e5, n++) fn(new Date(t).toISOString().slice(0, 10));
  };
  const at = code => airports[code] && [airports[code].lat, airports[code].lon];
  const fl = flights.filter(f => f.date && at(f.from) && at(f.to)).sort((a, b) => a.date.localeCompare(b.date));
  const change = (a, b) => a && b && a.to === b.from && Math.abs(Date.parse(b.date.replace(' ', 'T')) - Date.parse(a.date.replace(' ', 'T'))) < 864e5;
  fl.forEach((f, i) => {  // airports where you only changed planes do not count
    if (!change(fl[i - 1], f)) add(at(f.from), f.date.slice(0, 10), airports[f.from].city);
    if (!change(f, fl[i + 1])) add(at(f.to), f.date.slice(0, 10), airports[f.to].city);
  });
  trips.forEach(t => {
    if (t.approx) return;  // only its year or month known: no day
    if (t.from_lat != null) add([t.from_lat, t.from_lon], (t.date || '').slice(0, 10));
    if (t.to_lat != null) add([t.to_lat, t.to_lon], (t.date || '').slice(0, 10));
  });
  const away = withStays ? awayNights(stays) : new Map();
  if (withStays) stays.forEach(s => {  // not a base's days spent wholly on a side trip
    if (s.lat == null) return;
    if (s.what === 'car') add([s.lat, s.lon], s.start);
    else eachDay(s.start, s.end, d => { if (!away.get(s)?.days.has(d)) add([s.lat, s.lon], d); });
  });
  // photos: each from the photo index, where and when it was taken (once per place and day); without the index, the
  // older photo places file. Not those taken from a plane (between a flight's take-off and landing, over 100 km from
  // both airports): they show what you flew over, not where you went
  const flying = flyingSpans();
  const inAir = (t, p) => flying.some(([a, b, x, y]) => t > a && t < b && ground.km(p, x) > 100 && ground.km(p, y) > 100);
  const shot = datedPhotos();
  if (shot.length) {
    const seen = new Set();
    shot.forEach(p => {
      if (inAir(p[1], [p[2], p[3]])) return;
      const d = new Date(p[1] * 1000).toISOString().slice(0, 10), key = `${d}|${p[2].toFixed(2)}|${p[3].toFixed(2)}`;
      if (!seen.has(key)) { seen.add(key); add([p[2], p[3]], d, undefined, p[5] === 'c'); }
    });
  } else readImport(PHOTOS_FILE, []).forEach(c => (c.days || []).forEach(d => add([c.lat, c.lon], d)));
  // check-ins, posts with a place, reviews and rides (imports/checkins.py): where you were that day
  const dayOf = c => new Date(c.t * 1000).toISOString().slice(0, 10), checkins = readImport(CHECKINS_FILE, []);
  checkins.filter(c => c.kind !== 'tagged').forEach(c => add([c.lat, c.lon], dayOf(c)));
  (readImport(TIMELINE_FILE, {}).visits || []).forEach(v => eachDay(v.start.slice(0, 10), v.end.slice(0, 10), d => add([v.lat, v.lon], d)));
  activities.list().forEach(a => add(a.at, (a.date || '').slice(0, 10)));
  // places Facebook tagged you in were found by their name ("School of Computer Science"), which can be a namesake far
  // away: one counts unless the rest of your data, that day or the day either side, is all over TAGGED_KM from it
  const byDay = new Map();
  pts.forEach(p => { if (!byDay.has(p.day)) byDay.set(p.day, []); byDay.get(p.day).push(p.at); });
  const out = new Set();
  checkins.filter(c => c.kind === 'tagged').forEach(c => {
    const t = Date.parse(dayOf(c)), near = [-1, 0, 1].flatMap(k => byDay.get(new Date(t + k * 864e5).toISOString().slice(0, 10)) || []);
    if (near.length && near.every(at => ground.km(at, [c.lat, c.lon]) > TAGGED_KM)) out.add(c);
    else add([c.lat, c.lon], dayOf(c));
  });
  if (withStays) untrusted = out;
  return pts;
}

// --- Countries as a list counts them: ISO codes, sovereign countries, Travelers' Century Club (regions.js) ---

const regions = regionLists.create({ file: path.join(DATA_DIR, 'admin1.geojson'), download: httpsGet });

// Per country (of the town each place belongs to): days there, separate visits, towns, first and last day, from every
// source; and what happened there: nights in stays, flights in, trains, buses and ferries (from or to it), rental
// cars, sports activities and their km, photos
app.get('/api/countries', async (req, res) => {
  loadTowns();
  if (!towns) return res.json([]);
  // ?scheme=iso|un|tcc: countries as that list counts them (regions.js); otherwise the town's country code
  const scheme = regions.SCHEMES.includes(req.query.scheme) ? req.query.scheme : null;
  if (scheme) {
    try { await regions.ready(); } catch (e) { return res.status(502).json({ error: `Country map: ${e.message}` }); }
  }
  const from = req.query.from || '', to = req.query.to || '';
  const inPeriod = d => d && (!from || d >= from) && (!to || d <= to);
  const townOf = townOfAt;
  const all = {};
  const of = (at, city) => {
    if (!at) return null;
    const place = scheme ? regions.placeNow(scheme, at[0], at[1]) : townOf(at, city);
    if (!place) return null;
    const id = scheme ? place.id : place.cc;
    return all[id] = all[id] || { country: id, name: scheme ? place.name : undefined, days: new Set(), towns: new Set(), nights: 0,
      flights: 0, train: 0, bus: 0, ferry: 0, hitch: 0, drive: 0, cars: 0, activities: 0, km: 0, photos: 0 };
  };
  placesAndDays(from, to).forEach(p => {
    const v = of(p.at, p.city), t = townOf(p.at, p.city);
    if (v) { v.days.add(p.day); if (t) v.towns.add(t.id); }
  });
  flights.forEach(f => {
    const ap = airports[f.to];
    if (ap && inPeriod((f.date || '').slice(0, 10))) { const v = of([ap.lat, ap.lon], ap.city); if (v) v.flights++; }
  });
  trips.forEach(t => {
    if (!inPeriod((t.date || '').slice(0, 10)) || !['train', 'bus', 'ferry', 'hitch', 'drive'].includes(t.mode)) return;
    new Set([of(t.from_lat != null && [t.from_lat, t.from_lon]), of(t.to_lat != null && [t.to_lat, t.to_lon])]).forEach(v => { if (v) v[t.mode]++; });
  });
  const away = awayNights(stays);
  stays.forEach(s => {
    const v = s.lat != null && inPeriod(s.start) && of([s.lat, s.lon]);
    if (!v) return;
    if (s.what === 'car') v.cars++;
    else v.nights += sleptNights(s, away);
  });
  activities.list().forEach(a => {
    const v = inPeriod((a.date || '').slice(0, 10)) && of(a.at);
    if (v) { v.activities++; v.km += a.distance || 0; }
  });
  const dated = datedPhotos();  // the photo index, else the photos' grid cells
  if (dated.length) dated.forEach(p => { const v = inPeriod(new Date(p[1] * 1000).toISOString().slice(0, 10)) && of([p[2], p[3]]); if (v) v.photos++; });
  else readImport(PHOTOS_FILE, []).forEach(c => {
    const v = (c.days || []).some(inPeriod) && of([c.lat, c.lon]);
    if (v) v.photos += c.count || 0;
  });
  res.json(Object.values(all).filter(v => v.days.size).map(v => {
    const days = [...v.days].sort();
    const visits = days.filter((d, i) => !i || (Date.parse(d) - Date.parse(days[i - 1])) / 864e5 > 1).length;
    return { ...v, days: days.length, visits, towns: v.towns.size, km: Math.round(v.km), first: days[0], last: days[days.length - 1] };
  }).sort((a, b) => b.days - a.days));
});

app.get('/api/regions', async (req, res) => {
  const scheme = regions.SCHEMES.includes(req.query.scheme) ? req.query.scheme : 'iso';
  try {
    const json = Buffer.from(JSON.stringify(await regions.visited(scheme, placesAndDays(req.query.from || '', req.query.to || ''))));
    res.set('Vary', 'Accept-Encoding');
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return res.set({ 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' }).send(zlib.gzipSync(json));
    res.type('json').send(json);
  } catch (e) {
    res.status(502).json({ error: `Country map: ${e.message}` });
  }
});

// One country (ISO code), for its page: its days and visits, its towns, the trips that went there, flights in and
// out, trains, buses and ferries, stays, sports, photos, the famous climbs in it you rode, music, and its outline
app.get('/api/country/:cc', async (req, res) => {
  const cc = String(req.params.cc || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return res.status(400).json({ error: 'a two-letter country code' });
  const away = awayNights(stays);
  try { await regions.ready(); } catch (e) { return res.status(503).json({ error: `no country map: ${e.message}` }); }
  loadTowns();
  const placeOf = at => {
    if (!at || at[0] == null) return null;
    const k = (+at[0]).toFixed(2) + ',' + (+at[1]).toFixed(2);
    if (!isoMemo.has(k)) isoMemo.set(k, regions.placeNow('iso', +at[0], +at[1]));
    return isoMemo.get(k);
  };
  const here = at => placeOf(at)?.id === cc;
  const points = placesAndDays('', '').filter(p => here(p.at));
  const place = points.length ? placeOf(points[0].at) : null;
  const days = [...new Set(points.map(p => p.day))].sort(), visits = [];
  days.forEach(d => {
    const v = visits[visits.length - 1];
    if (v && (Date.parse(d) - Date.parse(v.end)) / 864e5 <= 1) { v.end = d; v.days++; } else visits.push({ start: d, end: d, days: 1 });
  });
  const ap = code => airports[code] && [airports[code].lat, airports[code].lon];
  const shape = points.length ? (await regions.visited('iso', [points[0]])).places[0]?.shape || null : null;
  const climbsHere = climbs.list().filter(c => c.country === cc);
  const acts = activities.list().filter(a => a.at && here(a.at));
  const photosHere = datedPhotos().filter(p => here([p[2], p[3]]));
  res.json({
    cc, name: place?.name || cc, shape, days: days.length, first: days[0], last: days[days.length - 1], visits: visits.reverse(),
    towns: towns ? cities.rank(towns, points).filter(t => t.country === cc).slice(0, 60) : [],
    trips: tripStore.list().filter(t => t.countries.some(c => c.cc === cc))
      .map(t => ({ id: t.id, name: t.name, start: t.start, end: t.end, days: t.days, here: t.countries.find(c => c.cc === cc).days, countries: t.countries })),
    flights: flights.map(f => ({ f, into: here(ap(f.to)), out: here(ap(f.from)) })).filter(x => x.into || x.out)
      .map(({ f, into }) => ({ date: f.date, flight_number: f.flight_number, airline: f.airline, from: f.from, to: f.to,
        from_city: airports[f.from]?.city, to_city: airports[f.to]?.city, direction: into ? 'in' : 'out' })).sort((a, b) => b.date.localeCompare(a.date)),
    ground: trips.filter(t => here([t.from_lat, t.from_lon]) || here([t.to_lat, t.to_lon]))
      .map(t => ({ id: t.id, date: t.date, approx: t.approx, mode: t.mode, from: t.from, to: t.to, distance: t.distance })).sort((a, b) => b.date.localeCompare(a.date)),
    stays: stays.filter(s => s.lat != null && here([s.lat, s.lon])).map(s => ({ id: s.id, what: s.what, start: s.start, end: s.end, place: s.place,
      hotel: s.hotel, type: s.type, provider: s.provider, away: away.get(s)?.nights })).sort((a, b) => b.start.localeCompare(a.start)),
    activities: { count: acts.length, km: Math.round(acts.reduce((n, a) => n + (a.distance || 0), 0)), ids: acts.map(a => a.id) },
    photos: photosHere.length, photo_ids: photosHere.map(p => p[0]),
    climbs: { total: climbsHere.length, done: climbsHere.filter(c => c.times).map(c => ({ id: c.id, name: c.name, ele: c.ele, times: c.times })) },
    music: music.top({ days: new Set(days) })
  });
});

// A town's flag (or its coat of arms when it has none), from Wikidata by its GeoNames id: the Wikimedia Commons file,
// looked up once and kept in data/town_flags.json ({ id: { flag, arms } or null })
const FLAGS_FILE = path.join(DATA_DIR, 'town_flags.json');
let townFlags = null;
app.get('/api/city/:id/flag', async (req, res) => {
  const id = String(Number(req.params.id));
  if (!townFlags) { try { townFlags = JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf8')); } catch (_) { townFlags = {}; } }
  if (!(id in townFlags)) {
    const q = `SELECT ?flag ?arms WHERE { ?item wdt:P1566 "${id}" . OPTIONAL { ?item wdt:P41 ?flag } OPTIONAL { ?item wdt:P94 ?arms } } LIMIT 1`;
    try {
      const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`,
        { headers: { 'User-Agent': 'cairn (personal travel log; https://github.com/bazilinskyy/cairn)', Accept: 'application/sparql-results+json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`Wikidata: HTTP ${r.status}`);
      const b = (await r.json()).results.bindings[0] || {};
      const file = u => (u ? decodeURIComponent(u.value.split('/').pop()) : null);
      townFlags[id] = b.flag || b.arms ? { flag: file(b.flag), arms: file(b.arms) } : null;
      fs.writeFileSync(FLAGS_FILE, JSON.stringify(townFlags));
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }
  const f = townFlags[id];
  res.json(f ? { ...f, url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(f.flag || f.arms)}?width=160`, kind: f.flag ? 'flag' : 'coat of arms' } : null);
});

// One town, for its report page: the days and separate visits there, and everything done there in the period (?from=
// &to=): stays and rental cars, flights in and out, trains, buses and ferries from or to it, sports activities that
// started there, photos per day, Timeline places. A place belongs to a town as for the most visited cities.
app.get('/api/city/:id', (req, res) => {
  loadTowns();
  if (!towns) return res.status(503).json({ error: 'no town list (data/cities1000.txt)' });
  const id = Number(req.params.id);
  const town = cities.byId(towns, id);
  if (!town) return res.status(404).json({ error: 'no such town' });
  const from = req.query.from || '', to = req.query.to || '';
  const inPeriod = d => d && (!from || d >= from) && (!to || d <= to);
  const here = (at, city) => !!at && at[0] != null && townOfAt([+at[0], +at[1]], city) === town;
  const days = [...new Set(placesAndDays(from, to).filter(p => here(p.at, p.city)).map(p => p.day))].sort();
  const visits = [];
  days.forEach(d => {
    const v = visits[visits.length - 1];
    if (v && (Date.parse(d) - Date.parse(v.end)) / 864e5 <= 1) { v.end = d; v.days++; } else visits.push({ start: d, end: d, days: 1 });
  });
  const ap = code => airports[code] && [airports[code].lat, airports[code].lon];
  const flightsHere = flights.filter(f => inPeriod((f.date || '').slice(0, 10)))
    .map(f => ({ f, into: here(ap(f.to), airports[f.to]?.city), out: here(ap(f.from), airports[f.from]?.city) }))
    .filter(x => x.into || x.out)
    .map(({ f, into }) => ({ date: f.date, flight_number: f.flight_number, airline: f.airline, from: f.from, to: f.to,
      from_city: airports[f.from]?.city, to_city: airports[f.to]?.city, direction: into ? 'in' : 'out' }));
  const groundHere = trips.filter(t => inPeriod((t.date || '').slice(0, 10)) && (here([t.from_lat, t.from_lon]) || here([t.to_lat, t.to_lon])))
    .map(t => ({ id: t.id, date: t.date, mode: t.mode, from: t.from, to: t.to, distance: t.distance }));
  const away = awayNights(stays);
  const staysHere = stays.filter(s => s.lat != null && (inPeriod(s.start) || inPeriod(s.end)) && here([s.lat, s.lon]))
    .map(s => ({ id: s.id, what: s.what, start: s.start, end: s.end, place: s.place, hotel: s.hotel, type: s.type, provider: s.provider, price: s.price, away: away.get(s)?.nights }));
  const activitiesHere = activities.list().filter(a => a.at && inPeriod((a.date || '').slice(0, 10)) && here(a.at))
    .map(a => ({ id: a.id, date: a.date, name: a.name, sport: a.sport, distance: a.distance, moving_time: a.moving_time, elevation: a.elevation, trainer: a.trainer }));
  // the photos of the photo index taken in the town (as its days count them), for its gallery and its days; without
  // the index, the photos' grid cells (a cell knows its days and its total: spread evenly)
  const near = p => Math.abs(p[2] - town.lat) < 0.3 && Math.abs(p[3] - town.lon) < 0.5, dayOf = p => new Date(p[1] * 1000).toISOString().slice(0, 10);
  const photosIn = datedPhotos().filter(p => near(p) && inPeriod(dayOf(p)) && here([p[2], p[3]])), photoIds = photosIn.map(p => p[0]);
  const photoDays = new Map();
  if (photoIndex.list().length) photosIn.forEach(p => photoDays.set(dayOf(p), (photoDays.get(dayOf(p)) || 0) + 1));
  else readImport(PHOTOS_FILE, []).forEach(c => {
    const ds = (c.days || []).filter(inPeriod);
    if (!ds.length || !here([c.lat, c.lon])) return;
    const each = (c.count || 0) / (c.days || []).length;
    ds.forEach(d => photoDays.set(d, (photoDays.get(d) || 0) + each));
  });
  const timelineHere = (readImport(TIMELINE_FILE, {}).visits || [])
    .filter(v => inPeriod(v.start.slice(0, 10)) && here([v.lat, v.lon])).map(v => ({ start: v.start, end: v.end, name: v.name }));
  const sortBy = k => (a, b) => (b[k] || '').localeCompare(a[k] || '');  // newest first
  res.json({
    town: { id: town.id, name: town.name, country: town.cc, lat: town.lat, lon: town.lon, population: town.pop },
    days: days.length, first: days[0], last: days[days.length - 1], visits: visits.reverse(),
    stays: staysHere.sort(sortBy('start')), flights: flightsHere.sort(sortBy('date')), ground: groundHere.sort(sortBy('date')),
    activities: activitiesHere.sort(sortBy('date')),
    photos: [...photoDays].map(([day, n]) => ({ day, count: Math.max(1, Math.round(n)) })).sort(sortBy('day')), photo_ids: photoIds,
    timeline: timelineHere.sort(sortBy('start')),
    music: music.top({ days: new Set(days) })
  });
});

// --- Weather on the rides (weather.js) and the days' sleep and resting heart rate (Garmin, data/wellness.json) ---

const weather = require('./weather').create({ activities: () => activities.list(), file: path.join(DATA_DIR, 'weather.json'), log: m => console.log(m) });
app.get('/api/weather', (_req, res) => res.json(weather.all()));
const WELLNESS_FILE = path.join(DATA_DIR, 'wellness.json');
// Every day's sleep, resting heart rate and more (imports/garmin.py). A night whose sleep was not measured is left
// out of it: older watches give no sleep stages and call the whole time the watch lay still "deep" (12-13 hours,
// also when it lay on a table), as garmin.py now leaves them out too
const measuredSleep = d => d.sleep && !(!d.rem && (d.deep || 0) >= 0.9 * d.sleep);
const SLEEP_KEYS = ['sleep', 'deep', 'light', 'rem', 'awake', 'bed', 'wake', 'score'];
const wellnessSeen = new WeakMap();
const wellnessDays = () => {
  const raw = readImport(WELLNESS_FILE, { days: {} }).days || {};
  if (!wellnessSeen.has(raw)) {
    wellnessSeen.set(raw, Object.fromEntries(Object.entries(raw).map(([d, x]) => [d, !x.sleep || measuredSleep(x) ? x
      : Object.fromEntries(Object.entries(x).filter(([k]) => !SLEEP_KEYS.includes(k)))])));
  }
  return wellnessSeen.get(raw);
};
app.get('/api/wellness', (req, res) => {
  const from = req.query.from || '', to = req.query.to || '';
  res.json(Object.fromEntries(Object.entries(wellnessDays()).filter(([d]) => (!from || d >= from) && (!to || d <= to))));
});

// --- Music (lastfm.js): your Last.fm scrobbles, for the towns' and trips' pages ---

const music = require('./lastfm').create({
  file: path.join(DATA_DIR, 'lastfm.json'), log: m => console.log(m),
  keys: () => {  // read each time, so adding them needs no restart
    let s = secret;
    try { s = JSON.parse(fs.readFileSync(path.join(__dirname, 'secret'), 'utf8')); } catch (_) {}
    return { key: s.lastfm_api_key || '', user: s.lastfm_user || config.lastfm_user || '' };
  }
});
app.get('/api/music/status', (_req, res) => res.json(music.status()));
app.post('/api/music/sync', (_req, res) => { music.sync(); res.json(music.status()); });
app.get('/api/music', (req, res) => res.json(music.top({ from: req.query.from || '', to: req.query.to || '' })));

// --- Trips (trips.js): the runs of days away, each with its story and its moves ---

const tripStore = require('./trips').create({
  towns: loadTowns,
  cities, days: (from, to) => placesAndDays(from, to), flights: () => flights, airports: () => airports, groundTrips: () => trips,
  stays: () => stays, activities: () => activities.list(), photos: datedPhotos,
  homeAirports, file: path.join(DATA_DIR, 'drives.json'),
  wellness: wellnessDays, weather: () => weather.all(), calendar: () => readImport(path.join(DATA_DIR, 'calendar.json'), []),
  log: m => console.log(m)
});
app.get('/api/trips', (_req, res) => res.json(tripStore.list()));

// The drives Cairn worked out (trips.js: along the roads, on the days of a rental car) as car journeys for the map,
// from town to town; not on a day that has a car journey of your own
function derivedDrives(list = tripStore.drives()) {
  loadTowns();
  const own = new Set(trips.filter(t => t.mode === 'drive').map(t => (t.date || '').slice(0, 10)));  // your own drives replace the day's
  const name = at => (towns && cities.townAt(towns, at[0], at[1])?.name) || `${at[0].toFixed(2)}, ${at[1].toFixed(2)}`;
  return list.filter(d => !own.has(d.day)).map((d, i) => ({ id: `drive-${i}`, mode: 'drive', derived: true, date: `${d.day} 12:00:00`,
    from: name(d.from), to: name(d.to), from_lat: d.from[0], from_lon: d.from[1], to_lat: d.to[0], to_lon: d.to[1],
    path: d.path || '', distance: Math.round(d.km), path_source: d.path ? 'osrm' : 'straight' }));
}
app.get('/api/drives', async (_req, res) => res.json(derivedDrives(await tripStore.drivesReady())));
// a worked-out drive put right (through stops you name: back through another town): the day's worked-out drives become your own
// (each with its road; the one put right looked up again through its stops), as your own drives replace the day's
app.post('/api/drives/keep', async (req, res) => {
  const { day, from, to, stops } = req.body || {};
  if (!/^\d{4}-\d\d-\d\d$/.test(day || '') || !Array.isArray(from) || !Array.isArray(to)) return res.status(400).json({ error: 'day, from and to are required' });
  if (trips.some(t => t.mode === 'drive' && (t.date || '').slice(0, 10) === day)) return res.status(409).json({ error: 'that day has drives of your own already' });
  const list = (await tripStore.drivesReady()).filter(d => d.day === day);
  const pick = list.find(d => ground.km(d.from, from) < 0.5 && ground.km(d.to, to) < 0.5);
  if (!pick) return res.status(404).json({ error: 'no such drive that day' });
  const named = (Array.isArray(stops) ? stops : []).map(x => String(x).trim()).filter(Boolean);
  const name = at => (loadTowns() && cities.townAt(towns, at[0], at[1])?.name) || `${at[0].toFixed(2)}, ${at[1].toFixed(2)}`;
  const made = list.map((d, i) => {
    const t = { id: nextId(trips), mode: 'drive', date: `${day} ${String(8 + Math.min(i, 15)).padStart(2, '0')}:00:00`, from: name(d.from), to: name(d.to),
      from_lat: d.from[0], from_lon: d.from[1], to_lat: d.to[0], to_lon: d.to[1], source: 'manual', note: 'by car: worked out from your photos, kept as your own when one was put right; times a guess' };
    if (d === pick && named.length) t.stops = named;
    else if (d.path) Object.assign(t, { path: d.path, distance: Math.round(d.km), path_source: 'osrm', route_v: ground.ROUTE_VERSION });
    trips.push(t);
    return t;
  });
  saveTrips();
  lookUpTrips();
  res.json(made);
});

// Curiosities (stats.js): days by the sea and up in the mountains, the extremes, capitals, distances, beds, ...
const curiosities = require('./stats').create({
  days: (from, to) => placesAndDays(from, to), towns: loadTowns,
  cities, activities: () => activities.list(), stays: () => stays, flights: () => flights, airports: () => airports, groundTrips: () => trips,
  trips: () => tripStore.list(), weather: () => weather.all(), wellness: wellnessDays,
  homeAirports, places: homePlaces, commutes: commutesCounted, drives: () => derivedDrives(),
  heightsFile: path.join(DATA_DIR, 'heights.json'), coastFile: path.join(DATA_DIR, 'coastline.geojson'), download: httpsGet, log: m => console.log(m)
});
// --- Backup (backup.js): everything you imported or added, out as one .tar.gz and back in ---

// ferries with no terminal on the map leave from their island's coast nearest the other end (ground.js): Natural
// Earth's closed coastlines, each with its box
let coastRingsOnce;
ground.setRailCache(path.join(DATA_DIR, 'rail'));  // the railways along trains no timetable knows, from Overpass
ground.setCoast(() => {
  if (coastRingsOnce === undefined) {
    try {
      const geo = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'coastline.geojson'), 'utf8'));
      coastRingsOnce = geo.features.flatMap(f => (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]))
        .filter(l => l.length > 3 && l[0][0] === l[l.length - 1][0] && l[0][1] === l[l.length - 1][1])
        .map(pts => ({ pts, box: [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))] }));
    } catch (_) { coastRingsOnce = []; }
  }
  return coastRingsOnce;
});

const backups = require('./backup').create({
  files: () => [
    ['flights.json', FLIGHTS_FILE], ['ground.json', GROUND_FILE], ['stays.json', STAYS_FILE], ['stays.removed.json', REMOVED_FILE],
    ['garmin.json', GARMIN_FILE], ['strava.json', path.join(__dirname, config.strava_file)], ['wellness.json', WELLNESS_FILE],
    ['photos.json', PHOTOS_FILE], ['photo_points.json', path.join(DATA_DIR, 'photo_points.json')], ['timeline.json', TIMELINE_FILE],
    ['weather.json', path.join(DATA_DIR, 'weather.json')], ['lastfm.json', path.join(DATA_DIR, 'lastfm.json')],
    ['climb_ascents.json', path.join(DATA_DIR, 'climb_ascents.json')], ['drives.json', path.join(DATA_DIR, 'drives.json')],
    ['suggestions.dismissed.json', path.join(DATA_DIR, 'suggestions.dismissed.json')], ['saved_places.json', path.join(DATA_DIR, 'saved_places.json')],
    ['tripdoc_rows.json', path.join(DATA_DIR, 'tripdoc_rows.json')], ['albums.json', path.join(DATA_DIR, 'albums.json')],
    ['home.json', path.join(DATA_DIR, 'home.json')], ['album_places.json', path.join(DATA_DIR, 'album_places.json')],
    ['photo_places.json', PHOTO_PLACES],
    ['checkins.json', path.join(DATA_DIR, 'checkins.json')], ['calendar.json', path.join(DATA_DIR, 'calendar.json')],
    ['transactions.json', path.join(DATA_DIR, 'transactions.json')]
  ].map(([name, file]) => ({ name, file })),
  tracks: path.join(DATA_DIR, 'tracks'), backupsDir: path.join(DATA_DIR, 'backups'), log: m => console.log(m)
});
app.get('/api/backup/summary', (_req, res) => res.json(backups.summary()));
app.get('/api/backup', (req, res) => {  // ?activities=0: without the sports activities and their tracks
  const activities = req.query.activities !== '0';
  res.set({ 'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="cairn-backup-${backups.stamp()}${activities ? '' : '-no-activities'}.tar.gz"` });
  backups.stream(res, undefined, { activities });
});
// a backup back in place; then Cairn starts again to read it (its service brings it back; run by hand, start it again)
app.post('/api/backup/restore', express.raw({ type: () => true, limit: '2gb' }), async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ error: 'no file' });
  try {
    const done = await backups.restore(req.body);
    const supervised = process.env.XPC_SERVICE_NAME === 'nl.tue.cairn';  // its LaunchAgent (mail/cairn.plist.template) starts it again
    res.json({ ...done, restarting: supervised });
    if (supervised) setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Suggestions (suggestions.js): journeys your photos show and nothing else does ---
// stays your runs show: nights away with no stay, where your loops start (bases.js), in the health list
const bases = require('./bases').create({
  activities: () => activities.list(), stays: () => stays, km: ground.km, decode: ground.decode,
  homes: () => Object.values(homePlaces()).filter(Boolean).map(t => [t.lat, t.lon]),
  townAt: at => (loadTowns() && cities.townAt(towns, at[0], at[1])) || null
});
const suggestions = require('./suggestions').create({
  towns: loadTowns, cities,
  photos: ownPlacePhotos, flights: () => flights, airports: () => airports, groundTrips: () => trips, activities: () => activities.list(),
  stays: () => stays, homeAirports,
  dismissedFile: path.join(DATA_DIR, 'suggestions.dismissed.json')
});
app.get('/api/suggestions', (_req, res) => res.json(suggestions.list()));

// albums with no places whose names say where and when (albums.js)
const albums = require('./albums').create({
  dir: () => (fs.existsSync(path.join(DATA_DIR, 'photo_albums.json')) ? path.join(DATA_DIR, 'photo_albums.json')
    : config.takeout_photos_dir ? config.takeout_photos_dir.replace(/^~/, require('os').homedir()) : ''),
  cacheFile: path.join(DATA_DIR, 'albums.json'), placesFile: path.join(DATA_DIR, 'album_places.json'), km: ground.km,
  towns: loadTowns,
  near: year => {  // the middle of where your data puts you that year (the median place)
    const pts = placesAndDays(`${year}-01-01`, `${year}-12-31`).map(p => p.at).filter(Boolean);
    if (!pts.length) return null;
    const mid = k => pts.map(p => p[k]).sort((a, b) => a - b)[Math.floor(pts.length / 2)];
    return [mid(0), mid(1)];
  },
  flights: () => flights, airports: () => airports, groundTrips: () => trips, stays: () => stays,
  dismissed: () => { try { return new Set(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'suggestions.dismissed.json'), 'utf8'))); } catch (_) { return new Set(); } },
  log: m => console.log(m)
});
// trips your Things to-dos say you made, that nothing else knows (things.js, todotrips.js)
const things = require('./things').create({ db: () => config.things_db || '', log: m => console.log(m) });
const dismissedSet = () => { try { return new Set(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'suggestions.dismissed.json'), 'utf8'))); } catch (_) { return new Set(); } };
const todoTrips = require('./todotrips').create({
  things, locate: (name, year) => albums.locate(name, year), days: (from, to) => placesAndDays(from, to), km: ground.km,
  townAt: at => loadTowns() && cities.townAt(towns, at[0], at[1]),
  dismissed: dismissedSet, log: m => console.log(m)
});
app.get('/api/suggestions/todos', (_req, res) => { const list = todoTrips.list(); res.json(list || { pending: true }); });
// trains, buses and ferries in your trip docs that are not on the map (data/tripdoc_rows.json, from the trip docs)
app.get('/api/suggestions/tripdocs', (_req, res) => {
  const rows = readImport(path.join(DATA_DIR, 'tripdoc_rows.json'), []), no = dismissedSet();
  const have = new Set(trips.map(t => `${(t.date || '').slice(0, 10)}|${t.mode}`));
  res.json(rows.filter(r => !no.has(r.key) && !have.has(`${r.date}|${r.mode}`)));
});

// --- Getting ready for the coming trips (prep.js), and every morning what is still missing to the alerts channel ---
function discord(text) {  // tripmail's Discord webhook (secret), the alerts channel
  let s = secret;
  try { s = JSON.parse(fs.readFileSync(path.join(__dirname, 'secret'), 'utf8')); } catch (_) {}
  const url = mailSection(s).discord_webhook;
  if (!url) return Promise.reject(new Error('no discord_webhook in secret'));
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'cairn' }, body: JSON.stringify({ content: text.slice(0, 1900) }),
    signal: AbortSignal.timeout(20000) }).then(r => { if (!r.ok) throw new Error(`Discord: HTTP ${r.status}`); });
}
const prep = require('./prep').create({
  trips: () => tripStore.list(), flights: () => flights, airports: () => airports, stays: () => stays, groundTrips: () => trips,
  climbs: () => climbs.list(), saved: () => readImport(path.join(DATA_DIR, 'saved_places.json'), []), things,
  homeAirports, km: ground.km,
  sentFile: path.join(DATA_DIR, 'prep_alerts.json'), dismissed: dismissedSet, discord, log: m => console.log(m)
});
app.get('/api/coming', async (_req, res) => res.json(await prep.coming()));

// --- Spending (spending.js): what the stays cost, in euros ---
// the town of each day: of the places Cairn knows that day, the town most of them are in; worked out again only when
// the places change
let dayTowns = { list: null, map: new Map() };
function dayTownMap() {
  placesAndDays('9999-01-01', '9999-01-01');  // the places up to date (an empty period: nothing copied)
  const list = placesMemo.get(true).list;
  if (dayTowns.list !== list) {
    const count = new Map();
    list.forEach(p => { const t = townOfAt(p.at, p.city); if (!t) return; const m = count.get(p.day) || new Map(); m.set(t, (m.get(t) || 0) + 1); count.set(p.day, m); });
    dayTowns = { list, map: new Map([...count].map(([d, m]) => { const t = [...m].sort((x, y) => y[1] - x[1])[0][0]; return [d, { id: t.id, name: t.name, cc: t.cc, lat: t.lat, lon: t.lon }]; })) };
  }
  return dayTowns.map;
}
const spending = require('./spending').create({
  stays: () => stays, file: path.join(DATA_DIR, 'rates.json'), log: m => console.log(m),
  transactions: () => readImport(path.join(DATA_DIR, 'transactions.json'), []), dayTowns: dayTownMap, trips: () => tripStore.list(),
  townAt: at => loadTowns() && cities.townAt(towns, at[0], at[1])
});
app.get('/api/spending', (_req, res) => res.json(spending.summary()));

// --- Wish list: saved places (Google Maps, imports/saved_places.py), climbs to ride near where you go, countries ---
const SAVED_FILE = path.join(DATA_DIR, 'saved_places.json');
const NEAR_HOME_KM = 60;
app.get('/api/wishlist', (_req, res) => {
  loadTowns();
  const saved = readImport(SAVED_FILE, []);
  const pts = placesAndDays('', new Date().toISOString().slice(0, 10));
  const favourite = towns ? cities.rank(towns, pts, 20) : [];
  const climbsToRide = climbs.list().filter(c => !c.times).map(c => {
    let best = null;
    for (const t of favourite) { const d = ground.km([t.lat, t.lon], [c.lat, c.lon]); if (d <= NEAR_HOME_KM && (!best || d < best.km)) best = { km: Math.round(d), near: t.name, nearId: t.id }; }
    return best && { id: c.id, name: c.name, country: c.country, ele: c.ele, lat: c.lat, lon: c.lon, ...best };
  }).filter(Boolean).sort((a, b) => a.km - b.km).slice(0, 60);
  const visited = new Set();
  for (const p of pts) { const t = townOfAt(p.at); if (t) visited.add(t.cc); }
  const dn = new Intl.DisplayNames(['en'], { type: 'region' }), OLD = new Set(['AN', 'BU', 'CS', 'DD', 'DY', 'EU', 'EZ', 'FX', 'HV', 'NH', 'NT', 'QO', 'RH', 'SU', 'TP', 'UK', 'UN', 'VD', 'YD', 'YU', 'ZR', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA', 'CQ']);
  const all = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const cc = String.fromCharCode(a, b), name = dn.of(cc);
    if (name && name !== cc && !OLD.has(cc) && !/^X[A-Z]$/.test(cc) || cc === 'XK') all.push({ cc, name });
  }
  res.json({ saved, climbs: climbsToRide, near: favourite.slice(0, 10).map(t => ({ id: t.id, name: t.name, cc: t.country })),
    countries: { visited: [...visited].length, total: all.length, missing: all.filter(c => !visited.has(c.cc)).sort((a, b) => a.name.localeCompare(b.name)) } });
});

// --- A year in review (review.js) ---
const yearReview = require('./review').create({
  days: (from, to) => placesAndDays(from, to),
  townOf: p => loadTowns() && ((p.city && cities.townNamed(towns, p.city, p.at[0], p.at[1])) || cities.townAt(towns, p.at[0], p.at[1])),
  trips: () => tripStore.list(), flights: () => flights, groundTrips: () => trips, stays: () => stays, activities: () => activities.list(),
  climbs: () => climbs.list(), photos: datedPhotos, music: range => music.top(range), wellness: wellnessDays, weather: () => weather.all(),
  spending: () => spending.summary(), places: homePlaces, commutes: commutesCounted, drives: () => derivedDrives()
});
app.get('/api/review/years', (_req, res) => res.json(yearReview.years()));
app.get('/api/review/by-year', (_req, res) => res.json(yearReview.byYear()));  // every year side by side
app.get('/api/review/:year', (req, res) => {
  if (!/^\d{4}$/.test(req.params.year)) return res.status(400).json({ error: 'a year, like 2025' });
  res.json(yearReview.review(+req.params.year));
});

// --- Data health: what looks wrong, to fix with a click ---
// stays booked for the same nights (a booking and a trip doc's line, two sites; not a side trip from a base, which is
// counted as nights away: stats.js awayNights), trips and stays not placed, trains and
// buses drawn straight, flights without their airline's code; each can be fixed or said to be fine (dismissed)
// stays that are copies of each other: the same nights and the same place ("Houston (Texas)" is Houston); the one that
// knows most is kept (its position, the hotel, the price, Booking.com's own record)
const placeKey = p => (p || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s*\(.*?\)/g, '').replace(/[^a-z]/g, '');
function stayCopies() {
  const groups = new Map();
  stays.filter(s => s.what !== 'car' && s.start).forEach(s => {
    const k = `${s.start}|${s.end || s.start}|${placeKey(s.place)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  });
  const score = s => (s.lat != null) * 8 + !!s.hotel * 4 + !!s.price * 2 + (s.source === 'booking') * 1;
  return [...groups.values()].filter(g => g.length > 1).map(g => { const keep = [...g].sort((a, b) => score(b) - score(a))[0]; return { keep, drop: g.filter(s => s !== keep) }; });
}
app.post('/api/health/dedupe', (_req, res) => {
  const copies = stayCopies(), gone = [];
  for (const { drop } of copies) for (const s of drop) {
    const i = stays.indexOf(s);
    if (i >= 0) { stays.splice(i, 1); removeStayCode(s.code); gone.push(s.id); }
  }
  saveStays();
  res.json({ removed: gone.length });
});

app.get('/api/health', (_req, res) => {
  const no = dismissedSet(), beds = stays.filter(s => s.what !== 'car' && s.start && s.end && s.end > s.start).sort((a, b) => a.start.localeCompare(b.start));
  const twice = [];
  for (let i = 0; i < beds.length; i++) {
    for (let j = i + 1; j < beds.length && beds[j].start < beds[i].end; j++) {
      const a = beds[i], b = beds[j], key = `health|twice|${Math.min(a.id, b.id)}|${Math.max(a.id, b.id)}`;
      const nights = Math.round((Date.parse(a.end < b.end ? a.end : b.end) - Date.parse(b.start > a.start ? b.start : a.start)) / 864e5);
      if (nights > 0 && !no.has(key) && !sideTrip(a, b) && !sideTrip(b, a) && !(a.start === b.start && (a.end || a.start) === (b.end || b.start) && placeKey(a.place) === placeKey(b.place))) twice.push({ key, nights, stays: [a, b].map(s => ({ id: s.id, start: s.start, end: s.end, place: s.place, hotel: s.hotel || s.type || '', provider: s.provider || '', source: s.source || 'email' })) });
    }
  }
  const unplaced = [...trips.filter(t => t.unplaced).map(t => ({ kind: 'ground', id: t.id, date: t.date, text: `${t.mode}: ${t.from} → ${t.to}`, from: t.from, to: t.to })),
    ...stays.filter(s => s.unplaced || (s.lat == null && s.place)).map(s => ({ kind: 'stay', id: s.id, date: s.start, text: `${s.what === 'car' ? 'rental car' : 'stay'}: ${s.place}`, place: s.place }))]
    .filter(x => !no.has(`health|unplaced|${x.kind}|${x.id}`)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const straight = trips.filter(t => t.path_source === 'straight' && t.mode !== 'ferry' && !no.has(`health|straight|${t.id}`))
    .map(t => ({ id: t.id, date: t.date, mode: t.mode, from: t.from, to: t.to, distance: t.distance }));
  const flightsBare = flights.filter(f => !/^[A-Z0-9]{2}\s?\d/i.test((f.flight_number || '').trim()) && !no.has(`health|flight|${f.id}`))
    .map(f => ({ id: f.id, date: f.date, flight_number: f.flight_number || '', from: f.from, to: f.to, airline: f.airline || '' }));
  // the photo jobs that failed last time: the photo index (imports/photos.py writes how its run went) and writing the
  // places you gave photos into Photos
  const index = readImport(path.join(DATA_DIR, 'photo_index_status.json'), {});
  const photoJobs = [index.ok === false && { key: `health|photos|index|${index.at}`, what: 'Updating the photo index (imports/photos.py)', at: index.at * 1000, error: index.error },
    placesStatus?.ok === false && { key: `health|photos|write|${placesStatus.at}`, what: 'Writing the places you gave photos into Photos', at: placesStatus.at, error: placesStatus.error, again: true }]
    .filter(x => x && !no.has(x.key));
  res.json({ copies: stayCopies().reduce((n, g) => n + g.drop.length, 0), twice, unplaced, straight, flights: flightsBare, photoJobs,
    bases: bases.list().filter(x => !no.has(x.key)) });
});
// a train, bus or ferry looked up again from its names (its places and track)
app.post('/api/ground/:id/retry', (req, res) => {
  const t = trips.find(x => x.id === Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'no such trip' });
  // ?keep=1: the track only, from the places it has (else the places too, from the names)
  (req.query.keep ? ['path', 'path_source', 'route_v', 'distance', 'ports'] : ['from_lat', 'from_lon', 'to_lat', 'to_lon', 'path', 'path_source', 'route_v', 'unplaced', 'distance', 'ports'])
    .forEach(k => delete t[k]);
  saveTrips();
  lookUpTrips();
  res.json(t);
});
app.post('/api/stays/:id/retry', (req, res) => {  // a stay's place looked up again
  const s = stays.find(x => x.id === Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'no such stay' });
  ['lat', 'lon', 'unplaced'].forEach(k => delete s[k]);
  saveStays();
  lookUpTrips();
  res.json(s);
});

app.get('/api/suggestions/albums', (_req, res) => { const list = albums.list(); res.json(albums.ready() ? list : { pending: true }); });
// Payments abroad (your bank's, imports/bank.py) on days when nothing in Cairn puts you in that country: trips that
// may be missing. Per country, the payments a few days apart make one run; a run with no day of yours in that
// country around it (a day either side) is listed, unless you said it was none (an online purchase)
let paidCache = { key: '', list: [] };
app.get('/api/suggestions/payments', (_req, res) => {
  const tx = readImport(path.join(DATA_DIR, 'transactions.json'), []), no = dismissedSet();
  if (!tx.length) return res.json([]);
  loadTowns();
  if (!towns) return res.json([]);
  const key = [tx.length, flights.length, trips.length, stays.length, no.size].join('|');
  if (paidCache.key !== key) {
    const memo = new Map(), ccAt = at => { const k = at[0].toFixed(2) + ',' + at[1].toFixed(2); if (!memo.has(k)) memo.set(k, cities.townAt(towns, at[0], at[1])?.cc || null); return memo.get(k); };
    const home = new Set(homeAirports().map(c => airports[c]).filter(Boolean).map(a => ccAt([a.lat, a.lon])).filter(Boolean));
    Object.values(homePlaces()).forEach(t => { if (t) home.add(t.cc); });
    const there = new Set();  // 'cc|day' of every day Cairn puts you in a country
    placesAndDays('', '').forEach(p => { const cc = p.at && ccAt(p.at); if (cc) there.add(`${cc}|${p.day}`); });
    const near = (cc, d) => [-1, 0, 1].some(n => there.has(`${cc}|${new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10)}`));
    const runs = [];
    tx.filter(t => t.country && !home.has(t.country) && t.amount < 0).sort((a, b) => a.date.localeCompare(b.date)).forEach(t => {
      const r = runs.findLast(x => x.country === t.country);
      if (r && (Date.parse(t.date) - Date.parse(r.last)) / 864e5 <= 3) { r.last = t.date; r.items.push(t); } else runs.push({ country: t.country, first: t.date, last: t.date, items: [t] });
    });
    paidCache = { key, list: runs.filter(r => !r.items.some(t => near(r.country, t.date))).map(r => {
      const amounts = {};
      r.items.forEach(t => { amounts[t.currency] = Math.round(((amounts[t.currency] || 0) - t.amount) * 100) / 100; });
      return { key: `payments|${r.country}|${r.first}`, country: r.country, first: r.first, last: r.last, payments: r.items.length, amounts,
        examples: r.items.slice(0, 3).map(t => t.description) };
    }).filter(r => !no.has(r.key)).reverse() };
  }
  res.json(paidCache.list);
});

// Gaps (To check): trips abroad with no flight, train, bus or ferry around their first or last day (how did you get
// there or back?), and long runs of days nothing in Cairn has a place for. Each can be dismissed
let gapsCache = { key: '', value: null };
app.get('/api/suggestions/gaps', (_req, res) => {
  loadTowns();
  const no = dismissedSet(), today = new Date().toISOString().slice(0, 10);
  const key = [dataVersion, flights.length, trips.length, stays.length, no.size, today].join('|');
  if (gapsCache.key !== key) {
    const day = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
    const moved = new Set();  // every day with a flight, train, bus or ferry, and the day either side
    [...flights, ...trips].forEach(t => { const d = (t.date || '').slice(0, 10); if (d && t.approx !== 'year' && t.approx !== 'month') [-1, 0, 1].forEach(n => moved.add(day(d, n))); });
    // a ride, run or walk that day (a trip on your own power), or a rental car picked up or brought back
    activities.list().filter(x => !x.trainer && (x.distance || 0) >= 20).forEach(x => moved.add((x.date || '').slice(0, 10)));
    stays.filter(x => x.what === 'car').forEach(x => [x.start, x.end].forEach(d => d && [-1, 0, 1].forEach(n => moved.add(day(d.slice(0, 10), n)))));
    const home = new Set(Object.values(homePlaces()).filter(Boolean).map(t => t.cc));
    homeAirports().map(c => airports[c]).filter(Boolean).forEach(a => { const t = towns && cities.townAt(towns, a.lat, a.lon); if (t) home.add(t.cc); });
    const unreached = tripStore.list().filter(t => t.end < today && t.countries.some(c => !home.has(c.cc)))
      .map(t => ({ key: `gap-trip|${t.id}`, id: t.id, name: t.name, start: t.start, end: t.end, days: t.days, there: moved.has(t.start), back: moved.has(t.end) }))
      .filter(t => (!t.there || !t.back) && !no.has(t.key));
    const days = [...new Set(placesAndDays('', '').map(p => p.day).filter(d => d && d <= today))].sort(), quiet = [];
    for (let i = 1; i < days.length; i++) {
      const n = Math.round((Date.parse(days[i]) - Date.parse(days[i - 1])) / 864e5) - 1;
      if (n >= GAP_DAYS) quiet.push({ key: `gap-days|${day(days[i - 1], 1)}`, first: day(days[i - 1], 1), last: day(days[i], -1), days: n });
    }
    gapsCache = { key, value: { unreached: unreached.sort((a, b) => b.start.localeCompare(a.start)), quiet: quiet.filter(g => !no.has(g.key)).reverse() } };
  }
  res.json(gapsCache.value);
});
const GAP_DAYS = 30;

// The albums with photos that have no place of their own, where they are put, and your choices (albums.js)
app.get('/api/albums', (_req, res) => res.json(albums.ready() ? albums.albums() : { pending: true }));
app.get('/api/albums/photos', (req, res) => {  // ?album=: its photos with no place of their own
  const list = albums.albumPhotos(String(req.query.album || ''));
  return list ? res.json(list) : res.status(404).json({ error: 'no such album' });
});
app.get('/api/albums/thumb', async (req, res) => {  // ?album=&file=: only a photo that album has
  const file = albums.albumFile(String(req.query.album || ''), String(req.query.file || ''));
  const made = file && await photoIndex.thumbOfFile(file);
  if (!made) return res.status(404).end();
  res.set('Cache-Control', 'max-age=86400').type(made.type).sendFile(made.file);
});
// a place as the browser sends it ({ name, lat, lon }), false (not a place) or null (back to what the name gives)
const placeOfBody = p => (p === false || p === null ? p
  : p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon) ? { at: [+p.lat, +p.lon], name: String(p.name || '').slice(0, 120) } : undefined);
app.put('/api/albums/place', (req, res) => {  // { album, place }
  const place = placeOfBody(req.body?.place), album = String(req.body?.album || '');
  if (place === undefined || !albums.albumPhotos(album)) return res.status(400).json({ error: 'album and place (or false, or null) needed' });
  albums.chooseAlbum(album, place);
  res.json({ ok: true });
});
app.put('/api/albums/photos', (req, res) => {  // { album, files, place }: place false is not allowed here
  const place = placeOfBody(req.body?.place), album = String(req.body?.album || ''), have = albums.albumPhotos(album);
  const files = (req.body?.files || []).map(String).filter(f => have?.some(x => x.file === f));
  if (place === undefined || place === false || !files.length) return res.status(400).json({ error: 'album, files and place (or null) needed' });
  albums.choosePhotos(album, files, place);
  res.json({ ok: true, files: files.length });
});
app.get('/api/suggestions/albums/cover', async (req, res) => {  // ?key=album|<name>: only an album's own cover
  const file = albums.cover(String(req.query.key || ''));
  const made = file && await photoIndex.thumbOfFile(file);
  if (!made) return res.status(404).end();
  res.set('Cache-Control', 'max-age=86400').type(made.type).sendFile(made.file);
});
app.post('/api/suggestions/dismiss', (req, res) => {
  if (!req.body?.key) return res.status(400).json({ error: 'key is required' });
  suggestions.dismiss(String(req.body.key));
  res.json({ ok: true });
});

app.get('/api/curiosities', (_req, res) => res.json(curiosities.get() || { pending: true }));
app.get('/api/trips/:id', (req, res) => {
  const t = tripStore.get(req.params.id);
  return t ? res.json({ ...t, music: music.top({ from: t.start, to: t.end }), spending: spending.forTrip(t.start, t.end) }) : res.status(404).json({ error: 'no such trip' });
});

app.get('/api/cities', (req, res) => {
  loadTowns();
  if (!towns) return res.json([]);
  res.json(cities.rank(towns, placesAndDays(req.query.from || '', req.query.to || '')));
});

// Your places: the town you grew up in, the one you live in and the one you work in (data/home.json), each a GeoNames
// town { id, name, cc, lat, lon } or null; set in the settings, marked apart on the map
const HOME_FILE = path.join(DATA_DIR, 'home.json');
const HOME_ROLES = ['hometown', 'residence', 'work'];
// whether the trains between them count as 🔁 commutes in the distances and on the map (the settings; yes unless
// turned off)
function commutesCounted() {
  return readImport(HOME_FILE, {}).commutes !== false;
}

function homePlaces() {
  const h = readImport(HOME_FILE, {});
  return Object.fromEntries(HOME_ROLES.map(r => [r, h[r] || null]));
}

// What the map needs: the airports trips start from and return to (config), and your places
app.get('/api/settings', (_req, res) => {
  res.json({ home_airports: homeAirports(), home: homePlaces(), commutes: commutesCounted() });
});

// Towns by name, for picking your places: ?q=Chern
app.get('/api/towns', (req, res) => {
  loadTowns();
  if (!towns) return res.json([]);
  res.json(cities.search(towns, String(req.query.q || '')).map(t => ({ id: t.id, name: t.name, cc: t.cc, lat: t.lat, lon: t.lon, pop: t.pop })));
});

// { hometown, residence, work }: each a town id, or null to clear it; a role left out stays as it was; commutes: false
// leaves the commutes out
app.put('/api/home', (req, res) => {
  loadTowns();
  if (!towns) return res.status(503).json({ error: 'no town list (data/cities1000.txt)' });
  const home = homePlaces(), counted = 'commutes' in (req.body || {}) ? req.body.commutes !== false : commutesCounted();
  for (const r of HOME_ROLES) {
    if (!(r in (req.body || {}))) continue;
    const id = req.body[r];
    if (id === null || id === '') { home[r] = null; continue; }
    const t = cities.byId(towns, Number(id));
    if (!t) return res.status(400).json({ error: `no town ${id}` });
    home[r] = { id: t.id, name: t.name, cc: t.cc, lat: t.lat, lon: t.lon };
  }
  fs.writeFileSync(HOME_FILE, JSON.stringify(counted ? home : { ...home, commutes: false }, null, 1));
  res.json(home);
});

// --- TripIt iCal import ---

function parseTripItIcal(text) {
  const segments = [];
  const unfolded = text.replace(/\r?\n[ \t]/g, ''); // unfold continuation lines
  const blocks = unfolded.split(/BEGIN:VEVENT/);
  for (const block of blocks.slice(1)) {
    const field = key => {
      const m = block.match(new RegExp(`^${key}(?:;[^:]*)?:(.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    const summary = field('SUMMARY');
    const dtstart = field('DTSTART');
    const dtend   = field('DTEND');

    // Extract IATA codes: "... (AMS) to ... (LHR)"
    const iata = summary.match(/\(([A-Z]{3})\)\s+to\s+[^(]+\(([A-Z]{3})\)/);
    if (!iata) continue;
    const [, from, to] = iata;

    const dateM = dtstart.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!dateM) continue;
    const date = `${dateM[1]}-${dateM[2]}-${dateM[3]}`;

    const fnM = summary.match(/^([A-Z]{2,3})\s*(\d{1,4})\b/);
    const flight_number = fnM ? `${fnM[1]}${fnM[2]}` : '';

    let duration = '';
    const s = dtstart.match(/T(\d{2})(\d{2})(\d{2})/);
    const e = dtend.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
    const d = dtstart.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
    if (d && e) {
      const dep = new Date(`${d[1]}-${d[2]}-${d[3]}T${d[4]}:${d[5]}:${d[6]}Z`);
      const arr = new Date(`${e[1]}-${e[2]}-${e[3]}T${e[4]}:${e[5]}:${e[6]}Z`);
      const m = Math.round((arr - dep) / 60000);
      if (m > 0) duration = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    }

    segments.push({ date, from, to, flight_number, duration });
  }
  return segments;
}

app.post('/api/tripit/import-ical', async (req, res) => {  // { url }: your TripIt calendar feed
  const url = String(req.body?.url || '');
  let u = null;
  try { u = new URL(url); } catch (_) { /* not a URL */ }
  if (!u || u.protocol !== 'https:' || !(u.hostname === 'tripit.com' || u.hostname.endsWith('.tripit.com'))) {
    return res.status(400).json({ error: 'Provide a valid tripit.com iCal URL' });
  }
  let ical;
  try { ical = await httpsGet(url); } catch (e) { return res.status(502).json({ error: `Fetch failed: ${e.message}` }); }

  const segments = parseTripItIcal(ical);
  let imported = 0;
  for (const { date, from, to, flight_number, duration } of segments) {
    if (!from || !to || !date) continue;
    if (flights.some(f => f.date === date && f.from === from && f.to === to && f.flight_number === flight_number)) continue;
    const distance = (airports[from] && airports[to]) ? haversine(airports[from].lat, airports[from].lon, airports[to].lat, airports[to].lon) : 0;
    flights.push({ id: nextId(), date, from, to, flight_number, airline: '', distance, duration, seat: '', seat_type: '', class: '', plane: '', reason: '', registration: '', trip: '', note: '' });
    imported++;
  }
  if (imported > 0) {
    flights.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    saveFlights();
  }
  res.json({ imported, total: segments.length });
});

// --- TripIt OAuth 1.0a (optional — requires tripit_client_key + tripit_client_secret in secret) ---

const pendingTokens = new Map();

function oauthSign(method, url, params, cs, ts = '') {
  const base = Object.keys(params).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const sigBase = `${method.toUpperCase()}&${encodeURIComponent(url)}&${encodeURIComponent(base)}`;
  return createHmac('sha1', `${encodeURIComponent(cs)}&${encodeURIComponent(ts)}`).update(sigBase).digest('base64');
}

function oauthHeader(method, url, extra, ck, cs, tk = '', ts = '') {
  const p = { oauth_consumer_key: ck, oauth_nonce: randomBytes(16).toString('hex'), oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_version: '1.0', ...extra };
  if (tk) p.oauth_token = tk;
  p.oauth_signature = oauthSign(method, url, p, cs, ts);
  return 'OAuth ' + Object.keys(p).map(k => `${encodeURIComponent(k)}="${encodeURIComponent(p[k])}"`).join(', ');
}

function httpsPost(url, authHeader) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': 0 } }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject); req.end();
  });
}

app.get('/api/tripit/oauth-configured', (_req, res) => {
  res.json({ configured: !!(secret.tripit_client_key && secret.tripit_client_secret) });
});

app.get('/auth/tripit', async (_req, res) => {
  const ck = secret.tripit_client_key, cs = secret.tripit_client_secret;
  if (!ck || !cs) return res.status(503).send('TripIt OAuth not configured.');
  const cbUrl = `http://localhost:${config.port}/auth/tripit/callback`;
  const reqUrl = 'https://api.tripit.com/oauth/request_token';
  try {
    const { status, body } = await httpsPost(reqUrl, oauthHeader('POST', reqUrl, { oauth_callback: cbUrl }, ck, cs));
    if (status !== 200) return res.status(502).send(`TripIt error (${status}): ${body}`);
    const p = Object.fromEntries(new URLSearchParams(body));
    pendingTokens.set(p.oauth_token, p.oauth_token_secret);
    res.redirect(`https://www.tripit.com/oauth/authorize?oauth_token=${p.oauth_token}`);
  } catch (e) { res.status(500).send(`OAuth error: ${e.message}`); }
});

app.get('/auth/tripit/callback', async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;
  const reqSecret = pendingTokens.get(oauth_token);
  pendingTokens.delete(oauth_token);
  if (!reqSecret) return res.status(400).send('OAuth session expired — please try again.');
  const ck = secret.tripit_client_key, cs = secret.tripit_client_secret;
  const accUrl = 'https://api.tripit.com/oauth/access_token';
  try {
    const { status, body } = await httpsPost(accUrl, oauthHeader('POST', accUrl, { oauth_verifier }, ck, cs, oauth_token, reqSecret));
    if (status !== 200) return res.status(502).send(`TripIt token error (${status}): ${body}`);
    const acc = Object.fromEntries(new URLSearchParams(body));

    const apiUrl  = 'https://api.tripit.com/v1/list/object/type/air/format/json';
    const apiAuth = oauthHeader('GET', apiUrl, {}, ck, cs, acc.oauth_token, acc.oauth_token_secret);
    const apiData = await httpsGet(apiUrl + '?format=json', apiAuth);
    // httpsGet doesn't support headers; fetch via https.request
    const apiResult = await new Promise((resolve, reject) => {
      https.get({ hostname: 'api.tripit.com', path: '/v1/list/object/type/air/format/json', headers: { Authorization: apiAuth } }, r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, body: d }));
      }).on('error', reject);
    });
    if (apiResult.status !== 200) return res.status(502).send(`TripIt API error (${apiResult.status}): ${apiResult.body}`);

    const toArr = v => !v ? [] : Array.isArray(v) ? v : [v];
    const CLASS_MAP = { Economy: 'Y', PremiumEconomy: 'W', Business: 'C', BusinessClass: 'C', First: 'F', FirstClass: 'F' };
    const SEAT_MAP  = { Window: 'window', Aisle: 'aisle', Middle: 'middle' };
    const data = JSON.parse(apiResult.body);
    let imported = 0;
    for (const airObj of toArr(data.AirObject)) {
      for (const seg of toArr(airObj.AirSegment)) {
        const startDate = seg.StartDateTime?.date || seg.start_date || '';
        const startTime = seg.StartDateTime?.time || seg.start_time || '';
        const endDate   = seg.EndDateTime?.date   || seg.end_date   || '';
        const endTime   = seg.EndDateTime?.time   || seg.end_time   || '';
        const from = (seg.start_airport_code || '').toUpperCase();
        const to   = (seg.end_airport_code   || '').toUpperCase();
        const fn   = `${seg.marketing_airline_code || ''}${seg.marketing_flight_number || ''}`.trim();
        if (!from || !to || !startDate) continue;
        if (flights.some(f => f.date === startDate && f.from === from && f.to === to && f.flight_number === fn)) continue;
        let duration = '';
        try {
          const dep = new Date(`${startDate}T${startTime || '00:00'}:00`), arr = new Date(`${endDate}T${endTime || '00:00'}:00`);
          const m = Math.round((arr - dep) / 60000);
          if (m > 0) duration = `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
        } catch (_) {}
        const distance = (airports[from] && airports[to]) ? haversine(airports[from].lat, airports[from].lon, airports[to].lat, airports[to].lon) : 0;
        const seat = toArr(seg.Seats?.Seat)[0];
        flights.push({ id: nextId(), date: startDate, from, to, flight_number: fn, airline: seg.marketing_airline || '', distance, duration, seat: seat?.seat_assignment || '', seat_type: SEAT_MAP[seat?.seat_section] || '', class: CLASS_MAP[seg.service_class] || '', plane: seg.aircraft_display_name || '', reason: '', registration: '', trip: '', note: '' });
        imported++;
      }
    }
    if (imported > 0) { flights.sort((a, b) => (b.date || '').localeCompare(a.date || '')); saveFlights(); }
    res.redirect(`/?tripit=ok&imported=${imported}`);
  } catch (e) { res.status(500).send(`Import error: ${e.message}`); }
});

// --- Start ---

init().then(() => {
  const server = app.listen(config.port, config.host, () => {
    console.log(`Cairn running at http://${config.host}:${config.port}`);
    lookUpTrips();
    setInterval(lookUpTrips, 3600e3).unref();  // retries what a service that was down left over
    // the slow lists worked out now, not while the first page waits for them
    setTimeout(() => { try { activities.payload(); climbs.list(); tripStore.list(); } catch (e) { console.warn('[warm-up]', e.message); } }, 500);
    setTimeout(() => weather.fill(), 60e3);
    setTimeout(() => curiosities.get(), 90e3);
    setTimeout(() => albums.list(), 100e3);  // the albums read and their places looked up before anyone asks
    setTimeout(() => { tripStore.list(); yearReview.byYear(); }, 20e3);  // trips and the years side by side, worked out before anyone asks
    // the photos' thumbnails made ahead, in quiet moments (a page of them then opens at once); again every 6 hours for new ones
    setTimeout(() => photoIndex.warm(m => console.log(m)), 5 * 60e3);
    setInterval(() => photoIndex.warm(m => console.log(m)), 6 * 3600e3).unref();
    setInterval(() => prep.morning().catch(e => console.warn('[prep]', e.message)), 10 * 60e3).unref();  // once a day, after 07:30
    setTimeout(() => music.sync(), 120e3);
    setInterval(() => music.sync(), 6 * 3600e3).unref();
    setInterval(() => weather.fill(), 6 * 3600e3).unref();  // new rides, once the weather history has them
    if (strava.connected()) strava.sync();
    setInterval(() => { if (strava.connected()) strava.sync(); }, 3600e3).unref();
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[error] Port ${config.port} is already in use. Stop the other process or change port in config.`);
    } else {
      console.error('[error]', e.message);
    }
    process.exit(1);
  });
}).catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});
