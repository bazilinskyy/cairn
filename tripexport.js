'use strict';
// A trip to take elsewhere: as KML (Google Earth, Google My Maps), as GPX (a GPS, a bike computer, any map app), and
// as one web page to share, with its map and day by day but none of the private things (no stays' names or
// addresses, booking codes, prices, sleep, heart rate, calendar events or photos).

const ground = require('./ground');

// the map's colours (public/index.html, the dark theme) and icons (MODES there): a rental car's drive is 'car', your own
// car journey 'drive'
const COLORS = { flight: '#4fc3f7', train: '#ffb74d', bus: '#81c784', ferry: '#b39ddb', hitch: '#ff8a65', drive: '#64b5f6', car: '#ffd54f', scooter: '#ffd54f',
  road: '#b0bec5', ride: '#d95926', run: '#9085e9', walk: '#d55181', sport: '#c98500' };
const ICONS = { flight: '✈️', train: '🚆', bus: '🚌', ferry: '⛴️', hitch: '👍', drive: '🚙', car: '🚗', scooter: '🛵', road: '🛣️', ride: '🚴', run: '🏃', walk: '🥾', sport: '🏅' };
const kindOfSport = s => (/Ride|Velomobile|Handcycle/.test(s || '') ? 'ride' : /Run/.test(s || '') ? 'run' : /Walk|Hike|Snowshoe/.test(s || '') ? 'walk' : 'sport');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// the great circle between two airports, as points
function greatCircle(a, b, n = 64) {
  const r = Math.PI / 180, [p1, l1, p2, l2] = [a[0] * r, a[1] * r, b[0] * r, b[1] * r];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (!d) return [a, b];
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2), y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2), z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push([Math.atan2(z, Math.hypot(x, y)) / r, Math.atan2(y, x) / r]);
  }
  return out;
}

// the trip's lines and places: { lines: [{ kind, name, when, pts }], points: [{ kind, name, place, when, at }] }
// trip: trips.js get(); groundTrips, activities, airports: the server's lists
function shapes(trip, { groundTrips, activities, airports }) {
  const lines = [], points = [];
  trip.flights.forEach(f => {
    const a = airports[f.from], b = airports[f.to];
    if (a && b) lines.push({ kind: 'flight', name: `${f.from_city || f.from} → ${f.to_city || f.to}`, code: `${f.flight_number || ''} ${f.from}–${f.to}`.trim(), when: f.date, pts: greatCircle([a.lat, a.lon], [b.lat, b.lon]) });
  });
  const gids = new Set(trip.ground.map(g => String(g.id)));
  groundTrips.filter(g => gids.has(String(g.id)) && g.from_lat != null && g.to_lat != null).forEach(g => {
    const pts = g.path ? ground.decode(g.path) : [[+g.from_lat, +g.from_lon], [+g.to_lat, +g.to_lon]];
    lines.push({ kind: ['train', 'bus', 'ferry', 'hitch', 'drive'].includes(g.mode) ? g.mode : 'bus', name: `${g.from} → ${g.to}`, when: g.date, pts });
  });
  trip.moves.filter(m => m.kind !== 'move').forEach(m => {
    lines.push({ kind: m.kind === 'drive' ? (m.by === 'scooter' ? 'scooter' : 'car') : 'road', name: m.kind === 'drive' ? (m.by === 'scooter' ? 'Scooter ride' : 'Drive') : 'By road',
      when: new Date(m.t0 * 1000).toISOString().slice(0, 16).replace('T', ' '), pts: m.path ? ground.decode(m.path) : [m.from, m.to] });
  });
  const aids = new Set(trip.activities.map(a => a.id));
  activities.filter(a => aids.has(a.id) && a.path).forEach(a => {
    lines.push({ kind: kindOfSport(a.sport), name: a.name || a.sport, when: a.date, km: a.distance, pts: ground.decode(a.path) });
  });
  trip.stays.filter(s => s.what !== 'car' && s.lat != null).forEach(s => {
    points.push({ kind: 'stay', name: s.hotel || s.type || 'Stay', place: s.place || '', when: s.start, until: s.end, at: [+s.lat, +s.lon] });
  });
  lines.sort((a, b) => String(a.when || '').localeCompare(String(b.when || '')));
  return { lines, points };
}

