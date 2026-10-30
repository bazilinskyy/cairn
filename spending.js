'use strict';
// What your stays cost: the prices your booking emails and trip docs give ("43.50€", "217.77 CAD"), in euros on the
// day of the stay (the ECB's rates through Frankfurter; for currencies the ECB does not publish, such as AED or KZT,
// the open currency-api's), per night, per trip, per town, country and year. The rates are looked up once, in the
// background, and kept in data/rates.json. Only the stays with a price count: how many is said with every number.

const fs = require('fs');

const ECB = 'https://api.frankfurter.dev/v1/';
const OTHER = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/';
const SYMBOLS = { '€': 'EUR', '$': 'USD', '£': 'GBP', '¥': 'JPY', '₴': 'UAH', 'zł': 'PLN', 'kr': 'SEK', '₹': 'INR', '฿': 'THB', 'R$': 'BRL', '₺': 'TRY' };

// "43.50€", "€ 1.234,50", "217.77 CAD", "1,234.50 USD" -> { amount, currency } or null
function parsePrice(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const code = (s.match(/\b([A-Z]{3})\b/) || [])[1] || Object.entries(SYMBOLS).find(([sym]) => s.includes(sym))?.[1];
  const num = (s.match(/\d[\d.,\s]*/) || [])[0];
  if (!code || !num) return null;
  let n = num.replace(/\s/g, '');
  const lastDot = n.lastIndexOf('.'), lastComma = n.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) n = lastComma > lastDot ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
  else if (lastComma >= 0) n = /,\d{1,2}$/.test(n) ? n.replace(',', '.') : n.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3})+$/.test(n)) n = n.replace(/\./g, '');  // "1.234 €", "12.345 IDR": thousands
  const amount = Number(n);
  return Number.isFinite(amount) && amount > 0 ? { amount, currency: code } : null;
}

