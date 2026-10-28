'use strict';
// The Stats tab's Curiosities (stats.js on the server): days by the sea and up in the mountains, the farthest you went
// each way, hemispheres, capitals, how far by each means, the beds you slept in, New Year's Eves, the weather on your
// rides, sleep away and at home. Uses the page's and layers.js's globals.

let curiositiesAsked = 0;
async function renderCuriosities() {
  const box = document.getElementById('curiosities');
  if (!box || Date.now() - curiositiesAsked < 5000) return;
  curiositiesAsked = Date.now();
  const c = await fetch('/api/curiosities').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!c) return;
  if (c.pending) {  // the first time: heights and the coast are being worked out
    box.innerHTML = '<div class="chart-section" style="margin-top:24px"><h3>Curiosities</h3><p class="sp-note">Being worked out (heights of every place you have been, the coast): back in a few minutes.</p></div>';
    setTimeout(() => { curiositiesAsked = 0; if (document.getElementById('tab-stats').classList.contains('active')) renderCuriosities(); }, 30000);
    return;
  }
  const pct = n => `${Math.round(n / c.days * 100)}% of ${c.days.toLocaleString()} days`;
  const town = p => (p?.id ? `<a href="#" class="sp-link" onclick="event.preventDefault(); openCityReport(${p.id})">${escapeHTML(p.town)}</a>` : escapeHTML(p?.town || ''));
  const where = p => `${p.town ? `${flagOf(p.country)}${town(p)}` : `${p.lat.toFixed(2)}°, ${p.lon.toFixed(2)}°`}, ${fmtDate(p.day)}`;
  const card = (label, value, sub = '') => `<div class="stat-card"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const act = a => `<a href="#" class="sp-link" onclick="event.preventDefault(); showActivityOnMap(${a.id})">${escapeHTML(a.name || '')}</a>, ${fmtDate(a.date)}`;
  const hm = s => `${Math.floor(s / 3600)}:${String(Math.round(s % 3600 / 60)).padStart(2, '0')}`;
  const h = c.heights, x = c.extremes, d = c.distance;

  let html = '<div class="chart-section" style="margin-top:24px"><h3>Curiosities</h3><div class="stat-cards curio-cards">' +
    card('Days by the sea', c.sea.days.toLocaleString(), `${pct(c.sea.days)}: within ${c.sea.km} km of a coast`) +
    card(`Days above ${fmtHeight(1000)}`, h.above[1000].toLocaleString(), `${h.above[2000]} above ${fmtHeight(2000)}, ${h.above[3000]} above ${fmtHeight(3000)}`) +
    (h.top ? card('Highest place', fmtHeight(h.top.h), where(h.top)) : '') +
    (h.activity ? card('Highest on foot or by bike', fmtHeight(h.activity.h), act(h.activity)) : '') +
    (h.topNight ? card('Highest night', fmtHeight(h.topNight.h), `${escapeHTML(h.topNight.hotel || h.topNight.place || '')}, ${fmtDate(h.topNight.start)}` +
      (h.highNights ? ` · ${h.highNights} nights above ${fmtHeight(1000)}` : '')) : '') +
    card('Northernmost', `${x.north.lat.toFixed(1)}°`, where(x.north)) +
    card('Southernmost', `${x.south.lat.toFixed(1)}°`, where(x.south)) +
    card('Farthest east', `${x.east.lon.toFixed(1)}°`, where(x.east)) +
    card('Farthest west', `${x.west.lon.toFixed(1)}°`, where(x.west)) +
    (x.farthest ? card('Farthest from home', fmtDist(x.farthest.km), where(x.farthest)) : '') +
    card('Southern hemisphere', `${c.zones.south.toLocaleString()} days`, `${c.zones.west.toLocaleString()} days west of Greenwich · ${c.zones.tropics.toLocaleString()} in the tropics` +
      (c.zones.arctic ? ` · ${c.zones.arctic} north of the Arctic Circle` : '')) +
    card('Capitals', c.capitals.length, c.capitals.slice(-3).reverse().map(t => escapeHTML(t.name)).join(', ') + (c.capitals.length > 3 ? '…' : '')) +
    card('Distance, every means', fmtDist(d.total), `${d.earth}× around the earth · ${d.moon}% of the way to the moon`) +
    (c.mostCountries ? card('Most countries in a day', c.mostCountries.count, `${c.mostCountries.countries.map(cc => flagOf(cc).trim()).join(' ')} ${fmtDate(c.mostCountries.day)}`) : '') +
    (c.longest ? card('Longest stay', `${c.longest.nights} nights`, `${escapeHTML(c.longest.place || '')}, from ${fmtDate(c.longest.start)}`) : '') +
    (c.rides ? card('Hottest ride', fmtTemp(c.rides.hottest.tmax), act(c.rides.hottest)) + card('Coldest ride', fmtTemp(c.rides.coldest.tmin), act(c.rides.coldest)) +
      card('Wettest ride', `${c.rides.wettest.rain} mm`, act(c.rides.wettest)) + card('Windiest ride', `gusts ${fmtWind(c.rides.windiest.gust || c.rides.windiest.wind)}`, act(c.rides.windiest)) +
      card('Rides in the rain', `${Math.round(c.rides.rainy / c.rides.count * 100)}%`, `${c.rides.rainy} of ${c.rides.count} rides with 1 mm or more`) : '') +
    (c.body ? card('Sleep away / at home', `${hm(c.body.away.sleep)} / ${hm(c.body.home.sleep)}`,
      `score ${c.body.away.score ?? '–'} / ${c.body.home.score ?? '–'} · resting heart rate ${c.body.away.rhr} / ${c.body.home.rhr} · ${c.body.away.steps?.toLocaleString()} / ${c.body.home.steps?.toLocaleString()} steps a day`) : '') +
    '</div>';

  // how far by each means, and the sea by year, as bars
  const names = { flight: '✈️ Flown', train: '🚆 Train', commute: '🔁 Commute', bus: '🚌 Bus', ferry: '⛴️ Ferry', hitch: '👍 Hitchhiked', drive: '🚙 By car', ride: '🚴 Cycled', run: '🏃 Run', walk: '🥾 Walked' };
  const max = Math.max(...Object.values(d.by));
  html += '<div class="music-cols" style="margin-top:16px"><div><h4>How far, by each means</h4><div class="curio-bars" style="grid-template-columns: 90px 1fr 80px">' +
    Object.entries(d.by).sort((a, b) => b[1] - a[1]).map(([k, km]) => `<span>${names[k] || k}</span><div class="bar" style="width:${Math.max(1, km / max * 100)}%"></div><span>${fmtDist(km)}</span>`).join('') + '</div></div>';
  const ys = Object.entries(c.sea.byYear).sort(), seaMax = Math.max(...ys.map(y => y[1]));
  html += `<div><h4>Days by the sea, by year</h4><div class="curio-bars">${ys.map(([y, n]) => `<span>${y}</span><div class="bar" style="width:${n / seaMax * 100}%"></div><span>${n}</span>`).join('')}</div></div></div>`;
  const beds = Object.entries(c.beds).sort((a, b) => b[1] - a[1]);
  html += `<p style="margin-top:16px"><b>Nights in stays:</b> ${beds.map(([k, n]) => `${escapeHTML(k)} ${n.toLocaleString()}`).join(' · ')}</p>`;
  if (c.nye.length) html += `<p><b>New Year's Eve:</b> ${c.nye.map(n => `${n.year} ${flagOf(n.country)}<a href="#" class="sp-link" onclick="event.preventDefault(); openCityReport(${n.id})">${escapeHTML(n.town)}</a>`).join(' · ')}</p>`;
  if (c.capitals.length) html += `<p><b>Capitals:</b> ${c.capitals.map(t => `${flagOf(t.country)}<a href="#" class="sp-link" onclick="event.preventDefault(); openCityReport(${t.id})">${escapeHTML(t.name)}</a>`).join(' · ')}</p>`;
  html += `<p class="sp-note">From every day Cairn knows a place for (${c.days.toLocaleString()} days since ${fmtDate(c.first)}): flights, trains, stays, activities, photos and Timeline. ` +
    `By the sea: Natural Earth's coastline. Heights: the ground's height at the place (AWS Terrain Tiles), so a flight counts where it landed, not in the air. ` +
    `Ride weather: Open-Meteo's history. Sleep and heart: Garmin, on trip days and on the others.</p></div>`;
  box.innerHTML = html;
}

