'use strict';
// Imports from Settings: the files of a data download (a Garmin export, a Takeout zip, bank statements, ...) uploaded
// one by one into data/uploads/<batch>/, then read by that source's import (an imports/*.py script, or Cairn itself)
// in the background; the uploaded copies are removed after. How each source's last import went is kept in
// data/uploads.json, for the Settings page.

const fs = require('fs');
const path = require('path');

const BATCH = /^[a-z0-9]{8,32}$/;

// sources: { key: { label, what, accept, note, file (what it writes, for when it was last changed, also by the script
// run by hand), run: async files => message } }
function create({ dir, statusFile, sources, log = console.log }) {
  const running = new Map();  // key -> since (ms)
  const readStatus = () => { try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch (_) { return {}; } };
  const saveStatus = (key, s) => fs.writeFileSync(statusFile, JSON.stringify({ ...readStatus(), [key]: s }));
  const folder = batch => path.join(dir, batch);

  // one uploaded file, streamed to disk (a Garmin export is gigabytes)
  function receive(key, batch, name, req) {
    if (!sources[key]) return Promise.reject(Object.assign(new Error(`no import called ${key}`), { status: 404 }));
    const file = path.basename(String(name || ''));
    if (!BATCH.test(batch || '') || !file || file.startsWith('.')) return Promise.reject(Object.assign(new Error('a batch and a file name are needed'), { status: 400 }));
    fs.mkdirSync(folder(batch), { recursive: true });
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(path.join(folder(batch), file));
      req.pipe(out);
      out.on('finish', () => resolve({ name: file, bytes: out.bytesWritten }));
      out.on('error', reject);
      req.on('error', reject);
    });
  }

  // the batch's files read by the source's import, in the background
  function start(key, batch) {
    const src = sources[key];
    if (!src) return { error: `no import called ${key}`, status: 404 };
    if (!BATCH.test(batch || '') || !fs.existsSync(folder(batch))) return { error: 'nothing uploaded', status: 400 };
    if (running.has(key)) return { error: 'already importing', status: 409 };
    const files = fs.readdirSync(folder(batch)).map(f => path.join(folder(batch), f));
    running.set(key, Date.now());
    const names = files.map(f => path.basename(f));
    (async () => {
      try {
        const message = await src.run(files);
        saveStatus(key, { at: new Date().toISOString(), ok: true, files: names, message: message || '' });
        log(`[imports] ${key}: ${message}`);
      } catch (e) {
        saveStatus(key, { at: new Date().toISOString(), ok: false, files: names, message: e.message });
        log(`[imports] ${key} failed: ${e.message}`);
      } finally {
        running.delete(key);
        fs.rmSync(folder(batch), { recursive: true, force: true });
      }
    })();
    return { started: true };
  }

  const list = () => {
    const status = readStatus();
    const changed = f => { try { return fs.statSync(f).mtime.toISOString(); } catch (_) { return ''; } };
    return Object.entries(sources).map(([key, s]) => ({ key, label: s.label, what: s.what, accept: s.accept || '', note: s.note || '',
      running: running.has(key), last: status[key] || null, changed: s.file ? changed(s.file) : '' }));
  };
  return { receive, start, list };
}

// Runs a Python import with uv (the packages in `withs` fetched for it, nothing installed); resolves with its last
// line of output, rejects with its last line of errors
function script(uv, file, args, withs = []) {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(uv, ['run', '-q', ...withs.flatMap(w => ['--with', w]), 'python', file, ...args]);
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => reject(e));
    child.on('close', code => {
      const last = s => s.trim().split('\n').filter(Boolean).pop() || '';
      code === 0 ? resolve(last(out) || last(err)) : reject(new Error(last(err) || last(out) || `ended with code ${code}`));
    });
  });
}

module.exports = { create, script };