// stays(): Cairn's stays; townAt([lat, lon]): its town (cities.js); transactions(): your card payments and cash
// withdrawals (imports/bank.py: [{ date, amount (negative: spent), currency, description, country }]); dayTowns(): the
// town you were in each day (Map day -> { id, name, cc }); trips(): the trips ({ id, start, end, name })
function create({ stays, townAt, file, transactions = () => [], dayTowns = () => new Map(), trips = () => [], log = console.log }) {
  let rates = null, filling = false;
  const load = () => {
    if (!rates) { try { rates = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { rates = {}; } }
    return rates;
  };
  const key = (cur, day) => `${cur}|${day}`;

  // the euro rates the priced stays need, looked up one at a time
  function fill(needed) {
    if (filling || !needed.length) return;
    filling = true;
    (async () => {
      const r = load();
      for (const [cur, day] of needed) {
        try {
          let rate = null;
          const ecb = await fetch(`${ECB}${day}?base=${cur}&symbols=EUR`, { signal: AbortSignal.timeout(20000) }).then(x => (x.ok ? x.json() : null)).catch(() => null);
          if (ecb?.rates?.EUR) rate = ecb.rates.EUR;
          else {
            const other = await fetch(`${OTHER}${cur.toLowerCase()}.json`, { signal: AbortSignal.timeout(20000) }).then(x => (x.ok ? x.json() : null)).catch(() => null);
            rate = other?.[cur.toLowerCase()]?.eur || null;  // today's rate: the ECB does not publish this currency
          }
          r[key(cur, day)] = rate;
        } catch (e) { log(`[spending] ${e.message}`); break; }
        await new Promise(res => setTimeout(res, 300));
      }
      fs.writeFileSync(file, JSON.stringify(r));
      filling = false;
    })();
  }

  // every priced stay in euros: [{ stay, eur, nights, perNight, cc, town }]
  function priced() {
    const r = load(), out = [], needed = [];
    for (const s of stays()) {
      if (s.what === 'car') continue;
      const p = parsePrice(s.price);
      if (!p) continue;
      const day = s.start, nights = Math.max(1, Math.round((Date.parse(s.end || s.start) - Date.parse(s.start)) / 864e5));
      const rate = p.currency === 'EUR' ? 1 : r[key(p.currency, day)];
      if (rate === undefined) { needed.push([p.currency, day]); continue; }
      if (!rate) continue;
      const t = s.lat != null ? townAt([s.lat, s.lon]) : null;
      const eur = Math.round(p.amount * rate * 100) / 100;
      out.push({ stay: s, eur, nights, perNight: Math.round(eur / nights * 100) / 100, cc: t?.cc || '', town: t ? { id: t.id, name: t.name, cc: t.cc } : null,
        price: s.price });
    }
    fill(needed);
    return out;
  }

  // the card payments and cash withdrawals in euros, each where you were that day and on which trip: per year (away
  // and at home), country, town and trip, the trips with their stays' cost too; null without any
  function cardSummary() {
    const r = load(), needed = [], rows = [], ts = trips() || [], towns = dayTowns();
    for (const t of transactions() || []) {
      if (!(t.amount < 0 || (t.refund && t.amount > 0)) || !t.date) continue;  // a refund (a booking cancelled) takes off
      const rate = t.currency === 'EUR' ? 1 : r[key(t.currency, t.date)];
      if (rate === undefined) { needed.push([t.currency, t.date]); continue; }
      if (!rate) continue;
      const town = towns.get(t.date) || null, trip = ts.find(x => x.start <= t.date && t.date <= x.end);
      rows.push({ day: t.date, eur: -t.amount * rate, town, cc: town?.cc || t.country || '', trip, refund: !!t.refund });
    }
    fill(needed);
    if (!rows.length) return null;
    const sum = (list, k) => {
      const m = new Map();
      list.forEach(x => { const id = k(x); if (!id) return; const v = m.get(id) || { eur: 0, payments: 0, days: new Set() }; v.eur += x.eur; if (!x.refund) v.payments++, v.days.add(x.day); m.set(id, v); });
      return [...m].map(([id, v]) => ({ id, eur: Math.round(v.eur), payments: v.payments, days: v.days.size }));
    };
    const away = rows.filter(x => x.trip), total = list => Math.round(list.reduce((n, x) => n + x.eur, 0));
    const years = sum(rows, x => x.day.slice(0, 4)), awayYears = new Map(sum(away, x => x.day.slice(0, 4)).map(y => [y.id, y.eur]));
    const stayCost = new Map(ts.map(t => [t.id, 0]));
    priced().forEach(x => { const t = ts.find(t => t.start <= x.stay.start && x.stay.start <= t.end); if (t) stayCost.set(t.id, stayCost.get(t.id) + x.eur); });
    const byTrip = sum(away, x => x.trip.id).map(v => { const t = ts.find(x => x.id === v.id);
      return { ...v, name: t.name, start: t.start, end: t.end, tripDays: t.days, stays: Math.round(stayCost.get(t.id) || 0), all: v.eur + Math.round(stayCost.get(t.id) || 0) }; });
    return {
      eur: total(rows), payments: rows.filter(x => !x.refund).length, refunds: Math.round(-rows.filter(x => x.refund).reduce((n, x) => n + x.eur, 0)), first: rows.reduce((a, x) => (x.day < a ? x.day : a), rows[0].day), last: rows.reduce((a, x) => (x.day > a ? x.day : a), rows[0].day),
      away: total(away), awayDays: new Set(away.filter(x => !x.refund).map(x => x.day)).size,
      byYear: years.map(y => ({ ...y, away: awayYears.get(y.id) || 0 })).sort((a, b) => a.id.localeCompare(b.id)),
      byCountry: sum(away, x => x.cc).sort((a, b) => b.eur - a.eur),
      byTown: sum(rows, x => x.town && `${x.town.id}|${x.town.name}|${x.town.cc}`).sort((a, b) => b.eur - a.eur).slice(0, 20)
        .map(t => { const [id, name, cc] = t.id.split('|'); return { ...t, id: +id, name, cc }; }),
      byTrip: byTrip.sort((a, b) => b.all - a.all)
    };
  }

  // the totals: per year, country and town, the dearest and cheapest nights, how many stays had a price
  function summary() {
    const list = priced(), all = stays().filter(s => s.what !== 'car'), today = new Date().toISOString().slice(0, 10);
    const sum = (rows, k) => {
      const m = new Map();
      rows.forEach(x => { const id = k(x); if (!id) return; const v = m.get(id) || { eur: 0, nights: 0, stays: 0 }; v.eur += x.eur; v.nights += x.nights; v.stays++; m.set(id, v); });
      return [...m].map(([id, v]) => ({ id, eur: Math.round(v.eur), nights: v.nights, stays: v.stays, perNight: Math.round(v.eur / v.nights) }));
    };
    const past = list.filter(x => x.stay.start <= today);
    const one = x => ({ id: x.stay.id, hotel: x.stay.hotel || x.stay.type || '', place: x.stay.place, start: x.stay.start, nights: x.nights, perNight: x.perNight, price: x.price });
    const byNight = [...past].sort((a, b) => b.perNight - a.perNight);
    return {
      stays: all.length, priced: list.length, nights: past.reduce((n, x) => n + x.nights, 0), eur: Math.round(past.reduce((n, x) => n + x.eur, 0)),
      perNight: past.length ? Math.round(past.reduce((n, x) => n + x.eur, 0) / past.reduce((n, x) => n + x.nights, 0)) : null,
      byYear: sum(past, x => x.stay.start.slice(0, 4)).sort((a, b) => a.id.localeCompare(b.id)),
      byCountry: sum(past, x => x.cc).sort((a, b) => b.eur - a.eur),
      byTown: sum(past, x => x.town && `${x.town.id}|${x.town.name}|${x.town.cc}`).sort((a, b) => b.eur - a.eur).slice(0, 15)
        .map(t => { const [id, name, cc] = t.id.split('|'); return { ...t, id: +id, name, cc }; }),
      byProvider: sum(past, x => x.stay.provider || 'other').sort((a, b) => b.eur - a.eur),
      dearest: byNight.slice(0, 5).map(one), cheapest: byNight.slice(-5).reverse().map(one),
      ahead: Math.round(list.filter(x => x.stay.start > today).reduce((n, x) => n + x.eur, 0)),
      card: cardSummary()
    };
  }

  // a trip's stays: what they cost, and how many of them had a price; and the card payments and cash on its days
  function forTrip(start, end) {
    const list = priced().filter(x => x.stay.start <= end && (x.stay.end || x.stay.start) >= start);
    const all = stays().filter(s => s.what !== 'car' && s.start && s.start <= end && (s.end || s.start) >= start);
    const eur = list.reduce((n, x) => n + x.eur, 0), nights = list.reduce((n, x) => n + x.nights, 0);
    return { eur: Math.round(eur), nights, perNight: nights ? Math.round(eur / nights) : null, priced: list.length, stays: all.length,
      card: cardOf(start, end) };
  }

  // the card payments and cash withdrawals of these days in euros (on each day's rate): { eur, payments } or null
  function cardOf(start, end) {
    const r = load(), needed = [];
    let eur = 0, payments = 0;
    for (const t of transactions() || []) {
      if (t.date < start || t.date > end || !(t.amount < 0 || (t.refund && t.amount > 0))) continue;
      const rate = t.currency === 'EUR' ? 1 : r[key(t.currency, t.date)];
      if (rate === undefined) { needed.push([t.currency, t.date]); continue; }
      if (!rate) continue;
      eur += -t.amount * rate;
      if (!t.refund) payments++;
    }
    fill(needed);
    return payments ? { eur: Math.round(eur), payments } : null;
  }

  return { summary, forTrip, priced };
}

module.exports = { create, parsePrice };
