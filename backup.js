'use strict';
// A backup of everything you imported or added: flights, trains, buses and ferries, stays (and those you deleted),
// activities and their timed tracks, Strava, sleep and heart rate, photo places and the photo index, Timeline, ride
// weather, music, the climbs' ways up, trips' road routes and the suggestions you answered. Not the photos themselves,
// nor what Cairn downloads or works out again by itself (airports, towns, the coast, heights, thumbnails), nor keys
// and sign-ins (config, secret, the Strava token). One .tar.gz (the system's tar), with a manifest.json saying what
// it is; restoring one first keeps a backup of the data as it was in data/backups/.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const TRACK = /^tracks\/\d+\.json\.gz$/;
const ACTIVITIES = new Set(['garmin.json', 'strava.json']);  // with the tracks: left out of a backup without sports activities

// files: () => [{ name, file }] (the data files a backup holds, by the name they have in it); tracks: the folder of
// timed tracks
function create({ files, tracks, backupsDir, log = console.log }) {
  const present = () => files().filter(f => fs.existsSync(f.file));
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  // a folder of links to the files, with the manifest, for tar to pack (-h: the files the links point to); without
  // `activities`, no sports activities nor their tracks
  function stage({ activities = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-backup-'));
    const list = present().filter(f => activities || !ACTIVITIES.has(f.name));
    list.forEach(f => fs.symlinkSync(f.file, path.join(dir, f.name)));
    const trackCount = activities && fs.existsSync(tracks) ? fs.readdirSync(tracks).filter(n => /\.json\.gz$/.test(n)).length : 0;
    if (trackCount) fs.symlinkSync(tracks, path.join(dir, 'tracks'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ app: 'cairn', version: 1, created: new Date().toISOString(),
      activities, files: list.map(f => ({ name: f.name, bytes: fs.statSync(f.file).size })), tracks: trackCount }, null, 2));
    return { dir, names: ['manifest.json', ...list.map(f => f.name), ...(trackCount ? ['tracks'] : [])] };
  }

  // the backup as a stream of a .tar.gz, to send; done() when it has all gone
  function stream(out, done = () => {}, opts = {}) {
    const { dir, names } = stage(opts);
    const tar = spawn('tar', ['-czhf', '-', '-C', dir, ...names]);
    tar.stdout.pipe(out);
    tar.stderr.on('data', d => log(`[backup] ${String(d).trim()}`));
    tar.on('close', code => { fs.rmSync(dir, { recursive: true, force: true }); done(code); });
  }

  // the backup into a file
  function toFile(file) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const out = fs.createWriteStream(file);
      stream(out, code => (code === 0 ? out.on('close', () => resolve(file)) : reject(new Error(`tar exited with ${code}`))));
    });
  }

  const run = (cmd, args) => new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout))));

  // A backup back in place: checked first (a Cairn backup, only the files a backup holds, no paths out of it), the
  // data as it is now kept in data/backups/, then each file of the backup copied over its own (files the backup does
  // not have stay as they are). Returns what was restored.
  async function restore(buffer) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-restore-'));
    try {
      const file = path.join(tmp, 'backup.tar.gz');
      fs.writeFileSync(file, buffer);
      const entries = (await run('tar', ['-tzf', file]).catch(() => { throw new Error('not a .tar.gz file'); }))
        .split('\n').map(s => s.replace(/^\.\//, '')).filter(Boolean);
      const known = new Set(files().map(f => f.name));
      const bad = entries.filter(e => !(e === 'manifest.json' || known.has(e) || e === 'tracks/' || e === 'tracks' || TRACK.test(e)));
      if (bad.length) throw new Error(`not a Cairn backup: it holds ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ', …' : ''}`);
      if (!entries.includes('manifest.json')) throw new Error('not a Cairn backup: no manifest.json');
      const out = path.join(tmp, 'x');
      fs.mkdirSync(out);
      await run('tar', ['-xzf', file, '-C', out]);
      const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
      if (manifest.app !== 'cairn') throw new Error('not a Cairn backup: its manifest is of something else');
      for (const f of files()) {  // each JSON file must read as JSON before anything is replaced
        const p = path.join(out, f.name);
        if (fs.existsSync(p) && /\.json$/.test(f.name)) JSON.parse(fs.readFileSync(p, 'utf8'));
      }
      const before = await toFile(path.join(backupsDir, `before-restore-${stamp()}.tar.gz`));
      const restored = [];
      for (const f of files()) {
        const p = path.join(out, f.name);
        if (!fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink()) continue;
        fs.mkdirSync(path.dirname(f.file), { recursive: true });
        fs.copyFileSync(p, f.file);
        restored.push(f.name);
      }
      let trackCount = 0;
      const tdir = path.join(out, 'tracks');
      if (fs.existsSync(tdir) && fs.lstatSync(tdir).isDirectory()) {
        fs.mkdirSync(tracks, { recursive: true });
        for (const n of fs.readdirSync(tdir)) {
          if (!TRACK.test('tracks/' + n) || fs.lstatSync(path.join(tdir, n)).isSymbolicLink()) continue;
          fs.copyFileSync(path.join(tdir, n), path.join(tracks, n));
          trackCount++;
        }
      }
      log(`[backup] restored ${restored.length} files and ${trackCount} tracks from a backup of ${manifest.created}; the data before is in ${before}`);
      return { created: manifest.created, files: restored, tracks: trackCount, before: path.basename(before) };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const summary = () => ({ files: present().map(f => ({ name: f.name, bytes: fs.statSync(f.file).size })),
    tracks: fs.existsSync(tracks) ? fs.readdirSync(tracks).filter(n => /\.json\.gz$/.test(n)).length : 0 });

  return { stream, toFile, restore, summary, stamp };
}

module.exports = { create };
