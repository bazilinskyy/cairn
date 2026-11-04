'use strict';
// On this day: where you were on today's date in the years before, and what you did: the trip it was part of, the
// towns, flights, trains, buses and ferries, where you slept, sports, photos, the song you played most, the book you
// finished and the tickets in your Wallet (a concert, a film). For the Trips tab, and (when turned on in the settings)
// every morning at 08:00 to the alerts channel.

const fs = require('fs');

const SEND_AT = 8 * 60;  // minutes after midnight, local time
const dayOf = t => new Date(t * 1000).toISOString().slice(0, 10);

// sources: getters for the server's lists (as for trips.js); towns() the town grid, or null without the town list;
// days(from, to) every place of every day; music(range) the top songs; books(from, to) the books finished;
// tickets(from, to) the tickets to events
function create({ towns, cities, days, trips, flights, airports, groundTrips, stays, activities, photos, music = () => null, books = () => [], tickets = () => [],
  enabled = () => false, discord, sentFile, log = console.log }) {

  // the date (YYYY-MM-DD) in each year before, newest first: 29 February falls on the 28th in other years
  function datesFor(today) {
    const [y, m, d] = today.split('-').map(Number), out = [];
    const first = Math.min(...[...flights(), ...groundTrips()].map(x => +(x.date || '').slice(0, 4)).filter(Boolean), y - 1);
    for (let year = y - 1; year >= first; year--) {
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      out.push(`${year}-${String(m).padStart(2, '0')}-${String(m === 2 && d === 29 && !leap ? 28 : d).padStart(2, '0')}`);
    }
    return out;
  }

  let memo = { key: '', value: null };
  function get(today = new Date().toISOString().slice(0, 10)) {
    const grid = towns();
    const fl = flights(), gt = groundTrips(), st = stays(), acts = activities(), ph = photos(), tr = trips();
    const key = [today, fl.length, gt.length, st.length, acts.length, ph.length, tr.length].join('|');
    if (memo.key === key) return memo.value;
    const dates = datesFor(today), wanted = new Set(dates), ap = airports();
    const placesOn = new Map();
    if (grid && dates.length) days(dates[dates.length - 1], dates[0]).forEach(p => { if (wanted.has(p.day)) { if (!placesOn.has(p.day)) placesOn.set(p.day, []); placesOn.get(p.day).push(p); } });
    const pics = new Map();
    ph.forEach(p => { if (p[2] == null) return; const d = dayOf(p[1]); if (wanted.has(d)) { if (!pics.has(d)) pics.set(d, []); pics.get(d).push(p); } });
    const out = [];
    for (const d of dates) {
      const trip = tr.find(t => t.start <= d && t.end >= d);
      const townList = grid && placesOn.has(d) ? cities.rank(grid, placesOn.get(d)).slice(0, 3).map(t => ({ id: t.id, name: t.name, country: t.country })) : [];
      const flown = fl.filter(f => (f.date || '').slice(0, 10) === d).map(f => ({ id: f.id, from: f.from, to: f.to, from_city: ap[f.from]?.city || f.from, to_city: ap[f.to]?.city || f.to, flight_number: f.flight_number || '' }));
      const rode = gt.filter(t => (t.date || '').slice(0, 10) === d && t.approx !== 'year' && t.approx !== 'month').map(t => ({ id: t.id, mode: t.mode, from: t.from, to: t.to }));
      const stay = st.find(s => s.what !== 'car' && s.start <= d && (s.end || s.start) > d);
      const sport = acts.filter(a => (a.date || '').slice(0, 10) === d).map(a => ({ id: a.id, name: a.name, sport: a.sport, distance: a.distance }));
      const shots = (pics.get(d) || []).sort((a, b) => a[1] - b[1]);
      const song = music({ from: d, to: d })?.tracks?.[0] || null;
      const read = books(d, d).map(b => ({ title: b.title, author: b.author || '' }));
      const went = tickets(d, d).map(e => ({ title: e.title, venue: e.venue }));
      if (!townList.length && !flown.length && !rode.length && !stay && !sport.length && !shots.length && !read.length && !went.length) continue;
      out.push({ day: d, years: +today.slice(0, 4) - +d.slice(0, 4), trip: trip ? { id: trip.id, name: trip.name, countries: trip.countries } : null,
        towns: townList, flights: flown, ground: rode, stay: stay ? { id: stay.id, place: stay.place || '', hotel: stay.hotel || '', type: stay.type || '' } : null,
        activities: sport, photos: shots.length, photo_ids: pickSpread(shots, 6).map(p => p[0]), song: song && { artist: song.artist, name: song.name }, books: read, tickets: went });
    }
    memo = { key, value: out };
    return out;
  }

  // n photos spread over the day (not the first n, often of one place)
  function pickSpread(list, n) {
    if (list.length <= n) return list;
    return Array.from({ length: n }, (_, i) => list[Math.floor(i * (list.length - 1) / (n - 1))]);
  }

  // the message for the alerts channel: a line per year
  function text(list) {
    const line = x => {
      const where = x.towns.map(t => t.name).join(', ') || x.stay?.place || '';
      const bits = [
        x.trip && `on ${x.trip.name}`,
        ...x.flights.map(f => `✈️ ${f.from_city} → ${f.to_city}`),
        ...x.ground.map(g => `${{ train: '🚆', bus: '🚌', ferry: '⛴️' }[g.mode] || '🚆'} ${g.from} → ${g.to}`),
        x.stay && `🛏️ ${x.stay.hotel || x.stay.place}`,
        ...x.activities.map(a => `🏃 ${a.name}${a.distance ? ` (${a.distance} km)` : ''}`),
        x.photos && `📷 ${x.photos}`,
        x.song && `🎧 ${x.song.artist} – ${x.song.name}`,
        ...x.books.map(b => `📚 finished ${b.title}`),
        ...(x.tickets || []).map(e => `🎟️ ${e.title}${e.venue ? ` at ${e.venue}` : ''}`)
      ].filter(Boolean);
      return `• ${x.day.slice(0, 4)} (${x.years} year${x.years !== 1 ? 's' : ''} ago)${where ? `: ${where}` : ''}${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
    };
    return `📅 On this day:\n${list.map(line).join('\n')}`;
  }

  // every morning after 08:00, when turned on: once a day, nothing on a day with nothing to tell
  let lastRun = '';
  async function morning(force = false) {
    const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (!force && (!enabled() || lastRun === today || now.getHours() * 60 + now.getMinutes() < SEND_AT)) return null;
    lastRun = today;
    let sent = {};
    try { sent = JSON.parse(fs.readFileSync(sentFile, 'utf8')); } catch (_) {}
    if (!force && sent.day === today) return null;
    const list = get(today);
    if (list.length) {
      try { await discord(text(list)); } catch (e) { log(`[onthisday] not sent: ${e.message}`); lastRun = ''; return null; }
    }
    fs.writeFileSync(sentFile, JSON.stringify({ day: today }));
    log(`[onthisday] ${list.length} year${list.length !== 1 ? 's' : ''} sent`);
    return list;
  }

  return { get, text, morning, datesFor };
}

module.exports = { create };