// What the stays cost (spending.js): per year, country and town, the dearest and cheapest nights
async function renderSpending() {
  const box = document.getElementById('spending');
  const d = await fetch('/api/spending').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!box || !d || !d.priced) return;
  const eur = n => `€${Math.round(n).toLocaleString()}`;
  const card = (label, value, sub = '') => `<div class="stat-card"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const night = x => `${escapeHTML(x.hotel || x.place || '')}, ${escapeHTML(x.place || '')} · ${fmtDate(x.start)}`;
  const bars = (rows, label) => { const max = Math.max(...rows.map(r => r.eur)); return `<div class="curio-bars" style="grid-template-columns: minmax(0, max-content) 1fr max-content">` +
    rows.map(r => `<span>${label(r)}</span><div class="bar" style="width:${Math.max(1, r.eur / max * 100)}%"></div><span>${eur(r.eur)} · ${eur(r.perNight)}/night</span>`).join('') + '</div>'; };
  box.innerHTML = '<div class="chart-section" style="margin-top:24px"><h3>Spending on stays</h3><div class="stat-cards curio-cards">' +
    card('Spent on stays', eur(d.eur), `${d.nights.toLocaleString()} nights${d.ahead ? ` · ${eur(d.ahead)} booked ahead` : ''}`) +
    card('Per night', eur(d.perNight), `on average`) +
    (d.dearest[0] ? card('Dearest night', eur(d.dearest[0].perNight), night(d.dearest[0])) : '') +
    (d.cheapest[0] ? card('Cheapest night', eur(d.cheapest[0].perNight), night(d.cheapest[0])) : '') +
    card('Stays with a price', `${d.priced} of ${d.stays}`, 'the others are not counted') + '</div>' +
    `<div class="music-cols" style="margin-top:16px"><div><h4>By year</h4>${bars(d.byYear, r => r.id)}</div>` +
    `<div><h4>By country</h4>${bars(d.byCountry.slice(0, 12), r => `${flagOf(r.id)}${escapeHTML(new Intl.DisplayNames(['en'], { type: 'region' }).of(r.id) || r.id)}`)}</div></div>` +
    `<p style="margin-top:12px"><b>Towns:</b> ${d.byTown.map(t => `${flagOf(t.cc)}<a href="#" class="sp-link" onclick="event.preventDefault(); openCityReport(${t.id})">${escapeHTML(t.name)}</a> ${eur(t.eur)}`).join(' · ')}</p>` +
    `<p class="sp-note">Only stays with a price in their booking email or trip doc (${d.priced} of ${d.stays}), in euros on the day of the stay ` +
    '(ECB rates; for currencies the ECB does not publish, today\'s rate). Flights, trains and bank card spending are not in it yet.</p></div>';
}

window.addEventListener('load', () => setTimeout(renderCuriosities, 2000));
window.addEventListener('load', () => setTimeout(renderSpending, 2500));