// KML: a folder per kind of line, styled in Cairn's colours, and the stays
function kml(trip, s) {
  const abgr = hex => `ff${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`;
  const coords = pts => pts.map(([la, lo]) => `${lo.toFixed(6)},${la.toFixed(6)},0`).join(' ');
  const kinds = [...new Set(s.lines.map(l => l.kind))];
  return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
    `<name>${esc(trip.name)}</name><description>${esc(`${trip.start} – ${trip.end}, ${trip.days} days`)}</description>` +
    Object.entries(COLORS).map(([k, c]) => `<Style id="${k}"><LineStyle><color>${abgr(c)}</color><width>${k === 'flight' ? 2 : 3}</width></LineStyle></Style>`).join('') +
    '<Style id="stay"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/shapes/lodging.png</href></Icon></IconStyle></Style>' +
    kinds.map(k => `<Folder><name>${ICONS[k]} ${esc(k)}</name>` + s.lines.filter(l => l.kind === k).map(l =>
      `<Placemark><name>${esc(l.name)}</name><description>${esc([l.when, l.code, l.km ? `${l.km} km` : ''].filter(Boolean).join(' · '))}</description>` +
      `${l.when ? `<TimeStamp><when>${esc(String(l.when).slice(0, 10))}</when></TimeStamp>` : ''}<styleUrl>#${k}</styleUrl>` +
      `<LineString><tessellate>1</tessellate><coordinates>${coords(l.pts)}</coordinates></LineString></Placemark>`).join('') + '</Folder>').join('') +
    (s.points.length ? '<Folder><name>🏨 stays</name>' + s.points.map(p => `<Placemark><name>${esc(p.name)}</name><description>${esc([p.place, `${p.when} – ${p.until || ''}`].filter(Boolean).join(' · '))}</description>` +
      `<styleUrl>#stay</styleUrl><Point><coordinates>${p.at[1]},${p.at[0]},0</coordinates></Point></Placemark>`).join('') + '</Folder>' : '') +
    '</Document></kml>\n';
}

// GPX: a track per line (its type the kind), a waypoint per stay
function gpx(trip, s) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Cairn" xmlns="http://www.topografix.com/GPX/1/1">' +
    `<metadata><name>${esc(trip.name)}</name><desc>${esc(`${trip.start} – ${trip.end}`)}</desc></metadata>` +
    s.points.map(p => `<wpt lat="${p.at[0]}" lon="${p.at[1]}"><name>${esc(p.name)}</name><desc>${esc([p.place, p.when].filter(Boolean).join(' · '))}</desc><type>stay</type></wpt>`).join('') +
    s.lines.map(l => `<trk><name>${esc(l.name)}</name>${l.when ? `<desc>${esc(String(l.when))}</desc>` : ''}<type>${esc(l.kind)}</type><trkseg>` +
      l.pts.map(([la, lo]) => `<trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"/>`).join('') + '</trkseg></trk>').join('') +
    '</gpx>\n';
}

