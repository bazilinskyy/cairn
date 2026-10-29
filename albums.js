'use strict';
// Trips your Google Photos albums name: "Saint Petersburg - 2009", "Crimea 2011", "Kharkov 2008". Old photos often
// have no place (and Google's export can give them the day they were uploaded), so the photo suggestions cannot see
// those trips; the album's name still says where and when. Each album (of the Photos library, data/photo_albums.json
// written by imports/photos.py --albums; else of Google Takeout, the folder given as takeout_photos_dir in config) whose
// photos mostly have no place is suggested with the place and year of its name,
// unless a flight, train or stay already puts you there that year. The places are looked up once (Photon: a place of
// exactly that name; everyday words like "Autumn" or "Gigs" are not places), in the background, kept in data/albums.json.
// Their photos with no place of their own go on the map at the album's place (photoEntries): the place its name gives,
// or the one you chose for the album or for single photos of it (data/album_places.json). A photo whose date is the
// day Google got it (most of the album on one day) keeps only the album's year, so it makes no day anywhere.

const fs = require('fs');
const path = require('path');

const MEDIA = /\.(jpe?g|png|heic|gif|tiff?|bmp|webp|mov|mp4|m4v|3gp|avi|mkv|mts)$/i;
const SKIP = /^(Photos from \d{4}|Profile pictures|Cover photos|Instagram Photos|Untitled.*|Archive|Bin|Trash)$/i;
const NEAR_KM = 100;
const UPLOAD_ALBUMS = 3;  // a day most of this many albums are on is the day Google got them

// words in album names that are not places (a town called March, a hamlet called Autumn would otherwise match)
const NOT_PLACES = new Set(('january february march april may june july august september october november december spring summer autumn fall ' +
  'winter christmas easter new year holidays holiday break weekend trip tour visit live concert gig gigs festival football baseball ' +
  'hockey ice fishing kayaking skiing running marathon championship conference symposium workshop meeting graduation exchange ' +
  'erasmus school summer party wedding birthday profile pictures photos photo instagram cover book chapter photosession museum ' +
  'show classic car cars and of the in on at to with my our volume part final euro remont dachi retrotrain childhood family friends ' +
  'ii iii iv дача abandoned airfield jey pavlo jonathan isle hill hills river lake mountain mountains park beach city town village ' +
  'north south east west old new great little upper lower').split(' '));
// how specific a place is: a town before its region before its country
const RANK = { city: 0, town: 0, village: 0, hamlet: 0, suburb: 0, locality: 0, island: 0, islet: 0, peak: 0, cape: 0, water: 0, lake: 0,
  river: 1, bay: 1, county: 1, district: 1, municipality: 1, region: 2, state: 2, province: 2, archipelago: 2, peninsula: 2, country: 3, continent: 4 };
const AREAS = new Set(['country', 'state', 'region', 'province', 'county', 'island', 'islet', 'archipelago', 'peninsula', 'continent',
  'cape', 'peak', 'water', 'lake', 'bay', 'mountain_range', 'valley', 'river']);
