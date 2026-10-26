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
      lon:     parseFloat(f[7])
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

function saveFlights() {
  fs.writeFileSync(FLIGHTS_FILE, JSON.stringify(flights, null, 2));
}

function nextId(list = flights) {
  return list.reduce((max, f) => Math.max(max, f.id || 0), 0) + 1;
}

function saveTrips() {
  fs.writeFileSync(GROUND_FILE, JSON.stringify(trips, null, 2));
}

function saveStays() {
  fs.writeFileSync(STAYS_FILE, JSON.stringify(stays, null, 2));
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
  } catch (_) {
    return empty;
  }
}

// Places and tracks of new ground trips and places of stays, one pass at a time, when ground_lookups is on
let lookingUp = false, lookAgain = false;
function lookUpTrips() {
  if (!config.ground_lookups) return;
  if (lookingUp) { lookAgain = true; return; }
  lookingUp = true;
  // seen: where everything but the stays puts you on those days, to place a stay by
  const seen = (from, to) => placesAndDays(from, to, { stays: false }).map(p => p.at);
  const store = { trips, stays, flights: () => flights, airports: () => airports, save: saveTrips, saveStays, seen };
  ground.enrich(store).catch(e => console.warn('[ground]', e.message)).finally(() => {
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

app.post('/api/flights', (req, res) => {
  const f = req.body;
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

app.get('/api/ground', (_req, res) => {
  res.json(trips);
});

// One trip per calendar event, and one per departure minute and mode: posting the same trip again updates it
app.post('/api/ground', (req, res) => {
  const t = req.body;
  if (!t.mode || !t.from || !t.to || !t.date) return res.status(400).json({ error: 'mode, from, to and date are required' });
  const same = trips.find(x => (t.event_id && x.event_id === t.event_id)
    || (x.mode === t.mode && (x.date || '').slice(0, 16) === t.date.slice(0, 16)));
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

app.put('/api/ground/:id', (req, res) => {
  const t = trips.find(x => x.id === Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'no such trip' });
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

// --- Stays and rental cars (from flightmail), photos and Timeline (from the import scripts) ---

app.get('/api/stays', (_req, res) => {
  res.json(stays);
});

// One per booking code: posting the same booking again updates it
app.post('/api/stays', (req, res) => {
  const s = req.body;
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
    ground.forgetStay(same, changes);
    Object.assign(same, changes);
  } else {
    s.id = nextId(stays);
    stays.push(s);
  }
  saveStays();
  lookUpTrips();
  res.json(same || s);
});

app.put('/api/stays/:id', (req, res) => {
  const s = stays.find(x => x.id === Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'no such stay' });
  const { id, ...changes } = req.body;
  ground.forgetStay(s, changes);
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
app.get('/api/timeline', (_req, res) => res.json(readImport(TIMELINE_FILE, { visits: [], paths: [] })));

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
  profile: () => readImport(GARMIN_FILE, NO_GARMIN).profile, trackDir: path.join(DATA_DIR, 'tracks'),
  towns: () => (towns === undefined ? (towns = cities.load(path.join(DATA_DIR, 'cities1000.txt'))) : towns)
});
app.get('/api/climbs', (_req, res) => res.json(climbs.list()));
// one effort up a climb, point by point: /api/climbs/Q209064/efforts/<activity id>?from=Bédoin
app.get('/api/climbs/:id/efforts/:ride', (req, res) => {
  const e = climbs.effort(req.params.id, req.params.ride, req.query.from || '');
  e ? res.json(e) : res.status(404).json({ error: 'no such effort (or no timed track for it)' });
});
app.get('/api/strava/status', (_req, res) => res.json(strava.status()));

// Where you ride, run and so on: start towns and countries per kind of sport (as the Sports tab groups them)
const SPORT_KINDS = { ride: /Ride|Velomobile|Handcycle|Wheelchair/, run: /Run/, walk: /Walk|Hike|Snowshoe/ };
app.get('/api/activities/places', (_req, res) => {
  if (towns === undefined) towns = cities.load(path.join(DATA_DIR, 'cities1000.txt'));
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

let towns;  // GeoNames towns, read on first use (flightmail downloads data/cities1000.txt)

// Each day and place you were somewhere, in the period ?from=YYYY-MM-DD&to=YYYY-MM-DD (both optional)
function placesAndDays(from, to, { stays: withStays = true } = {}) {
  const pts = [], inPeriod = d => d && (!from || d >= from) && (!to || d <= to);
  const add = (at, d, city) => { if (at && inPeriod(d)) pts.push({ at, day: d, city }); };
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
    if (t.from_lat != null) add([t.from_lat, t.from_lon], (t.date || '').slice(0, 10));
    if (t.to_lat != null) add([t.to_lat, t.to_lon], (t.date || '').slice(0, 10));
  });
  if (withStays) stays.forEach(s => {
    if (s.lat == null) return;
    if (s.what === 'car') add([s.lat, s.lon], s.start);
    else eachDay(s.start, s.end, d => add([s.lat, s.lon], d));
  });
  readImport(PHOTOS_FILE, []).forEach(c => (c.days || []).forEach(d => add([c.lat, c.lon], d)));
  (readImport(TIMELINE_FILE, {}).visits || []).forEach(v => eachDay(v.start.slice(0, 10), v.end.slice(0, 10), d => add([v.lat, v.lon], d)));
  activities.list().forEach(a => add(a.at, (a.date || '').slice(0, 10)));
  return pts;
}

// --- Countries as a list counts them: ISO codes, sovereign countries, Travelers' Century Club (regions.js) ---

const regions = regionLists.create({ file: path.join(DATA_DIR, 'admin1.geojson'), download: httpsGet });

// Per country (of the town each place belongs to): days there, separate visits, towns, first and last day, from every
// source; and what happened there: nights in stays, flights in, trains, buses and ferries (from or to it), rental
// cars, sports activities and their km, photos
app.get('/api/countries', async (req, res) => {
  if (towns === undefined) towns = cities.load(path.join(DATA_DIR, 'cities1000.txt'));
  if (!towns) return res.json([]);
  // ?scheme=iso|un|tcc: countries as that list counts them (regions.js); otherwise the town's country code
  const scheme = regions.SCHEMES.includes(req.query.scheme) ? req.query.scheme : null;
  if (scheme) {
    try { await regions.ready(); } catch (e) { return res.status(502).json({ error: `Country map: ${e.message}` }); }
  }
  const from = req.query.from || '', to = req.query.to || '';
  const inPeriod = d => d && (!from || d >= from) && (!to || d <= to);
  const memo = new Map();
  const townOf = (at, city) => {
    if (!at) return null;
    const key = at[0].toFixed(2) + ',' + at[1].toFixed(2) + (city ? '|' + city : '');
    if (!memo.has(key)) memo.set(key, (city && cities.townNamed(towns, city, at[0], at[1])) || cities.townAt(towns, at[0], at[1]));
    return memo.get(key);
  };
  const all = {};
  const of = (at, city) => {
    if (!at) return null;
    const place = scheme ? regions.placeNow(scheme, at[0], at[1]) : townOf(at, city);
    if (!place) return null;
    const id = scheme ? place.id : place.cc;
    return all[id] = all[id] || { country: id, name: scheme ? place.name : undefined, days: new Set(), towns: new Set(), nights: 0,
      flights: 0, train: 0, bus: 0, ferry: 0, cars: 0, activities: 0, km: 0, photos: 0 };
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
    if (!inPeriod((t.date || '').slice(0, 10)) || !['train', 'bus', 'ferry'].includes(t.mode)) return;
    new Set([of(t.from_lat != null && [t.from_lat, t.from_lon]), of(t.to_lat != null && [t.to_lat, t.to_lon])]).forEach(v => { if (v) v[t.mode]++; });
  });
  stays.forEach(s => {
    const v = s.lat != null && inPeriod(s.start) && of([s.lat, s.lon]);
    if (!v) return;
    if (s.what === 'car') v.cars++;
    else v.nights += Math.max(1, Math.round((Date.parse(s.end || s.start) - Date.parse(s.start)) / 864e5));
  });
  activities.list().forEach(a => {
    const v = inPeriod((a.date || '').slice(0, 10)) && of(a.at);
    if (v) { v.activities++; v.km += a.distance || 0; }
  });
  readImport(PHOTOS_FILE, []).forEach(c => {
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

// One town, for its report page: the days and separate visits there, and everything done there in the period (?from=
// &to=): stays and rental cars, flights in and out, trains, buses and ferries from or to it, sports activities that
// started there, photos per day, Timeline places. A place belongs to a town as for the most visited cities.
app.get('/api/city/:id', (req, res) => {
  if (towns === undefined) towns = cities.load(path.join(DATA_DIR, 'cities1000.txt'));
  if (!towns) return res.status(503).json({ error: 'no town list (data/cities1000.txt)' });
  const id = Number(req.params.id);
  let town = null;
  for (const list of towns.values()) { town = list.find(t => t.id === id); if (town) break; }
  if (!town) return res.status(404).json({ error: 'no such town' });
  const from = req.query.from || '', to = req.query.to || '';
  const inPeriod = d => d && (!from || d >= from) && (!to || d <= to);
  const memo = new Map();
  const here = (at, city) => {
    if (!at || at[0] == null) return false;
    const key = (+at[0]).toFixed(2) + ',' + (+at[1]).toFixed(2) + (city ? '|' + city : '');
    if (!memo.has(key)) memo.set(key, (city && cities.townNamed(towns, city, at[0], at[1])) || cities.townAt(towns, at[0], at[1]));
    return memo.get(key) === town;
  };
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
  const staysHere = stays.filter(s => s.lat != null && (inPeriod(s.start) || inPeriod(s.end)) && here([s.lat, s.lon]))
    .map(s => ({ id: s.id, what: s.what, start: s.start, end: s.end, place: s.place, hotel: s.hotel, type: s.type, provider: s.provider, price: s.price }));
  const activitiesHere = activities.list().filter(a => a.at && inPeriod((a.date || '').slice(0, 10)) && here(a.at))
    .map(a => ({ id: a.id, date: a.date, name: a.name, sport: a.sport, distance: a.distance, moving_time: a.moving_time, elevation: a.elevation, trainer: a.trainer }));
  const photoDays = new Map();
  readImport(PHOTOS_FILE, []).forEach(c => {
    const ds = (c.days || []).filter(inPeriod);
    if (!ds.length || !here([c.lat, c.lon])) return;
    const each = (c.count || 0) / (c.days || []).length;  // a cell knows its days and its total: spread evenly
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
    photos: [...photoDays].map(([day, n]) => ({ day, count: Math.max(1, Math.round(n)) })).sort(sortBy('day')),
    timeline: timelineHere.sort(sortBy('start'))
  });
});

app.get('/api/cities', (req, res) => {
  if (towns === undefined) towns = cities.load(path.join(DATA_DIR, 'cities1000.txt'));
  if (!towns) return res.json([]);
  res.json(cities.rank(towns, placesAndDays(req.query.from || '', req.query.to || '')));
});

// What the map needs from config: the airports trips start from and return to
app.get('/api/settings', (_req, res) => {
  res.json({ home_airports: config.flightmail?.home_airports || ['AMS', 'EIN', 'RTM'] });
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

app.get('/api/tripit/import-ical', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.startsWith('https://') || !url.includes('tripit.com')) {
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
    console.log(`Contrail running at http://${config.host}:${config.port}`);
    lookUpTrips();
    setInterval(lookUpTrips, 3600e3).unref();  // retries what a service that was down left over
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
