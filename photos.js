'use strict';
// Every photo with its place, time and file (data/photo_points.json, written by imports/photos.py --points on the Mac
// that runs Cairn): for the photo layer, trips and the city pages. Each photo gets a short id from its file path; the
// browser gets [id, unix time, lat, lon], and asks for a thumbnail or the whole photo by id, made with macOS's sips
// (HEIC to JPEG) and kept in data/photo_cache. Only files in the index are ever served. extra(): photos placed some
// other way, [time, lat, lon, file, how] (albums.js: 'a' placed by its album, 'y' and only its year known); the browser
// gets `how` as a fifth item after the video flag.
// Thumbnails (THUMB px): a photo of the Photos library has one already (its own 360 x 480 preview, under
// resources/derivatives/masters), served as it is; the others are made with sips, at most CONVERTING at a time (the
// first asked, the first made), and made ahead in the background (warm), slowly and at low priority, so a page full of
// photos opens at once.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');

const VIDEO = /\.(mov|mp4|m4v|3gp|avi|mkv)$/i;
const THUMB = 360, OLD_THUMB = 480, CONVERTING = 3;
const LIBRARY = /^(.*\.photoslibrary)\/originals\/([0-9A-F])\/([0-9A-F-]+)\.[^/]+$/i;
const TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.3gp': 'video/3gpp' };

// the jobs that convert photos: at most CONVERTING at once, the oldest asked first; the background's only when idle
const jobs = [];
let running = 0;
function convert(cmd, args, background = false) {
  return new Promise(resolve => {
    jobs.push({ cmd, args, background, resolve });
    next();
  });
}
function next() {
  while (running < CONVERTING && jobs.length) {
    const i = jobs.findIndex(j => !j.background);
    if (i < 0 && running > 0) return;  // background work waits for a quiet moment
    const job = jobs.splice(i < 0 ? 0 : i, 1)[0];
    running++;
    const [cmd, args] = job.background ? ['nice', ['-n', '19', job.cmd, ...job.args]] : [job.cmd, job.args];
    execFile(cmd, args, { timeout: 60000 }, err => { running--; job.resolve(err); next(); });
  }
}

// the Photos library's own preview of one of its photos, or null
function libraryPreview(file) {
  const m = LIBRARY.exec(file || '');
  if (!m) return null;
  const p = path.join(m[1], 'resources', 'derivatives', 'masters', m[2], `${m[3]}_4_5005_c.jpeg`);
  return fs.existsSync(p) ? p : null;
}

function create({ file, cache, readImport, extra = () => [] }) {
  let loaded = { raw: null, more: null }, builds = 0;
  function index() {
    const raw = readImport(file, []), more = extra();
    if (loaded.raw !== raw || loaded.more !== more) {
      const byId = new Map(), list = [];
      for (const [t, lat, lon, p, how] of [...raw, ...more]) {
        const id = crypto.createHash('sha1').update(p || `${t},${lat},${lon}`).digest('hex').slice(0, 12);
        if (byId.has(id)) continue;
        byId.set(id, { t, lat, lon, path: p, how });
        list.push(how ? [id, t, lat, lon, p && VIDEO.test(p) ? 1 : 0, how] : [id, t, lat, lon, p && VIDEO.test(p) ? 1 : 0]);
      }
      const json = Buffer.from(JSON.stringify(list));
      loaded = { raw, more, byId, list, json, gz: zlib.gzipSync(json), etag: `"${list.length}-${++builds}-${Date.now()}"` };
    }
    return loaded;
  }
  // a JPEG of the photo, at most `size` pixels wide or high (0: as it is), made once
  function jpeg(id, size) {
    const p = index().byId.get(id);
    return p ? jpegOf(id, p.path, size) : Promise.resolve(null);
  }
  // a made one already there: this size, or a thumbnail made at the older size
  function made(id, size) {
    for (const s of size === THUMB ? [THUMB, OLD_THUMB] : [size || 'full']) {
      for (const ext of ['jpg', 'png']) {
        const f = path.join(cache, `${id}-${s}.${ext}`);
        if (fs.existsSync(f)) return { file: f, type: ext === 'png' ? 'image/png' : 'image/jpeg' };
      }
    }
    return null;
  }
  async function jpegOf(id, file, size, background = false) {
    if (!file || !fs.existsSync(file)) return null;
    if (VIDEO.test(file) && !size) return { file, type: TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' };  // a video in full: itself
    const preview = size === THUMB && libraryPreview(file);
    if (preview) return { file: preview, type: 'image/jpeg' };
    const have = made(id, size);
    if (have) return have;
    const out = path.join(cache, `${id}-${size || 'full'}.jpg`);
    fs.mkdirSync(cache, { recursive: true });
    if (VIDEO.test(file)) {  // Quick Look makes a picture of a video's first frame
      const err = await convert('qlmanage', ['-t', '-s', String(size), '-o', cache, file], background);
      const png = path.join(cache, path.basename(file) + '.png');
      if (err || !fs.existsSync(png)) return null;
      fs.renameSync(png, out.replace(/\.jpg$/, '.png'));
      return { file: out.replace(/\.jpg$/, '.png'), type: 'image/png' };
    }
    const err = await convert('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', ...(size ? ['-Z', String(size)] : []), file, '--out', out], background);
    return err || !fs.existsSync(out) ? null : { file: out, type: 'image/jpeg' };
  }

  // every photo's thumbnail made ahead, one at a time in quiet moments (a run goes on until all are made, or stops
  // when the index changes: the next run picks up)
  let warming = false;
  async function warm(log = () => {}) {
    if (warming) return;
    warming = true;
    try {
      const { list, byId } = index();
      let n = 0;
      for (const [id] of list) {
        if (index().list !== list) break;
        const p = byId.get(id);
        if (!p?.path || libraryPreview(p.path) || made(id, THUMB) || !fs.existsSync(p.path)) continue;
        await jpegOf(id, p.path, THUMB, true);
        if (++n % 1000 === 0) log(`[photos] ${n} thumbnails made ahead`);
      }
      if (n) log(`[photos] ${n} thumbnails made ahead, all there now`);
    } finally {
      warming = false;
    }
  }
  return {
    payload: () => index(),
    get: id => index().byId.get(id),
    list: () => index().list,
    thumb: id => jpeg(id, THUMB),
    warm,
    full: id => jpeg(id, 0),
    // a thumbnail of a file not in the index (an album's cover): the caller decides which files may be shown
    thumbOfFile: file => jpegOf(crypto.createHash('sha1').update(file).digest('hex').slice(0, 12), file, THUMB),
    // and the whole of it (a photo with no place, to look at before placing it)
    fullOfFile: file => jpegOf(crypto.createHash('sha1').update(file).digest('hex').slice(0, 12), file, 0)
  };
}

module.exports = { create };
