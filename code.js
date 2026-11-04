'use strict';
// Where you wrote code: your GitHub commits (imports/github.py, data/github.json) on the days and in the towns Cairn
// knows. A commit keeps its computer's clock offset, so its day is the day where you were; the town is the one you
// were in most that day (as for the books). Days with no place stay apart ("no place that day": at home, mostly).
// A commit whose clock is not the town's time zone was made by another computer (a server, a job running at home
// while you were away): counted, but in no place. Commits made between a flight's take-off and landing on a clock of
// either end were made in the air.

const { offsetAt } = require('./stats');

const DAY = 864e5;
const dayOf = c => new Date((c[0] + c[1] * 60) * 1000).toISOString().slice(0, 10);  // the day on the commit's clock

// read() -> { commits: [[unix, offset minutes, repo, subject]] }; dayTowns() -> Map day -> { id, name, cc, lat, lon };
// (tz: its time zone); trips() -> [{ id, name, start, end }]; flights() and airports() as Cairn has them;
// home() -> { lat, lon } or null
function create({ read, dayTowns, trips, flights, airports, home = () => null, km }) {
  let memo = { key: [], value: null };
  // each commit with its day, local hour and town: [{ t, day, hour, offset, repo, subject, town, elsewhere }]
  function placed() {
    const doc = read(), towns = dayTowns();
    if (memo.key[0] === doc && memo.key[1] === towns) return memo.value;
    const list = (doc.commits || []).map(c => {
      const day = dayOf(c), town = towns.get(day) || null, here = !town?.tz || offsetAt(town.tz, c[0]) === c[1];
      return { t: c[0], day, hour: new Date((c[0] + c[1] * 60) * 1000).getUTCHours(), offset: c[1], repo: c[2], subject: c[3] || '',
        town: here ? town : null, elsewhere: !here };
    });
    memo = { key: [doc, towns], value: list };
    return list;
  }
  const top = (list, k, n) => { const m = new Map(); list.forEach(x => m.set(x[k], (m.get(x[k]) || 0) + 1)); return [...m].sort((a, b) => b[1] - a[1]).slice(0, n); };
  const sum = list => list.length ? { commits: list.length, days: new Set(list.map(c => c.day)).size, first: list[0].day, last: list[list.length - 1].day, repos: top(list, 'repo', 5) } : null;

  // a period's commits (a trip): { commits, days, repos, byDay: { day: n } }
  function between(from, to) {
    const list = placed().filter(c => c.day >= from && c.day <= to), s = sum(list);
    if (!s) return null;
    const byDay = {};
    list.forEach(c => { byDay[c.day] = (byDay[c.day] || 0) + 1; });
    return { ...s, byDay };
  }
  const inTown = id => sum(placed().filter(c => c.town?.id === id));
  const inCountry = cc => { const list = placed().filter(c => c.town?.cc === cc), s = sum(list); return s && { ...s, towns: top(list.map(c => ({ ...c, name: c.town.name })), 'name', 5) }; };

  // the flights' hours in the air (take-off in its airport's time, plus the duration): [{ f, from, to }] in unix
  function airborne() {
    const ap = airports(), out = [];
    for (const f of flights()) {
      const a = ap[f.from], b = ap[f.to], m = /^(\d+):(\d\d)/.exec(f.duration || ''), d = /^(\d{4}-\d\d-\d\d) (\d\d):(\d\d)/.exec(f.date || '');
      if (!a?.tz || !b?.tz || !m || !d || d[2] + d[3] === '0000') continue;
      const local = Date.parse(`${d[1]}T${d[2]}:${d[3]}:00Z`) / 1000, t0 = local - offsetAt(a.tz, local) * 60;
      out.push({ f, t0, t1: t0 + (+m[1] * 60 + +m[2]) * 60, clocks: [offsetAt(a.tz, t0), offsetAt(b.tz, t0)] });
    }
    return out.sort((x, y) => x.t0 - y.t0);
  }

  function summary() {
    const list = placed();
    if (!list.length) return null;
    const known = list.filter(c => c.town), byCc = new Map(), byTown = new Map(), years = new Map();
    const away = new Set();
    trips().forEach(t => { for (let d = Date.parse(t.start); d <= Date.parse(t.end); d += DAY) away.add(new Date(d).toISOString().slice(0, 10)); });
    known.forEach(c => {
      if (!byCc.has(c.town.cc)) byCc.set(c.town.cc, []);
      byCc.get(c.town.cc).push(c);
      if (!byTown.has(c.town.id)) byTown.set(c.town.id, []);
      byTown.get(c.town.id).push(c);
    });
    list.forEach(c => { const y = c.day.slice(0, 4), v = years.get(y) || { year: +y, commits: 0, away: 0 }; v.commits++; if (away.has(c.day) && !c.elsewhere) v.away++; years.set(y, v); });
    const hours = Array(24).fill(0), weekdays = Array(7).fill(0);
    list.forEach(c => { hours[c.hour]++; weekdays[(new Date(c.day).getUTCDay() + 6) % 7]++; });
    // the trips you coded most on
    const onTrips = trips().map(t => ({ id: t.id, name: t.name, start: t.start, end: t.end, commits: list.filter(c => c.day >= t.start && c.day <= t.end).length }))
      .filter(t => t.commits).sort((a, b) => b.commits - a.commits).slice(0, 10);
    // in the air: commits between take-off and landing
    const air = [], hops = airborne();
    for (const h of hops) {
      const up = list.filter(c => c.t >= h.t0 && c.t <= h.t1 && h.clocks.includes(c.offset));
      if (up.length) air.push({ flight: { id: h.f.id, date: h.f.date, from: h.f.from, to: h.f.to, flight_number: h.f.flight_number || '' }, commits: up.length, repos: [...new Set(up.map(c => c.repo))] });
    }
    // the farthest from home a commit was made
    const h = home();
    let farthest = null;
    if (h && km) known.forEach(c => { const d = km([h.lat, h.lon], [c.town.lat, c.town.lon]); if (!farthest || d > farthest.km) farthest = { km: Math.round(d), day: c.day, repo: c.repo, town: { id: c.town.id, name: c.town.name, cc: c.town.cc } }; });
    const group = (m, f) => [...m].map(([k, cs]) => ({ ...f(k, cs[0]), commits: cs.length, days: new Set(cs.map(c => c.day)).size, repos: top(cs, 'repo', 3) })).sort((a, b) => b.commits - a.commits);
    return {
      commits: list.length, repos: new Set(list.map(c => c.repo)).size, first: list[0].day, last: list[list.length - 1].day,
      placed: known.length, elsewhere: list.filter(c => c.elsewhere).length, awayCommits: list.filter(c => away.has(c.day) && !c.elsewhere).length,
      countries: group(byCc, cc => ({ cc })), towns: group(byTown, (_, c) => ({ id: c.town.id, name: c.town.name, cc: c.town.cc })).slice(0, 25),
      years: [...years.values()].sort((a, b) => a.year - b.year), hours, weekdays, trips: onTrips, air, farthest,
      zones: new Set(list.map(c => c.offset)).size
    };
  }
  return { placed, summary, between, inTown, inCountry };
}

module.exports = { create, dayOf };
