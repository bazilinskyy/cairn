'use strict';
// Trips your to-dos say you made that nothing else in Cairn knows: a "trip to X" to-do marked done in Things, where
// none of your flights, trains, stays, activities, photos or Timeline put you within NEAR_KM of X (or in X, for a
// country) from SEARCH_DAYS before it was done to SEARCH_DAYS after (planned months ahead, or ticked off after). They
// are suggested to check, as albums are: say where you came from and the year, or that it was no trip.

const NEAR_KM = 300, SEARCH_DAYS = 200;
const norm = s => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// things: things.js; locate(name, year): albums.js; days(from, to): every place and day; townAt(at): its town
function create({ things, locate, days, townAt, km, dismissed, log = console.log }) {
  let memo = { at: 0, list: null }, working = false;
  const countries = (() => {
    const out = new Map();
    try {
      const dn = new Intl.DisplayNames(['en'], { type: 'region' });
      for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
        const cc = String.fromCharCode(a, b), name = dn.of(cc);
        if (name && name !== cc) out.set(norm(name), cc);
      }
    } catch (_) { /* no names */ }
    out.set('macedonia', 'MK'); out.set('usa', 'US'); out.set('uk', 'GB'); out.set('england', 'GB'); out.set('scotland', 'GB'); out.set('holland', 'NL');
    return out;
  })();

  async function compute() {
    const out = [];
    for (const t of await things.doneTrips()) {
      const from = new Date(Date.parse(t.done) - SEARCH_DAYS * 864e5).toISOString().slice(0, 10);
      const to = new Date(Date.parse(t.done) + SEARCH_DAYS * 864e5).toISOString().slice(0, 10);
      const pts = days(from, to).filter(p => p.at);
      const cc = countries.get(norm(t.place));
      const at = cc ? null : await locate(t.place, +t.done.slice(0, 4)).catch(() => null);
      const seen = cc ? pts.some(p => townAt(p.at)?.cc === cc) : at && pts.some(p => km(p.at, at.at) <= NEAR_KM);
      if (seen) continue;
      out.push({ key: 'todo|' + t.uuid, title: t.title, place: at ? at.name : t.place, done: t.done, year: +t.done.slice(0, 4),
        lat: at ? at.at[0] : null, lon: at ? at.at[1] : null, country: cc || '' });
    }
    return out;
  }


  // the suggestions, worked out in the background at most once an hour; null until the first time
  function list() {
    if (!working && Date.now() - memo.at > 3600e3 && things.available()) {
      working = true;
      compute().then(l => { memo = { at: Date.now(), list: l }; }).catch(e => log(`[todotrips] ${e.message}`)).finally(() => { working = false; });
    }
    if (!memo.list) return null;
    const no = dismissed();
    return memo.list.filter(s => !no.has(s.key));
  }
  return { list };
}

module.exports = { create };