// One page to share: its own map (Leaflet and OpenStreetMap's tiles from the web) and the trip day by day, nothing private
function sharePage(trip, s) {
  const names = (() => { try { const n = new Intl.DisplayNames(['en'], { type: 'region' }); return cc => { try { return n.of(cc); } catch (_) { return cc; } }; } catch (_) { return cc => cc; } })();
  const flag = cc => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map(c => 0x1F1A5 + c.charCodeAt(0))) : '');
  const fmt = d => new Date(d.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const km = n => Math.round(n).toLocaleString('en-GB');
  const lineKm = pts => pts.reduce((n, p, i) => (i ? n + ground.km(pts[i - 1], p) : 0), 0);
  const totals = {};
  s.lines.forEach(l => { totals[l.kind] = (totals[l.kind] || 0) + lineKm(l.pts); });
  const byDay = {};
  s.lines.forEach(l => { const d = String(l.when || '').slice(0, 10); (byDay[d] = byDay[d] || []).push(l); });
  const days = trip.dayList.map(x => {
    const moved = (byDay[x.day] || []).map(l => `<li>${ICONS[l.kind]} ${esc(l.name)}${l.km ? ` <small>${l.km} km</small>` : l.kind !== 'flight' ? ` <small>${km(lineKm(l.pts))} km</small>` : ''}</li>`);
    const night = s.points.find(p => p.when <= x.day && (p.until || p.when) > x.day);
    const town = x.towns[0];
    if (!x.towns.length && !moved.length) return '';
    return `<section><h3>${esc(fmt(x.day))} <span>${x.towns.map(t => `${flag(t.country)} ${esc(t.name)}`).join(' · ')}</span></h3>` +
      `<ul>${moved.join('')}${night ? `<li>🌙 Night in ${esc(town?.name || night.place.split(',')[0] || '')}</li>` : ''}${x.photos ? `<li>📷 ${x.photos} photo${x.photos > 1 ? 's' : ''}</li>` : ''}</ul></section>`;
  }).join('');
  const stats = [[trip.days, 'days'], [trip.countries.length, trip.countries.length === 1 ? 'country' : 'countries'],
    [trip.towns.length, 'towns'], ...Object.entries(totals).filter(([, v]) => v >= 1).map(([k, v]) => [`${km(v)} km`, `${ICONS[k]} ${k === 'road' ? 'by road' : k}`])];
  const data = { lines: s.lines.map(l => ({ k: l.kind, n: l.name, p: l.pts.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]) })), colors: COLORS };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(trip.name)}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<style>
:root{--bg:#0f1117;--card:#181b24;--text:#e8e8f0;--muted:#8a8fa3;--line:#2a2e3a}
@media (prefers-color-scheme: light){:root{--bg:#f6f5f2;--card:#fff;--text:#1d1d24;--muted:#6b6f80;--line:#e3e1dc}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,system-ui,"Segoe UI",sans-serif}
header{max-width:900px;margin:0 auto;padding:32px 16px 8px}h1{margin:0;font-size:30px}h1 small{display:block;font-size:15px;color:var(--muted);font-weight:400;margin-top:4px}
#map{height:min(62vh,560px);max-width:900px;margin:16px auto;border-radius:14px;overflow:hidden}
.stats{display:flex;flex-wrap:wrap;gap:10px;max-width:900px;margin:0 auto;padding:0 16px}.stats div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 14px}
.stats b{display:block;font-size:20px}.stats span{color:var(--muted);font-size:13px}
main{max-width:900px;margin:0 auto;padding:16px}section{border-top:1px solid var(--line);padding:12px 0}h3{margin:0 0 6px;font-size:15px}h3 span{font-weight:400;color:var(--muted);margin-left:8px}
ul{list-style:none;margin:0;padding:0}@media (prefers-color-scheme: dark){.leaflet-tile-pane{filter:grayscale(1) invert(1) contrast(.85) brightness(.7)}}li{padding:2px 0}small{color:var(--muted)}footer{max-width:900px;margin:0 auto;padding:16px 16px 40px;color:var(--muted);font-size:12px}
</style></head><body>
<header><h1>${trip.countries.map(c => flag(c.cc)).join(' ')} ${esc(trip.name)}<small>${esc(fmt(trip.start))} – ${esc(fmt(trip.end))} · ${trip.countries.map(c => esc(names(c.cc))).join(', ')}</small></h1></header>
<div id="map"></div>
<div class="stats">${stats.map(([v, l]) => `<div><b>${esc(String(v))}</b><span>${esc(l)}</span></div>`).join('')}</div>
<main>${days}</main>
<footer>Made with Cairn. Map © OpenStreetMap contributors.</footer>
<script>
const D=${JSON.stringify(data).replace(/</g, '\\u003c')};
const m=L.map('map',{scrollWheelZoom:false});
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors',maxZoom:19}).addTo(m);
const b=[];D.lines.forEach(l=>{L.polyline(l.p,{color:D.colors[l.k]||'#999',weight:l.k==='flight'?2:3.5,opacity:.9,dashArray:l.k==='flight'?'6 6':null}).bindTooltip(l.n).addTo(m);b.push(...l.p);});
b.length?m.fitBounds(b,{padding:[24,24]}):m.setView([20,0],2);
</script></body></html>
`;
}

module.exports = { shapes, kml, gpx, sharePage, greatCircle, COLORS };
