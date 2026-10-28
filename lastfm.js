'use strict';
// What you listened to (Last.fm): every scrobble, fetched once and then the new ones every six hours, kept in
// data/lastfm.json; for a town's or a trip's page, the artists and tracks you played on its days. Needs a Last.fm API
// key and your user name in `secret` (lastfm_api_key, lastfm_user; read each time, so adding them needs no restart).

const fs = require('fs');

const API = 'https://ws.audioscrobbler.com/2.0/';
const PAGE = 200, TOP = 10;

function create({ file, keys, log = console.log }) {
  let data = null, running = false;
  const load = () => {
    if (!data) { try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { data = { scrobbles: [] }; } }
    return data;
  };
  const save = () => fs.writeFileSync(file, JSON.stringify(data));

  async function call(params) {
    const { key } = keys();
    const p = new URLSearchParams({ ...params, api_key: key, format: 'json' });
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 400 + attempt * 5000));
      const res = await fetch(`${API}?${p}`, { headers: { 'User-Agent': 'cairn (personal travel log; https://github.com/bazilinskyy/cairn)' },
        signal: AbortSignal.timeout(30000) });
      const d = await res.json().catch(() => ({}));
      if (res.ok && !d.error) return d;
      if (d.error === 29 || res.status >= 500) continue;  // rate limit or a hiccup: wait and try again
      throw new Error(`Last.fm: ${d.message || 'HTTP ' + res.status}`);
    }
    throw new Error('Last.fm: no answer');
  }

  // the scrobbles since the last one kept (all of them the first time), newest page first
  function sync() {
    const { key, user } = keys();
    if (running || !key || !user) return;
    running = true;
    (async () => {
      const d = load();
      if (d.user && d.user !== user) d.scrobbles = [];  // another account: start again
      d.user = user;
      const since = d.scrobbles.reduce((m, s) => Math.max(m, s[0]), 0);
      const got = [];
      try {
        for (let page = 1, pages = 1; page <= pages; page++) {
          const r = await call({ method: 'user.getrecenttracks', user, limit: PAGE, page, from: since + 1 });
          const t = r.recenttracks || {};
          pages = +(t['@attr']?.totalPages || 0);
          for (const s of [].concat(t.track || [])) {
            if (!s.date?.uts) continue;  // playing now
            got.push([+s.date.uts, s.artist?.['#text'] || s.artist?.name || '', s.name || '', s.album?.['#text'] || '']);
          }
          if (page % 50 === 0) log(`[lastfm] ${got.length} scrobbles so far (page ${page} of ${pages})`);
        }
        d.scrobbles = [...d.scrobbles, ...got].sort((a, b) => a[0] - b[0]);
        d.last_sync = new Date().toISOString();
        delete d.error;
        if (got.length) log(`[lastfm] ${got.length} new scrobbles, ${d.scrobbles.length} in all`);
      } catch (e) {
        d.error = e.message;
        log(`[lastfm] ${e.message}`);
        if (got.length) d.scrobbles = [...d.scrobbles, ...got].sort((a, b) => a[0] - b[0]);  // the pages read are kept (newest first: no gaps when the rest comes)
      }
      save();
      running = false;
    })();
  }

  // the scrobbles from one day to another (UTC days), only on the days in `days` when given: the top artists and
  // tracks, how many, and per day
  function top({ from = '', to = '', days = null } = {}) {
    const list = load().scrobbles;
    if (!list.length) return null;
    const lo = from ? Date.parse(from + 'T00:00:00Z') / 1000 : 0, hi = to ? Date.parse(to + 'T23:59:59Z') / 1000 : Infinity;
    const artists = new Map(), tracks = new Map(), perDay = {};
    let n = 0;
    for (const [t, artist, track] of list) {
      if (t < lo || t > hi) continue;
      const d = new Date(t * 1000).toISOString().slice(0, 10);
      if (days && !days.has(d)) continue;
      n++;
      artists.set(artist, (artists.get(artist) || 0) + 1);
      const k = artist + '\u0000' + track;
      tracks.set(k, (tracks.get(k) || 0) + 1);
      perDay[d] = perDay[d] || { n: 0, top: new Map() };
      perDay[d].n++;
      perDay[d].top.set(k, (perDay[d].top.get(k) || 0) + 1);
    }
    if (!n) return { plays: 0, artists: [], tracks: [], days: {} };
    const best = (m, k = TOP) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k);
    return {
      plays: n,
      artists: best(artists).map(([name, plays]) => ({ name, plays })),
      tracks: best(tracks).map(([k, plays]) => ({ artist: k.split('\u0000')[0], name: k.split('\u0000')[1], plays })),
      days: Object.fromEntries(Object.entries(perDay).map(([d, x]) => {
        const [k, plays] = best(x.top, 1)[0];
        return [d, { plays: x.n, top: { artist: k.split('\u0000')[0], name: k.split('\u0000')[1], plays } }];
      }))
    };
  }

  const status = () => { const d = load(), k = keys(); return { configured: !!(k.key && k.user), user: d.user || k.user || '', scrobbles: d.scrobbles.length, last_sync: d.last_sync || '', error: d.error || '' }; };
  return { sync, top, status };
}

module.exports = { create };
