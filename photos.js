'use strict';
// Every photo with its place, time and file (data/photo_points.json, written by imports/photos.py --points on the Mac
// that runs Cairn): for the photo layer, trips and the city pages. Each photo gets a short id from its file path; the
// browser gets [id, unix time, lat, lon], and asks for a thumbnail or the whole photo by id, made with macOS's sips
// (HEIC to JPEG) and kept in data/photo_cache. Only files in the index are ever served.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');

const VIDEO = /\.(mov|mp4|m4v|3gp|avi|mkv)$/i;
const TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.3gp': 'video/3gpp' };

function create({ file, cache, readImport }) {
  let loaded = { raw: null };
  function index() {
    const raw = readImport(file, []);
    if (loaded.raw !== raw) {
      const byId = new Map(), list = [];
      for (const [t, lat, lon, p] of raw) {
        const id = crypto.createHash('sha1').update(p || `${t},${lat},${lon}`).digest('hex').slice(0, 12);
        if (byId.has(id)) continue;
        byId.set(id, { t, lat, lon, path: p });
        list.push([id, t, lat, lon, p && VIDEO.test(p) ? 1 : 0]);
      }
      const json = Buffer.from(JSON.stringify(list));
      loaded = { raw, byId, list, json, gz: zlib.gzipSync(json), etag: `"${list.length}-${raw.length}"` };
    }
    return loaded;
  }
  // a JPEG of the photo, at most `size` pixels wide or high (0: as it is), made once
  function jpeg(id, size) {
    const p = index().byId.get(id);
    if (!p || !p.path || !fs.existsSync(p.path)) return Promise.resolve(null);
    if (VIDEO.test(p.path)) {  // a video: its first frame as the thumbnail (qlmanage), the file itself in full
      if (!size) return Promise.resolve({ file: p.path, type: TYPES[path.extname(p.path).toLowerCase()] || 'application/octet-stream' });
    }
    const out = path.join(cache, `${id}-${size || 'full'}.jpg`);
    if (fs.existsSync(out)) return Promise.resolve({ file: out, type: 'image/jpeg' });
    fs.mkdirSync(cache, { recursive: true });
    return new Promise(resolve => {
      if (VIDEO.test(p.path)) {  // Quick Look makes a picture of a video's first frame
        execFile('qlmanage', ['-t', '-s', String(size), '-o', cache, p.path], { timeout: 30000 }, err => {
          const made = path.join(cache, path.basename(p.path) + '.png');
          if (err || !fs.existsSync(made)) return resolve(null);
          fs.renameSync(made, out.replace(/\.jpg$/, '.png'));
          resolve({ file: out.replace(/\.jpg$/, '.png'), type: 'image/png' });
        });
        return;
      }
      const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', ...(size ? ['-Z', String(size)] : []), p.path, '--out', out];
      execFile('sips', args, { timeout: 60000 }, err => resolve(err || !fs.existsSync(out) ? null : { file: out, type: 'image/jpeg' }));
    });
  }
  return {
    payload: () => index(),
    get: id => index().byId.get(id),
    list: () => index().list,
    thumb: id => jpeg(id, 480),
    full: id => jpeg(id, 0)
  };
}

module.exports = { create };
