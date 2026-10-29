'use strict';
const { stayKind, groundKind, commuteSince } = require('./stats');
// A year in review: the year's trips, the countries and towns you went to for the first time, how far you went by
// each means, the nights per kind of bed, the climbs you rode for the first time, the music you played most, your
// photos, sleep and resting heart rate, the weather's extremes on your rides and what your stays cost. Everything from
// what Cairn already has; worked out when asked, kept until the data changes.

// sources: getters; days(from, to): every place and day; townOf(point): its town (cities.js)
function create({ days, townOf, trips, flights, groundTrips, stays, activities, climbs, photos, music, wellness, weather, spending, places = () => ({}), commutes = () => true, drives = () => [] }) {
  const cache = new Map();

  function review(year) {
    const y = String(year), from = `${y}-01-01`, to = `${y}-12-31`, inYear = d => (d || '').slice(0, 4) === y;
    const key = [y, days('', '').length, activities().length, stays().length, flights().length, groundTrips().length, drives().length, commutes()].join('|');
    if (cache.has(y) && cache.get(y).key === key) return cache.get(y).value;

    // the towns and countries of every day, this year and before it (for the firsts)
    const all = days('', to).filter(p => p.at && p.day);
    const seenTowns = new Map(), seenCountries = new Map();
    for (const p of all) {
      const t = townOf(p);
      if (!t) continue;
      if (!seenTowns.has(t.id) || seenTowns.get(t.id).first > p.day) seenTowns.set(t.id, { town: t, first: p.day });
      if (!seenCountries.has(t.cc) || seenCountries.get(t.cc) > p.day) seenCountries.set(t.cc, p.day);
    }
    const yearPts = all.filter(p => inYear(p.day)), dayCount = new Map(), countryDays = new Map();
    for (const p of yearPts) {
      const t = townOf(p);
      if (!t) continue;
      if (!dayCount.has(t.id)) dayCount.set(t.id, { town: t, days: new Set() });
      dayCount.get(t.id).days.add(p.day);
      if (!countryDays.has(t.cc)) countryDays.set(t.cc, new Set());
      countryDays.get(t.cc).add(p.day);
    }
    const tripsY = trips().filter(t => inYear(t.start)).sort((a, b) => a.start.localeCompare(b.start));
    const fl = flights().filter(f => inYear(f.date)), gt = groundTrips().filter(t => inYear(t.date) && !t.approx), acts = activities().filter(a => inYear(a.date));
    const kind = s => (/Ride|Velomobile|Handcycle/.test(s || '') ? 'ride' : /Run/.test(s || '') ? 'run' : /Walk|Hike/.test(s || '') ? 'walk' : 'sport');
    const by = { flight: fl.reduce((n, f) => n + (f.distance || 0), 0) };
    const mine = places(), since = commuteSince(groundTrips(), mine);
    gt.forEach(t => { const k = groundKind(t, mine, since); if (k !== 'commute' || commutes()) by[k] = (by[k] || 0) + (t.distance || 0) * (t.times || 1); });
    drives().filter(d => inYear(d.date)).forEach(d => { by.drive = (by.drive || 0) + d.distance; });
    acts.filter(a => !a.trainer).forEach(a => { const k = kind(a.sport); by[k] = (by[k] || 0) + (a.distance || 0); });
    Object.keys(by).forEach(k => { by[k] = Math.round(by[k]); });

    const beds = {};
    stays().filter(s => s.what !== 'car' && inYear(s.start)).forEach(s => {
      const n = Math.max(1, Math.round((Date.parse(s.end || s.start) - Date.parse(s.start)) / 864e5));
      const what = stayKind(s);
      beds[what] = (beds[what] || 0) + n;
    });

    // climbs: those you rode this year, and which of them for the first time
    const climbed = climbs().filter(c => (c.rides || []).some(r => inYear(r.date)))
      .map(c => ({ id: c.id, name: c.name, country: c.country, ele: c.ele, first: c.first, firstTime: inYear(c.first) }))
      .sort((a, b) => b.firstTime - a.firstTime || (b.ele || 0) - (a.ele || 0));

    const well = Object.entries(wellness() || {}).filter(([d]) => inYear(d)).map(([, x]) => x);
    const avg = k => { const v = well.map(x => x[k]).filter(Boolean); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const wx = weather() || {}, rides = acts.filter(a => wx[a.id]);
    const pick = f => { const a = rides.reduce((b, x) => (!b || f(wx[x.id]) > f(wx[b.id]) ? x : b), null); return a && { id: a.id, name: a.name, date: a.date.slice(0, 10), ...wx[a.id] }; };
    const ph = (photos() || []).filter(p => inYear(new Date(p[1] * 1000).toISOString()));
    const photoDays = new Map();
    ph.forEach(p => { const d = new Date(p[1] * 1000).toISOString().slice(0, 10); photoDays.set(d, (photoDays.get(d) || 0) + 1); });
    const topPhotoDay = [...photoDays].sort((a, b) => b[1] - a[1])[0];
    const spend = spending ? spending().byYear.find(r => r.id === y) : null;

    const value = {
      year: +y,
      days: new Set(yearPts.map(p => p.day)).size,
      away: tripsY.reduce((n, t) => n + t.days, 0),
      trips: tripsY.map(t => ({ id: t.id, name: t.name, start: t.start, end: t.end, days: t.days, countries: t.countries.map(c => c.cc), towns: t.towns.slice(0, 3).map(x => x.name) })),
      countries: [...countryDays].map(([cc, ds]) => ({ cc, days: ds.size, first: seenCountries.get(cc) >= from })).sort((a, b) => b.days - a.days),
      towns: [...dayCount.values()].map(({ town, days: ds }) => ({ id: town.id, name: town.name, cc: town.cc, days: ds.size, first: seenTowns.get(town.id).first >= from }))
        .sort((a, b) => b.days - a.days),
      distance: by, flights: fl.length, ground: gt.length, activities: acts.length, beds,
      climbs: climbed, music: music ? music({ from, to }) : null,
      photos: { count: ph.length, topDay: topPhotoDay ? { day: topPhotoDay[0], count: topPhotoDay[1] } : null },
      body: well.length ? { sleep: avg('sleep'), score: avg('score'), rhr: avg('rhr'), steps: avg('steps') } : null,
      rides: rides.length ? { hottest: pick(w => w.tmax), coldest: pick(w => -w.tmin), wettest: pick(w => w.rain) } : null,
      spending: spend || null
    };
    cache.set(y, { key, value });
    return value;
  }

  // Every year side by side, in one pass over everything (the review of each year apart would go over all of it again
  // per year): days with a place, days away and trips, countries and towns (and how many for the first time), the
  // distance by each means, nights by kind of bed, photos, climbs ridden for the first time, and what stays cost
  let allYears = { key: '', value: null };
  function byYear() {
    const key = [days('', '').length, activities().length, stays().length, flights().length, groundTrips().length, drives().length, commutes()].join('|');
    if (allYears.key === key) return allYears.value;
    const rows = new Map(), row = y => {
      if (!rows.has(y)) rows.set(y, { year: +y, days: new Set(), away: 0, trips: 0, countries: new Set(), newCountries: 0, towns: new Set(), newTowns: 0,
        distance: {}, nights: {}, photos: 0, climbs: 0, eur: null });
      return rows.get(y);
    };
    const seenTowns = new Set(), seenCountries = new Set(), memo = new Map();
    const town = p => {  // one lookup per place (to about 1 km) and name
      const k = `${p.at[0].toFixed(2)},${p.at[1].toFixed(2)}|${p.city || ''}`;
      if (!memo.has(k)) memo.set(k, townOf(p));
      return memo.get(k);
    };
    for (const p of days('', '').filter(p => p.at && p.day).sort((a, b) => a.day.localeCompare(b.day))) {
      const t = town(p), r = row(p.day.slice(0, 4));
      r.days.add(p.day);
      if (!t) continue;
      r.towns.add(t.id); r.countries.add(t.cc);
      if (!seenTowns.has(t.id)) { seenTowns.add(t.id); r.newTowns++; }
      if (!seenCountries.has(t.cc)) { seenCountries.add(t.cc); r.newCountries++; }
    }
    trips().forEach(t => { const r = row(t.start.slice(0, 4)); r.trips++; r.away += t.days; });
    const add = (y, k, km) => { if (y && km) { const r = row(y); r.distance[k] = (r.distance[k] || 0) + km; } };
    flights().forEach(f => add((f.date || '').slice(0, 4), 'flight', f.distance || 0));
    const mine = places(), since = commuteSince(groundTrips(), mine);
    groundTrips().forEach(t => { const k = groundKind(t, mine, since); if (k !== 'commute' || commutes()) add((t.date || '').slice(0, 4), k, (t.distance || 0) * (t.times || 1)); });
    drives().forEach(d => add(d.date.slice(0, 4), 'drive', d.distance));
    const kind = s => (/Ride|Velomobile|Handcycle/.test(s || '') ? 'ride' : /Run/.test(s || '') ? 'run' : /Walk|Hike/.test(s || '') ? 'walk' : 'sport');
    activities().filter(a => !a.trainer).forEach(a => add((a.date || '').slice(0, 4), kind(a.sport), a.distance || 0));
    stays().filter(s => s.what !== 'car' && s.start).forEach(s => {
      const n = Math.max(1, Math.round((Date.parse(s.end || s.start) - Date.parse(s.start)) / 864e5)), r = row(s.start.slice(0, 4));
      const what = stayKind(s);
      r.nights[what] = (r.nights[what] || 0) + n;
    });
    (photos() || []).forEach(p => { const y = new Date(p[1] * 1000).toISOString().slice(0, 4); row(y).photos++; });
    climbs().forEach(c => { if (c.first) row(c.first.slice(0, 4)).climbs++; });
    (spending ? spending().byYear : []).forEach(x => { row(x.id).eur = x.eur; });
    const value = [...rows.values()].filter(r => r.days.size || r.trips || Object.keys(r.distance).length).sort((a, b) => a.year - b.year)
      .map(r => ({ ...r, days: r.days.size, countries: r.countries.size, towns: r.towns.size,
        distance: Object.fromEntries(Object.entries(r.distance).map(([k, v]) => [k, Math.round(v)])) }));
    allYears = { key, value };
    return value;
  }

  // the years with anything in them
  const years = () => [...new Set(days('', '').map(p => (p.day || '').slice(0, 4)).filter(Boolean))].sort();
  return { review, years, byYear };
}

module.exports = { create };