const MIN_POP = 10000;    // a town named by a phrase of the album's name ("Saint Petersburg", "Fort William")
const WORD_POP = 50000;    // by a single word of it: smaller ones of that name are more often wrong than right
const BIG_CITY = 300000;   // another name of a town counts only for a city this big
let countries = null;
const isCountry = q => (countries = countries || countryNames()).has(norm(q));
function countryNames() {  // names of countries, which beat towns of the same name (Montenegro the country, not the town in Brazil)
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' }), out = new Set(['england', 'scotland', 'wales', 'northern ireland', 'crimea', 'europe']);
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const cc = String.fromCharCode(a, b), name = dn.of(cc);
      if (name && name !== cc) out.add(norm(name));
    }
    return out;
  } catch (_) { return new Set(); }
}
const norm = s => (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// The places to try for an album's name, best first: what follows "in" ("GA of EMA in Krakow"), the whole name
// without its everyday words, then its parts (longest first): "Montenegro Albania Herzogovina" -> ..., "Montenegro"
function candidates(place) {
  const words = place.replace(/[.!?]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  const inAt = words.map(norm).lastIndexOf('in');
  if (inAt >= 0 && inAt < words.length - 1) out.push(words.slice(inAt + 1).filter(w => !NOT_PLACES.has(norm(w))).join(' '));
  const kept = words.filter(w => !NOT_PLACES.has(norm(w)) && !/^\d+$/.test(w) && w.length > 1);
  if (!kept.length) return out;
  if (kept.length < words.length || kept.length > 1) out.push(words.join(' '));  // as written: "Ring of Kerry"
  out.push(kept.join(' '));
  for (let i = kept.length - 1; i >= 0; i--) out.push(kept[i]);  // one word, the last first: "... and Birmingham"
  for (let i = 0; i + 2 <= kept.length; i++) out.push(kept.slice(i, i + 2).join(' '));
  return [...new Set(out)].filter(q => !words.every(w => NOT_PLACES.has(norm(w)))).slice(0, 6);
}

// "Copy of Crimea 2011" -> { place: "Crimea", year: 2011 }; "Saint Petersburg - 2009" -> Saint Petersburg, 2009
function parse(name) {
  const clean = name.replace(/^(Copy of|Facebook:) /i, '').replace(/\s*\(.*?\)/g, '');  // "Chernihiv (Chernigov), Ukraine": Chernihiv, Ukraine
  const m = clean.match(/\b(19[5-9]\d|20[0-4]\d)\b/);
  const place = clean.replace(/\b(19[5-9]\d|20[0-4]\d)\b/g, '').replace(/\bpart\s*\d+\b/ig, '').replace(/[-–_,()]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { place, year: m ? +m[1] : null };
}

// towns: () => the town grid (cities.js: GeoNames' towns, with their other names when over 50,000 people)
// near(year): where your data puts you that year ([lat, lon], or null), to choose between towns of the same name
function create({ dir, cacheFile, placesFile, km, towns, near = () => null, flights, airports, groundTrips, stays, dismissed, log = console.log }) {
  let scanned = { dir: null, at: 0, list: null }, scanning = false, cache = null, looking = false;
  const scanFile = cacheFile.replace(/\.json$/, '.scan.json');
  // your choices: { albums: { name: { at, name } or false (not a place) }, photos: { 'album/file': { at, name } } }
  let chosen = null;
  const choices = () => {
    if (!chosen) { try { chosen = JSON.parse(fs.readFileSync(placesFile, 'utf8')); } catch (_) { chosen = {}; } }
    chosen.albums = chosen.albums || {};
    chosen.photos = chosen.photos || {};
    return chosen;
  };
  const saveChoices = () => { fs.writeFileSync(placesFile, JSON.stringify(choices(), null, 1)); entries = null; };
  const loadCache = () => {
    if (!cache) { try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) { cache = {}; } }
    return cache;
  };

  // the albums: read in the background (thousands of small sidecar files take a minute), again at most once an hour;
  // until the first reading is done, none
  function scan() {
    const root = dir();
    if (!root || !fs.existsSync(root)) return [];
    if (!scanned.list) {  // the last reading, kept (shown at once after a restart, read again in the background)
      try { const kept = JSON.parse(fs.readFileSync(scanFile, 'utf8')); if (kept.dir === root) scanned = { ...kept, at: 0 }; } catch (_) {}
    }
    if (!scanning && (scanned.dir !== root || Date.now() - scanned.at > 3600e3)) {
      scanning = true;
      read(root).then(list => { scanned = { dir: root, at: Date.now(), list }; fs.writeFileSync(scanFile, JSON.stringify(scanned)); })
        .catch(e => log(`[albums] ${e.message}`)).finally(() => { scanning = false; });
    }
    return scanned.dir === root && scanned.list ? scanned.list : [];
  }
  // the albums of a Photos library (photos.py --albums): [{ album, photos: [[name, file, time, placed]] }]
  function readLibrary(file) {
    const list = [];
    for (const { album: name, photos } of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      if (SKIP.test(name) || !photos.length) continue;
      const days = new Map(), loose = [];
      for (const [f, file, t, here] of photos) {
        if (t) { const d = new Date(t * 1000).toISOString().slice(0, 10); days.set(d, (days.get(d) || 0) + 1); }
        if (!here) loose.push([f, t, file]);
      }
      if (!loose.length) continue;
      const { place, year } = parse(name);
      const cover = photos.find(([f]) => /\.(jpe?g|png|heic)$/i.test(f)) || photos[0];
      list.push({ key: 'album|' + name, album: name, photos: photos.length, placed: photos.length - loose.length, place, year, days,
        cover: cover[1], loose, suggest: loose.length > photos.length / 2 });
    }
    return list;
  }
  async function read(root) {
    const list = root.endsWith('.json') ? readLibrary(root) : [];
    for (const name of root.endsWith('.json') ? [] : fs.readdirSync(root).sort()) {
      const folder = path.join(root, name);
      if (SKIP.test(name) || !fs.statSync(folder).isDirectory()) continue;
      const files = fs.readdirSync(folder).filter(f => MEDIA.test(f));
      if (!files.length) continue;
      let placed = 0;
      const days = new Map(), loose = [];  // loose: [file, time] of the photos with no place of their own
      for (const f of files) {
        let t = 0, here = false;
        try {
          const s = JSON.parse(await fs.promises.readFile(path.join(folder, f + '.supplemental-metadata.json'), 'utf8'));
          here = !!(s.geoData?.latitude || s.geoDataExif?.latitude);
          t = +s.photoTakenTime?.timestamp || 0;
          if (t) { const d = new Date(t * 1000).toISOString().slice(0, 10); days.set(d, (days.get(d) || 0) + 1); }
        } catch (_) { /* no sidecar */ }
        if (here) placed++;
        else loose.push([f, t]);
      }
      if (!loose.length) continue;
      const { place, year } = parse(name);
      const cover = files.find(f => /\.(jpe?g|png|heic)$/i.test(f)) || files[0];
      list.push({ key: 'album|' + name, album: name, photos: files.length, placed, place, year, days,
        cover: path.join(folder, cover), loose, suggest: placed < files.length / 2 });
    }
    // the photos' dates, unless most of the album is on a day most of several albums are on: the day Google got them,
    // not the day they were taken (an album of a day trip has all its photos on its one day, and that day is true)
    const topDay = a => [...a.days].sort((x, y) => y[1] - x[1])[0];
    const mostlyOn = new Map();
    list.forEach(a => {
      const top = topDay(a), n = [...a.days.values()].reduce((x, y) => x + y, 0);
      if (top && top[1] >= n * 0.8) mostlyOn.set(top[0], (mostlyOn.get(top[0]) || 0) + 1);
    });
    return list.map(({ days, ...a }) => {
      const top = topDay({ days }), n = [...days.values()].reduce((x, y) => x + y, 0), sorted = [...days.keys()].sort();
      const dated = top && !(top[1] >= n * 0.8 && (mostlyOn.get(top[0]) || 0) >= UPLOAD_ALBUMS) ? { first: sorted[0], last: sorted[sorted.length - 1] } : null;
      return { ...a, year: a.year || (dated ? +dated.first.slice(0, 4) : null), ...(dated || {}) };
    });
  }

  // the towns of exactly this name (GeoNames), at least `pop` people: by their own name, or by another name only for
  // a big city ("Kharkov" is Kharkiv, "Kiev" Kyiv; not "Egypt" for a town in Arizona)
  let byName = null;
  function townsNamed(q, pop) {
    if (!byName) {
      byName = new Map();
      const add = (n, t, own) => { if (!byName.has(n)) byName.set(n, []); byName.get(n).push({ t, own }); };
      for (const list of (towns() || new Map()).values()) for (const t of list) {
        const own = new Set([norm(t.name)]);
        for (const n of t.names) add(n, t, own.has(n));
      }
    }
    const n = norm(q).replace(/^st\.? /, 'saint '), alt = norm(q).replace(/^saint /, 'st ');
    return [...(byName.get(n) || []), ...(byName.get(alt) || [])]
      .filter(({ t, own }) => t.pop >= pop && (own || (t.pop >= BIG_CITY && n.length >= 4))).map(({ t }) => t);
  }
  // of towns of the same name, the one nearest to where you were that year; else the biggest
  function pickTown(list, year) {
    if (!list.length) return null;
    const bias = year ? near(year) : null;
    const t = [...list].sort((a, b) => (bias ? km([a.lat, a.lon], bias) - km([b.lat, b.lon], bias) : b.pop - a.pop))[0];
    return { at: [t.lat, t.lon], name: t.name, rank: 0, pop: t.pop };
  }

  // a country, region, island or natural place of exactly this name (Photon), or null; never a village: those are
  // the towns' to find, and a village abroad of the same name is the usual wrong answer
  // one request at a time, a second apart, for every caller (the albums and the to-do trips look up at once)
  let queue = Promise.resolve();
  const photon = params => (queue = queue.then(async () => {
    await new Promise(r => setTimeout(r, 1100));
    const res = await fetch(`https://photon.komoot.io/api/?${new URLSearchParams(params)}`,
      { headers: { 'User-Agent': 'cairn (personal travel log; https://github.com/bazilinskyy/cairn)' }, signal: AbortSignal.timeout(30000) });
    if (res.status === 429 || res.status === 403 || res.status >= 500) throw new Error(`Photon: HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }));
  async function exactly(q) {
    // in English first ("Canary Islands"), then as the place calls itself ("Mallorca", which is Majorca in English)
    for (const lang of ['en', '']) {
      const d = await photon({ q, limit: '5', ...(lang ? { lang } : {}) });
      const f = (d.features || []).find(x => AREAS.has(x.properties.osm_value) &&
        [x.properties.name, x.properties['name:en']].some(n => norm(n) === norm(q)));
      if (f) return { at: [f.geometry.coordinates[1], f.geometry.coordinates[0]], name: f.properties.name, rank: RANK[f.properties.osm_value] ?? 2 };
    }
    return null;
  }

  // the places of the albums' names, the candidates of each tried in turn, one a second, kept
  // the place an album's name gives: its phrases first ("in Krakow", "Saint Petersburg", "Ring of Kerry": the first
  // found wins), else its single words, of which the most specific (Chernihiv over Ukraine) and only a big town
  async function placeOf(n, year) {
    const qs = candidates(n), phrases = qs.filter(q => q.includes(' ') || q === n), words = qs.filter(q => !phrases.includes(q));
    for (const q of phrases) {
      const hit = (isCountry(q) && await exactly(q)) || pickTown(townsNamed(q, MIN_POP), year) || await exactly(q);
      if (hit) return hit;
    }
    let found = null;
    for (const q of words) {
      const hit = (isCountry(q) && await exactly(q)) || pickTown(townsNamed(q, WORD_POP), year) || await exactly(q);
      if (hit && (!found || hit.rank < found.rank)) found = hit;
    }
    return found;
  }

  function lookUp(albums) {
    if (looking || !albums.length) return;
    looking = true;
    (async () => {
      const c = loadCache();
      for (const { place: n, year } of albums) {
        let found = null;
        try { found = await placeOf(n, year); } catch (e) { log(`[albums] lookups paused: ${e.message}`); break; }
        c[n] = found && { at: found.at, name: found.name };
        fs.writeFileSync(cacheFile, JSON.stringify(c));
      }
      looking = false;
    })();
  }

  // already known: a flight, train, bus, ferry or stay within NEAR_KM of the place in that year
  function known(at, year) {
    const y = String(year), near = p => p && km(p, at) <= NEAR_KM, ap = airports();
    return flights().some(f => (f.date || '').startsWith(y) && (near(ap[f.to] && [ap[f.to].lat, ap[f.to].lon]) || near(ap[f.from] && [ap[f.from].lat, ap[f.from].lon]))) ||
      groundTrips().some(t => (t.date || '').startsWith(y) && (near(t.to_lat != null && [t.to_lat, t.to_lon]) || near(t.from_lat != null && [t.from_lat, t.from_lon]))) ||
      stays().some(s => (s.start || '').startsWith(y) && near(s.lat != null && [s.lat, s.lon]));
  }

  const ready = () => !!scanned.list;
  function list() {
    const c = loadCache(), no = dismissed();
    const albums = scan().filter(a => a.suggest && !no.has(a.key));
    const todo = new Map();
    albums.forEach(a => { if (a.place && !(a.place in c) && !todo.has(a.place)) todo.set(a.place, a); });
    lookUp([...todo.values()]);
    return albums.map(a => {
      const hit = c[a.place];
      return { ...a, place: hit ? hit.name : a.place, lat: hit ? hit.at[0] : null, lon: hit ? hit.at[1] : null, looked_up: a.place in c };
    }).filter(a => !(a.lat != null && a.year && known([a.lat, a.lon], a.year))).map(({ cover, loose, suggest, ...a }) => a);
  }

  // --- the albums' photos with no place of their own, on the map ---

  // where an album is: your choice (false: not a place), else the town its name gives (a country or a region would
  // put its photos in its middle: those wait for your choice); { at, name, by } or null
  const isTown = hit => townsNamed(hit.name, 1).some(t => km([t.lat, t.lon], hit.at) < 30);
  function albumPlace(a) {
    const mine = choices().albums[a.album];
    if (mine === false) return null;
    if (mine) return { ...mine, by: 'you' };
    const hit = a.place ? loadCache()[a.place] : null;
    return hit && isTown(hit) ? { at: hit.at, name: hit.name, by: 'name' } : null;
  }
  const yearOf = a => (a.year ? Date.UTC(a.year, 0, 1, 12) / 1000 : null);
  // [time, lat, lon, file, 'a' (placed by its album) or 'y' (and only its year known)], made again when anything changed
  let entries = null, entriesKey = '';
  function photoEntries() {
    const list = scan(), key = `${scanned.at}|${Object.keys(loadCache()).length}`;
    if (entries && entriesKey === key) return entries;
    const c = choices(), out = [];
    for (const a of list) {
      const place = albumPlace(a), root = dir();
      for (const [f, t, file] of a.loose || []) {
        const at = (c.photos[`${a.album}/${f}`] || place)?.at;
        if (!at) continue;
        // the photo's date when the album's dates are the photos' own; else only a year: the album's, else Google's
        const own = a.first && t, when = own ? t : yearOf(a) || t || (a.first ? Date.parse(a.first) / 1000 : 0);
        if (!when) continue;
        out.push([when, at[0], at[1], file || path.join(root, a.album, f), own ? 'a' : 'y']);
      }
    }
    entries = out;
    entriesKey = key;
    return out;
  }

  // the albums with photos that have no place of their own, for choosing where they are
  function albums() {
    const c = choices();
    return scan().map(a => ({ key: a.key, album: a.album, photos: a.photos, loose: (a.loose || []).length, year: a.year, first: a.first || null,
      last: a.last || null, place: albumPlace(a), notPlace: c.albums[a.album] === false,
      own: (a.loose || []).filter(([f]) => c.photos[`${a.album}/${f}`]).length }))
      .filter(a => a.loose);
  }
  // an album's photos with no place of their own: [{ file, t, place }] (place: chosen for the photo)
  function albumPhotos(name) {
    const a = scan().find(x => x.album === name), c = choices();
    return a ? (a.loose || []).map(([f, t]) => ({ file: f, t: a.first ? t : null, place: c.photos[`${a.album}/${f}`] || null })) : null;
  }
  // a file of an album's photos (for its thumbnail), only one the album has
  function albumFile(name, file) {
    const a = scan().find(x => x.album === name);
    const hit = a && (a.loose || []).find(([f]) => f === file);
    return hit ? hit[2] || path.join(dir(), a.album, file) : null;
  }
  // your choice for an album: { at, name }, false (not a place) or null (back to what its name gives)
  function chooseAlbum(name, place) {
    const c = choices();
    if (place === null) delete c.albums[name]; else c.albums[name] = place;
    saveChoices();
  }
  // for some of an album's photos: { at, name }, or null (back to the album's place)
  function choosePhotos(name, files, place) {
    const c = choices();
    files.forEach(f => { if (place) c.photos[`${name}/${f}`] = place; else delete c.photos[`${name}/${f}`]; });
    saveChoices();
  }

  const cover = key => scan().find(a => a.key === key)?.cover || null;
  // where a name is ("Gent", "Canary Islands"): as for the albums, kept with them; [lat, lon] and the name, or null
  async function locate(name, year) {
    const c = loadCache();
    if (!(name in c)) { const hit = await placeOf(name, year); c[name] = hit && { at: hit.at, name: hit.name }; fs.writeFileSync(cacheFile, JSON.stringify(c)); }
    return c[name];
  }
  return { list, cover, ready, locate, photoEntries, albums, albumPhotos, albumFile, chooseAlbum, choosePhotos };
}

module.exports = { create, parse, candidates };
