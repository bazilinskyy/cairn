'use strict';
// Stays your sports show: a run, walk or ride that starts and ends at one spot (a loop) mostly starts from where you
// slept. Nights away from home that no stay in Cairn covers, with such loops, are suggested as stays to add (the
// health list): one per run of nights at the same spot, a few nights apart at most. A loop in the morning counts for
// the night before it, a later one for the night after. Not suggested: spots near your home places (data/home.json),
// spots you ran from for months (where you lived), and a lone loop not far from those (a day out). Two spots for
// the same night: the one with more loops, a run's first (a hike or a ride often starts at a trailhead).

const LOOP_KM = 0.5;      // a loop ends this close to where it started
const SPOT_KM = 0.5;      // loops this close start from the same bed
const HOME_KM = 25;       // from your home places: home, not a stay
const LIVED_LOOPS = 60;   // this many loops from one spot (within LIVED_KM): where you lived
const LIVED_KM = 2;
const GAP_NIGHTS = 3;     // loops at most this many nights apart make one stay
const SINGLE_KM = 100;    // a lone loop at least this far from home and where you lived (else a day out)
const MORNING = 14;       // a loop starting before this hour counts for the night before

const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const cell = at => `${Math.round(at[0] * 20)},${Math.round(at[1] * 20)}`;  // about 5 km

// activities: () => [{ date: local "YYYY-MM-DD HH:MM:SS", path (encoded), sport, trainer, name }]; stays: () => the stays;
// homes: () => [[lat, lon]]; km, decode: ground.js; townAt: ([lat, lon]) => { name, cc } or null
function create({ activities, stays, homes, km, decode, townAt = () => null }) {
  let memo = { key: null, list: [] };

  function list() {
    const acts = activities(), st = stays(), hs = homes();
    const key = [acts.length, st.length, hs.map(h => h.join(',')).join(';')].join('|');
    if (memo.key === key) return memo.list;
    const loops = [];
    for (const a of acts) {
      if (a.trainer || !a.path || !/^\d{4}-\d\d-\d\d \d\d/.test(a.date || '')) continue;
      const p = decode(a.path);
      if (p.length < 2 || km(p[0], p[p.length - 1]) > LOOP_KM) continue;
      const day = a.date.slice(0, 10);
      loops.push({ at: p[0], night: +a.date.slice(11, 13) < MORNING ? addDays(day, -1) : day, name: a.name || '', run: /run/i.test(a.sport || '') });
    }
    // where you lived: a spot with many loops over the years
    const byCell = new Map();
    loops.forEach(l => { const c = cell(l.at); if (!byCell.has(c)) byCell.set(c, []); byCell.get(c).push(l); });
    const near = at => { const [i, j] = cell(at).split(',').map(Number), out = []; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) out.push(...(byCell.get(`${i + a},${j + b}`) || [])); return out; };
    const lived = [];
    for (const l of loops) {
      if (lived.some(x => km(x, l.at) < LIVED_KM * 2)) continue;
      if (near(l.at).filter(x => km(x.at, l.at) < LIVED_KM).length >= LIVED_LOOPS) lived.push(l.at);
    }
    const homeKm = at => Math.min(Infinity, ...hs.map(h => km(h, at)), ...lived.map(h => km(h, at)));
    // the nights a stay covers (rental cars are not beds)
    const covered = new Set();
    for (const s of st) {
      if (s.what === 'car' || !s.start) continue;
      for (let d = s.start; d < (s.end || addDays(s.start, 1)); d = addDays(d, 1)) covered.add(d);
    }
    const groups = [];
    for (const l of loops.filter(l => !covered.has(l.night) && homeKm(l.at) > HOME_KM).sort((a, b) => a.night.localeCompare(b.night))) {
      const g = groups.findLast(x => km(x.at, l.at) < SPOT_KM && (Date.parse(l.night) - Date.parse(x.last)) / 864e5 <= GAP_NIGHTS + 1);
      // the nights between belong to it too, unless a stay covers one of them (you slept elsewhere)
      let between = false;
      if (g) for (let d = addDays(g.last, 1); d < l.night; d = addDays(d, 1)) if (covered.has(d)) between = true;
      if (g && !between) { if (l.night > g.last) g.last = l.night; g.loops.push(l); } else groups.push({ at: l.at, first: l.night, last: l.night, loops: [l] });
    }
    const score = g => g.loops.length + (g.loops.some(l => l.run) ? 0.5 : 0), kept = [];
    for (const g of groups.filter(g => g.loops.length > 1 || homeKm(g.at) >= SINGLE_KM).sort((a, b) => score(b) - score(a))) {
      if (!kept.some(k => k.first <= g.last && g.first <= k.last)) kept.push(g);
    }
    kept.sort((a, b) => a.first.localeCompare(b.first));
    memo = {
      key, list: kept.map(g => {
        const town = townAt(g.at), nights = Math.round((Date.parse(g.last) - Date.parse(g.first)) / 864e5) + 1;
        return { key: `health|base|${g.first}|${g.at.map(x => x.toFixed(3)).join(',')}`, start: g.first, end: addDays(g.last, 1), nights,
          lat: g.at[0], lon: g.at[1], place: town?.name || '', cc: town?.cc || '', loops: g.loops.length, names: [...new Set(g.loops.map(l => l.name))].slice(0, 2) };
      }).reverse()
    };
    return memo.list;
  }
  return { list };
}

module.exports = { create };
