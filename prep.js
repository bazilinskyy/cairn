'use strict';
// Getting ready for the coming trips: per trip its flights (with whether their check-in is in hand), stays, rental
// cars and trains, what is still missing (a check-in to-do for a flight, a bed for a night, the way there or back), the
// open to-dos that are about it (Things), the weather forecast once it is near (Open-Meteo, 16 days ahead) and the
// famous climbs near where you stay that you have not ridden. Every morning the missing things not reported before go
// to the alerts channel (flightmail's Discord webhook); each can be added to Things from the trip's page, or set aside.

const fs = require('fs');

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const CHECKIN_DAYS = 3;   // a check-in to-do dated up to this many days before a flight is for it
const CLIMB_KM = 40, SAVED_KM = 30;
const ALERT_AT = 7 * 60 + 30;  // every morning at 07:30
const norm = s => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const dayAdd = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

// sources: getters for Cairn's lists; things: things.js; trips(): trips.js's list; climbs(): climbs.js's list
function create({ trips, flights, airports, stays, groundTrips, climbs, saved = () => [], things, homeAirports, km, sentFile, dismissed, discord, log = console.log }) {
  const forecasts = new Map();  // "lat,lon" -> { at, days }

  // a flight's number in every spelling a to-do may use: "S4151", "S4 151", "151"
  const spellings = f => {
    const n = (f.flight_number || '').replace(/\s+/g, '').toUpperCase(), m = n.match(/^([A-Z0-9]{2})(\d+)$/);
    return m ? [n, `${m[1]} ${m[2]}`, m[2]] : n ? [n] : [];
  };

  async function forecast(at) {
    const key = at.map(x => x.toFixed(2)).join(',');
    const had = forecasts.get(key);
    if (had && Date.now() - had.at < 3 * 3600e3) return had.days;
    try {
      const p = new URLSearchParams({ latitude: at[0].toFixed(3), longitude: at[1].toFixed(3), timezone: 'auto', forecast_days: '16',
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,wind_speed_10m_max' });
      const d = await (await fetch(`${FORECAST}?${p}`, { signal: AbortSignal.timeout(20000) })).json();
      const days = Object.fromEntries((d.daily?.time || []).map((t, i) => [t, { tmax: d.daily.temperature_2m_max[i], tmin: d.daily.temperature_2m_min[i],
        rain: d.daily.precipitation_sum[i], code: d.daily.weather_code[i], wind: d.daily.wind_speed_10m_max[i] }]));
      forecasts.set(key, { at: Date.now(), days });
      return days;
    } catch (e) { log(`[prep] forecast: ${e.message}`); return had ? had.days : {}; }
  }

  // the coming trips (not ended yet), each with what it holds and what it lacks
  async function coming({ withForecast = true } = {}) {
    const today = new Date().toISOString().slice(0, 10), ap = airports(), home = new Set(homeAirports());
    const todos = await things.todos({ since: dayAdd(today, -120) }), no = dismissed();
    const allClimbs = climbs();
    const out = [];
    for (const t of trips().filter(x => x.end >= today).sort((a, b) => a.start.localeCompare(b.start))) {
      const inTrip = d => d && d.slice(0, 10) >= t.start && d.slice(0, 10) <= t.end;
      const fl = flights().filter(f => inTrip(f.date) && ap[f.from] && ap[f.to]).sort((a, b) => a.date.localeCompare(b.date));
      const st = stays().filter(s => s.start && s.start <= t.end && (s.end || s.start) >= t.start).sort((a, b) => a.start.localeCompare(b.start));
      const gt = groundTrips().filter(x => inTrip(x.date)).sort((a, b) => a.date.localeCompare(b.date));
      const beds = st.filter(s => s.what !== 'car'), cars = st.filter(s => s.what === 'car');
      const missing = [];
      // an open to-do already about it (its title or checklist): "Book a place to stay in Tenerife", "book flight to Malaga"
      const KIND_WORDS = { stay: /stay|accommodation|hotel|hostel|airbnb|room|flat|couchsurf|booking/i, transport: /flight|train|bus|ferry|book|ticket|get to|way/i };
      const covered = (kind, place) => place && KIND_WORDS[kind] && todos.some(td => td.status === 'open' &&
        [td.title, ...td.checklist].some(line => KIND_WORDS[kind].test(line) && norm(line).includes(norm(place))));
      const add = (kind, key, text, when, extra = {}) => {
        if (no.has(key)) return;
        const todo = covered(kind, extra.town);
        missing.push({ kind, key, text, when, ...extra, ...(todo ? { todo: true } : {}) });
      };

      // check-ins: a to-do (open, done or set aside) naming the flight, or dated just before it
      const rankOf = td => ({ open: 0, done: 1, canceled: 2 })[td.status] ?? 3;  // an open or done one before one set aside
      const checkin = f => [...todos].sort((a, b) => rankOf(a) - rankOf(b)).find(td => /check.?in/i.test(td.title) && (
        spellings(f).some(s => (td.title + ' ' + td.notes).toUpperCase().includes(s) && (s.length > 3 || new RegExp(`\\b${s}\\b`).test(td.title))) ||
        [td.start, td.deadline].some(d => d && d <= f.date.slice(0, 10) && d >= dayAdd(f.date.slice(0, 10), -CHECKIN_DAYS))));
      const flightsOut = fl.map(f => {
        const td = checkin(f);
        return { id: f.id, date: f.date, from: f.from, to: f.to, flight_number: f.flight_number, airline: f.airline,
          from_city: ap[f.from]?.city, to_city: ap[f.to]?.city, checkin: td ? { title: td.title, status: td.status } : null };
      });
      // one to-do per journey: flights of one day, or connecting within 24 hours, share it
      let prev = null;
      for (const f of flightsOut) {
        const connects = prev && prev.to === f.from && (Date.parse(f.date.replace(' ', 'T')) - Date.parse(prev.date.replace(' ', 'T'))) < 864e5;
        if (!f.checkin && f.date.slice(0, 10) >= today && !(connects && prev.checkin)) {
          add('checkin', `prep|checkin|${f.flight_number}|${f.date.slice(0, 10)}`, `Check in for ${f.flight_number || 'the flight'} ${f.from} → ${f.to}`,
            dayAdd(f.date.slice(0, 10), -1), { flight: f.flight_number });
        }
        if (connects && prev.checkin && !f.checkin) f.checkin = { title: prev.checkin.title, status: prev.checkin.status, with: prev.flight_number };
        prev = f;
      }

      // nights without a bed: from the first night to the last, not on a flight or a night train
      const overnight = new Set([...fl.filter(f => f.date.slice(11, 13) >= '18' || f.date.slice(11, 13) < '04').map(f => f.date.slice(0, 10)),
        ...gt.filter(x => x.arrival && x.arrival.slice(0, 10) > x.date.slice(0, 10)).map(x => x.date.slice(0, 10))]);
      const firstArrival = fl.find(f => !home.has(f.to)) || gt[0];
      const lastLeaving = [...fl].reverse().find(f => home.has(f.to));
      const from = firstArrival ? firstArrival.date.slice(0, 10) : t.start, until = lastLeaving ? lastLeaving.date.slice(0, 10) : t.end;
      const gaps = [];
      for (let d = from; d < until; d = dayAdd(d, 1)) {
        if (d < today) continue;
        if (beds.some(s => s.start <= d && (s.end || s.start) > d) || overnight.has(d)) continue;
        const g = gaps[gaps.length - 1];
        if (g && dayAdd(g.to, 1) === d) g.to = d; else gaps.push({ from: d, to: d });
      }
      for (const g of gaps) {
        const nights = (Date.parse(g.to) - Date.parse(g.from)) / 864e5 + 1;
        const where = (fl.filter(f => f.date.slice(0, 10) <= g.from && !home.has(f.to)).pop()?.to);
        const town = where ? ap[where]?.city : (t.towns[0]?.name || t.name);
        add('stay', `prep|stay|${t.id}|${g.from}`, `Book a place to stay in ${town}: ${nights} night${nights > 1 ? 's' : ''} from ${g.from}`, dayAdd(g.from, -30), { from: g.from, to: g.to, town });
      }

      // the way there and back: a trip that starts away from your home airports, or ends away from them
      if (fl.length && !home.has(fl[0].from) && !gt.some(x => x.date <= fl[0].date) && fl[0].date.slice(0, 10) >= today) {
        add('transport', `prep|there|${t.id}`, `How do you get to ${ap[fl[0].from]?.city || fl[0].from}? Nothing booked before flight ${fl[0].flight_number || ''} on ${fl[0].date.slice(0, 10)}`,
          dayAdd(fl[0].date.slice(0, 10), -45), { town: ap[fl[0].from]?.city });
      }
      const last = fl[fl.length - 1];
      if (last && !home.has(last.to) && !gt.some(x => x.date >= last.date) && last.date.slice(0, 10) >= today) {
        add('transport', `prep|back|${t.id}`, `How do you get home from ${ap[last.to]?.city || last.to}? Nothing booked after flight ${last.flight_number || ''}`, dayAdd(last.date.slice(0, 10), -30), { town: ap[last.to]?.city });
      }

      // the open to-dos about it: naming one of its towns, countries, stays' places or flights
      const words = [...t.towns.map(x => norm(x.name)), ...t.countries.map(c => norm(new Intl.DisplayNames(['en'], { type: 'region' }).of(c.cc))),
        ...beds.map(s => norm(s.place)), ...fl.map(f => norm(ap[f.to]?.city))].filter(w => w && w.length > 3);
      const about = todos.filter(td => td.status === 'open' && (
        words.some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(norm(td.title))) ||
        fl.some(f => spellings(f).some(s => s.length > 3 && td.title.toUpperCase().includes(s)))))
        .map(td => ({ title: td.title, project: td.project, start: td.start, deadline: td.deadline, checklist: td.checklist }));

      // the weather where you will be, once it is within 16 days; climbs near the stays not ridden yet
      const places = [...beds.filter(s => s.lat != null).map(s => ({ at: [s.lat, s.lon], name: s.place, from: s.start, to: s.end || s.start })),
        ...fl.filter(f => !home.has(f.to)).map(f => ({ at: [ap[f.to].lat, ap[f.to].lon], name: ap[f.to].city, from: f.date.slice(0, 10), to: f.date.slice(0, 10) }))];
      let weather = [];
      if (withForecast && t.start <= dayAdd(today, 16)) {
        for (const p of places.slice(0, 6)) {
          const days = await forecast(p.at);
          for (let d = p.from > today ? p.from : today; d <= p.to; d = dayAdd(d, 1)) if (days[d] && !weather.some(w => w.day === d)) weather.push({ day: d, place: p.name, ...days[d] });
        }
        weather.sort((a, b) => a.day.localeCompare(b.day));
      }
      const nearClimbs = allClimbs.filter(c => !c.times && places.some(p => km(p.at, [c.lat, c.lon]) <= CLIMB_KM))
        .map(c => {
          const near = places.reduce((a, p) => (km(p.at, [c.lat, c.lon]) < km(a.at, [c.lat, c.lon]) ? p : a));  // where to ride it from
          return { id: c.id, name: c.name, ele: c.ele, country: c.country, km: Math.round(km(near.at, [c.lat, c.lon])), from: { at: near.at, name: near.name } };
        })
        .sort((a, b) => a.km - b.km).slice(0, 12);

      // places you saved in Google Maps near where you will be
      const nearSaved = saved().filter(p => p.lat != null && places.some(q => km(q.at, [p.lat, p.lon]) <= SAVED_KM))
        .map(p => ({ name: p.name, list: p.list, note: p.note, url: p.url, km: Math.round(Math.min(...places.map(q => km(q.at, [p.lat, p.lon])))) }))
        .sort((a, b) => a.km - b.km).slice(0, 20);
      out.push({ id: t.id, name: t.name, start: t.start, end: t.end, days: t.days, countries: t.countries, towns: t.towns,
        flights: flightsOut, stays: beds, cars, ground: gt.map(x => ({ id: x.id, date: x.date, mode: x.mode, from: x.from, to: x.to })),
        missing, todos: about, weather, climbs: nearClimbs, saved: nearSaved });
    }
    return out;
  }

  // every morning: the missing things not reported before, to the alerts channel
  let lastRun = '';
  async function morning(force = false) {
    const now = new Date(), today = now.toISOString().slice(0, 10), minutes = now.getHours() * 60 + now.getMinutes();
    if (!force && (lastRun === today || minutes < ALERT_AT)) return null;
    lastRun = today;
    let sent = {};
    try { sent = JSON.parse(fs.readFileSync(sentFile, 'utf8')); } catch (_) {}
    if (!force && sent._day === today) return null;
    const list = await coming({ withForecast: false });
    // not yet reported, not already a to-do, and due within two months
    const fresh = list.flatMap(t => t.missing.filter(m => !sent[m.key] && !m.todo && m.when <= dayAdd(today, 60)).map(m => ({ ...m, trip: t })));
    if (fresh.length) {
      const text = `🧳 Coming trips, still missing:\n` + fresh.map(m => `• ${m.trip.name} (${m.trip.start}): ${m.text}`).join('\n') +
        `\nOpen the trip in Cairn to add these to Things or set them aside.`;
      try { await discord(text); fresh.forEach(m => { sent[m.key] = today; }); } catch (e) { log(`[prep] alert not sent: ${e.message}`); }
    }
    sent._day = today;
    fs.writeFileSync(sentFile, JSON.stringify(sent));
    log(`[prep] morning check: ${fresh.length} new missing thing${fresh.length !== 1 ? 's' : ''}`);
    return fresh;
  }

  return { coming, morning };
}

module.exports = { create };
