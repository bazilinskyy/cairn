'use strict';
// The 3D view: the map as a globe with real terrain (MapLibre GL, loaded the first time it is opened), showing the
// layers that are on in the 2D map (switched here too, the same choice), for the period or trip chosen, with flights
// along their rough path through the air (deck.gl). Heights from the open AWS Terrain Tiles; the base map as chosen in
// the settings.
// Esc or "← 2D map" goes back to the same place. Uses layers.js's and the page's globals.

const MAPLIBRE = 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.6.0/';
const DECK = 'https://unpkg.com/deck.gl@9.1.14/dist.min.js';
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
let map3d = null, deckOverlay = null, libsLoading = null;
let view3d = 'globe';  // 'globe': the earth as a ball; 'flat': a flat map you can tilt
let flights3d = 'air';  // 'air': flights along their rough path through the air; 'ground': their line on the ground

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const js = document.createElement('script');
    js.src = src;
    js.onload = resolve;
    js.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(js);
  });
}

function loadLibs() {
  if (!libsLoading) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = MAPLIBRE + 'maplibre-gl.min.css';
    document.head.appendChild(css);
    libsLoading = loadScript(MAPLIBRE + 'maplibre-gl.min.js')
      .then(() => loadScript(DECK).catch(() => null))  // without deck.gl: flights as lines on the ground
      .catch(e => { libsLoading = null; throw e; });
  }
  return libsLoading;
}

// The base map's tiles as MapLibre wants them ({s} subdomains are not supported there: the first one is used)
function baseSource() {
  const b = BASEMAPS[prefs.basemap] || BASEMAPS.auto, [url, attribution, maxzoom = 19] = b.tiles;
  return { type: 'raster', tiles: [url.replace('{s}', 'a')], tileSize: 256, attribution, maxzoom };
}

// The base map toned as in 2D (where CSS filters do it): dark when following a dark theme or chosen dark grey (lightness
// turned round, the hues kept), grey, or a little dimmed under a dark theme; so the lines, coloured for the map's tone,
// stand out on it
function baseTone() {
  const b = BASEMAPS[prefs.basemap] ? prefs.basemap : 'auto', dark = document.documentElement.dataset.theme !== 'light';
  const plain = { 'raster-brightness-min': 0, 'raster-brightness-max': 1, 'raster-hue-rotate': 0, 'raster-saturation': 0, 'raster-contrast': 0 };
  if (b === 'auto' && dark) return { ...plain, 'raster-brightness-min': 0.85, 'raster-brightness-max': 0, 'raster-hue-rotate': 180, 'raster-saturation': -0.4 };
  if (b === 'grey-dark') return { ...plain, 'raster-brightness-min': 0.8, 'raster-brightness-max': 0, 'raster-saturation': -1, 'raster-contrast': -0.25 };
  if (b === 'grey') return { ...plain, 'raster-saturation': -1, 'raster-contrast': -0.2 };
  return dark && b !== 'auto' ? { ...plain, 'raster-brightness-max': 0.85 } : plain;
}

// The colours of the layers, for the map's tone (set again when the theme or the base map changes)
function colours3d() {
  const col = k => mapVar('--' + k), stay = ['match', ['get', 'shade'], 'stay2', col('stay2'), 'stay3', col('stay3'), col('stay')];
  return {
    base: baseTone(),
    country: { 'fill-color': col('country') },
    acts: { 'line-color': ['match', ['get', 'kind'], 'ride', col('ride'), 'run', col('run'), 'walk', col('walk'), col('sport')] },
    ground: { 'line-color': ['match', ['get', 'mode'], 'train', col('train'), 'commute', col('commute'), 'bus', col('bus'), 'hitch', col('hitch'), 'drive', col('drive'), col('ferry')] },
    flightLines: { 'line-color': col('accent') },
    climbLines: { 'line-color': col('climb') },
    stays: { 'circle-color': ['match', ['get', 'shade'], 'car', col('car'), 'stay2', col('stay2'), 'stay3', col('stay3'), col('stay')],
      'circle-stroke-color': ['case', ['get', 'ring'], stay, '#fff'] },
    'photo-groups': { 'circle-color': col('photo') },
    photo: { 'circle-color': col('photo') },
    cities: { 'circle-color': col('city'), 'circle-stroke-color': col('city') },
    climbs: { 'circle-color': ['case', ['==', ['get', 'done'], 1], col('climb'), 'rgba(0,0,0,0)'],
      'circle-stroke-color': ['case', ['==', ['get', 'done'], 1], '#ffffff', col('climb')] }
  };
}

// --- what is shown: the 2D map's layers, for the period chosen ---

const fc = features => ({ type: 'FeatureCollection', features });
const pt = (lat, lon, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
const line = (latlons, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: latlons.map(([a, b]) => [b, a]) } });

const LAYERS3D = {  // key in the 2D legend -> what it is, and its 2D layer
  flight: () => routeLayer, train: () => groundLayer.train, commute: () => groundLayer.commute, bus: () => groundLayer.bus, ferry: () => groundLayer.ferry,
  hitch: () => groundLayer.hitch, drive: () => groundLayer.drive, car: () => carLayer, photo: () => photoLayer, ride: () => kindLayer.ride, run: () => kindLayer.run,
  walk: () => kindLayer.walk, sport: () => kindLayer.sport, climb: () => climbLayer, country: () => countryLayer, city: () => cityLayer
};
// stays: one switch here for the kinds of bed the 2D legend lists apart; on while any of its rows is
const shown = key => {
  if (key !== 'stay') return map.hasLayer(LAYERS3D[key]());
  const g = document.querySelector('#map-legend [data-group="stay"]');
  return g ? g.checked || g.indeterminate : false;
};

function data3d() {
  const acts = allActivities.filter(a => a.pts && a.pts.length > 3 && inWin(a.date)).map(a => {
    const c = [];
    for (let i = 0; i < a.pts.length; i += 2) c.push([a.pts[i + 1], a.pts[i]]);
    return { type: 'Feature', properties: { kind: a.kind, id: a.id, name: a.name || a.sport, date: day(a.date) }, geometry: { type: 'LineString', coordinates: c } };
  });
  const ground = shownGround().filter(t => t.from_lat != null && t.to_lat != null)
    .map(t => line(t.path ? decodePath(t.path) : [[t.from_lat, t.from_lon], [t.to_lat, t.to_lon]], { mode: groundKind(t), name: `${t.from} → ${t.to}`, date: day(t.date) }));
  const stays = allStays.filter(s => s.lat != null && overlapsWin(s.start, s.end))
    .map(s => pt(s.lat, s.lon, { what: s.what, kind: s.what === 'car' ? '' : stayKindOf(s), shade: s.what === 'car' ? 'car' : STAY_KINDS[stayKindOf(s)][2].slice(2),
      ring: s.what !== 'car' && !!STAY_KINDS[stayKindOf(s)][3], name: s.hotel || s.type || s.place, place: s.place, date: s.start }));
  const photos = (allPhotoPoints || []).filter(p => inWin(photoDay(p))).map(p => pt(p[2], p[3], { id: p[0], t: p[1] }));
  const climbs = allClimbs.map(c => pt(c.lat, c.lon, { id: c.id, name: c.name, ele: c.ele || 0, done: climbDone(c) ? 1 : 0, times: c.times }));
  const climbLines = allClimbs.flatMap(c => [...(c.ascents || []).filter(a => a.times).map(a => a.path), ...(c.other || []).map(o => o.path)]
    .filter(Boolean).map(p => line(decodePath(p))));
  const cities = topCities.map(c => pt(c.lat, c.lon, { name: c.name, days: c.days, id: c.id || 0 }));
  const regions = countryData.get(countryUrl());
  const countries = regions && !(regions instanceof Promise) ? regions.places.map(p => ({ type: 'Feature', properties: { name: p.name }, geometry: p.shape })) : [];
  const flights = allFlights.filter(f => inWin(f.date) && allAirports[f.from] && allAirports[f.to]).map(f => ({
    from: [allAirports[f.from].lon, allAirports[f.from].lat], to: [allAirports[f.to].lon, allAirports[f.to].lat],
    name: `${f.flight_number || ''} ${f.from} → ${f.to}`, date: day(f.date) }));
  return { acts, ground, stays, photos, climbs, climbLines, cities, countries, flights };
}

// A flight's rough path: the great circle between its airports (which flights roughly follow), climbing to cruising
// height over the first 300 km or so and coming down over the last 350, as [lon, lat, metres]. Heights are shown 10
// times higher (at most an eighth of the flight's length), as 11 km would not show at the scale of the globe.
const SHOWN_HIGHER = 10;
function flightPath(from, to) {
  const r = x => x * Math.PI / 180, [lon1, lat1] = from, [lon2, lat2] = to;
  const h = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  const km = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  const cruise = km < 400 ? 7000 : km < 1000 ? 9500 : 11000;
  const top = Math.min(cruise * SHOWN_HIGHER, km * 1000 / 8);
  const up = Math.min(300, km * 0.4), down = Math.min(350, km * 0.45);
  const ease = x => 1 - (1 - Math.min(1, Math.max(0, x))) ** 2;  // quick at first, levelling off
  const pts = greatCircle(lat1, lon1, lat2, lon2, Math.max(20, Math.min(200, Math.round(km / 25))));  // the page's
  return pts.map(([lat, lon], i) => {
    const s = km * i / (pts.length - 1);
    return [lon, lat, top * Math.min(ease(s / up), ease((km - s) / down))];
  });
}

// --- the view ---

async function open3D() {
  try { await loadLibs(); } catch (e) { return toast(e.message, 'error'); }
  const box = document.getElementById('map3d');
  box.hidden = false;
  await new Promise(r => requestAnimationFrame(r));  // laid out before MapLibre measures it
  const c = map.getCenter(), z = Math.max(0, map.getZoom() - 1);  // MapLibre's tiles are twice Leaflet's
  draw3dPanel();
  if (map3d) {
    refresh3D();
    map3d.jumpTo({ center: [c.lng, c.lat], zoom: z });
    map3d.resize();
    return;
  }
  const st = lineStyle(), c3 = colours3d();
  map3d = new maplibregl.Map({
    container: 'map3d-canvas', center: [c.lng, c.lat], zoom: z, pitch: z > 7 ? 60 : 0, maxPitch: 80,
    style: {
      version: 8, projection: { type: view3d === 'flat' ? 'mercator' : 'globe' },
      sources: {
        base: baseSource(),
        dem: { type: 'raster-dem', tiles: [DEM_TILES], tileSize: 256, encoding: 'terrarium', maxzoom: 15,
          attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>' },
        ...Object.fromEntries(['acts', 'ground', 'stays', 'climbs', 'climbLines', 'cities', 'countries', 'flightLines'].map(k => [k, { type: 'geojson', data: fc([]) }])),
        photos: { type: 'geojson', data: fc([]), cluster: true, clusterRadius: 40, clusterMaxZoom: 15 }
      },
      layers: [
        { id: 'base', type: 'raster', source: 'base', paint: c3.base },
        { id: 'hills', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.35 } },
        { id: 'country', type: 'fill', source: 'countries', paint: { ...c3.country, 'fill-opacity': 0.15 } },
        { id: 'acts', type: 'line', source: 'acts', layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { ...c3.acts,
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1 * st.w, 12, 2.5 * st.w, 16, 4 * st.w], 'line-opacity': Math.min(1, 0.85 * st.o) } },
        { id: 'ground', type: 'line', source: 'ground', layout: { 'line-join': 'round' },
          paint: { ...c3.ground, 'line-width': 2.5 * st.w, 'line-opacity': 0.9 } },
        { id: 'flightLines', type: 'line', source: 'flightLines', paint: { ...c3.flightLines, 'line-width': 1.5, 'line-opacity': 0.7 } },
        { id: 'climbLines', type: 'line', source: 'climbLines', paint: { ...c3.climbLines, 'line-width': 4 * st.w, 'line-opacity': 0.9 } },
        { id: 'stays', type: 'circle', source: 'stays', paint: { 'circle-radius': 5 * st.r,  // by kind of bed, as in 2D: a free one a ring
          ...c3.stays, 'circle-opacity': ['case', ['get', 'ring'], 0.15, 1],
          'circle-stroke-width': ['case', ['get', 'ring'], 2.5, 1] } },
        { id: 'photo-groups', type: 'circle', source: 'photos', filter: ['has', 'point_count'],
          paint: { 'circle-radius': ['step', ['get', 'point_count'], 12, 50, 16, 500, 22], ...c3['photo-groups'], 'circle-opacity': 0.8, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } },
        { id: 'photo-count', type: 'symbol', source: 'photos', filter: ['has', 'point_count'],
          layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 11, 'text-font': ['Noto Sans Regular'] } },
        { id: 'photo', type: 'circle', source: 'photos', filter: ['!', ['has', 'point_count']],
          paint: { 'circle-radius': 5, ...c3.photo, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } },
        { id: 'cities', type: 'circle', source: 'cities', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'days'], 1, 3, 100, 9, 1000, 16],
          ...c3.cities, 'circle-opacity': 0.35, 'circle-stroke-width': 1.5 } },
        { id: 'climbs', type: 'circle', source: 'climbs', paint: { 'circle-radius': ['case', ['==', ['get', 'done'], 1], 6 * st.r, 4 * st.r],
          ...c3.climbs, 'circle-stroke-width': 1.5 } }
      ],
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      terrain: { source: 'dem', exaggeration: 1.4 },
      sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.4, 9, 0] }
    }
  });
  map3d.once('load', () => { map3d.resize(); refresh3D(); });
  map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map3d.addControl(new maplibregl.TerrainControl({ source: 'dem', exaggeration: 1.4 }), 'bottom-right');
  if (window.deck) {  // flights through the air (deck.gl, drawn in MapLibre's own layers: so also on the globe)
    deckOverlay = new deck.MapboxOverlay({ interleaved: true, layers: [] });
    map3d.addControl(deckOverlay);
  }
  const popup = (e, html) => new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(e.lngLat).setHTML(html).addTo(map3d);
  const on = (layer, html) => {
    map3d.on('click', layer, e => popup(e, html(e.features[0].properties, e)));
    map3d.on('mouseenter', layer, () => { map3d.getCanvas().style.cursor = 'pointer'; });
    map3d.on('mouseleave', layer, () => { map3d.getCanvas().style.cursor = ''; });
  };
  on('climbs', p => `<b>⛰️ ${escapeHTML(p.name)}</b>${p.ele ? ` · ${fmtHeight(p.ele)}` : ''}<br><small>${p.done ? `climbed ${p.times}×` : 'not climbed yet'}</small>` +
    `<br><a href="#" onclick="event.preventDefault(); close3D(); openClimb('${p.id}')">Open climb page →</a>`);
  on('acts', p => `<b>${escapeHTML(p.name)}</b><br><small>${fmtDate(p.date)}</small>`);
  on('ground', p => `<b>${escapeHTML(p.name)}</b><br><small>${p.mode} · ${fmtDate(p.date)}</small>`);
  on('stays', p => `<b>${p.what === 'car' ? '🚗' : '🏨'} ${escapeHTML(p.name || '')}</b><br><small>${escapeHTML(p.place || '')} · ${fmtDate(p.date)}</small>`);
  on('photo', p => photoPopup([p.id, p.t]));
  on('cities', p => `<b>🏙️ ${escapeHTML(p.name)}</b><br><small>${p.days} days</small>` +
    (p.id ? `<br><a href="#" onclick="event.preventDefault(); close3D(); openCityReport(${p.id})">Open report →</a>` : ''));
  map3d.on('click', 'photo-groups', e => {  // a group: zoom in to it
    const f = e.features[0];
    map3d.getSource('photos').getClusterExpansionZoom(f.properties.cluster_id).then(zoom => map3d.easeTo({ center: f.geometry.coordinates, zoom }));
  });
}

function refresh3D() {
  if (!map3d || !map3d.getSource('acts')) return;  // (isStyleLoaded is false while any tile is still loading)
  const d = data3d();
  const set = (src, features) => map3d.getSource(src)?.setData(fc(features));
  const vis = (layer, on) => map3d.getLayer(layer) && map3d.setLayoutProperty(layer, 'visibility', on ? 'visible' : 'none');
  // the theme or the base map may have changed: the tiles, their tone and the colours again
  const base = baseSource().tiles[0], src = map3d.getSource('base');
  if (src.tiles?.[0] !== base) src.setTiles([base]);
  Object.entries(colours3d()).forEach(([layer, paint]) => Object.entries(paint).forEach(([k, v]) => map3d.setPaintProperty(layer, k, v)));
  const kinds = Object.keys(ACT_KINDS).filter(shown);
  set('acts', d.acts.filter(f => kinds.includes(f.properties.kind)));
  set('ground', d.ground.filter(f => shown(f.properties.mode)));
  set('stays', d.stays.filter(f => (f.properties.what === 'car' ? shown('car') : map.hasLayer(stayLayers[f.properties.kind]))));
  set('photos', d.photos);
  set('climbs', d.climbs);
  set('climbLines', d.climbLines);
  set('cities', d.cities);
  set('countries', d.countries);
  ['photo-groups', 'photo-count', 'photo'].forEach(l => vis(l, shown('photo')));
  vis('climbs', shown('climb')); vis('climbLines', shown('climb'));
  vis('cities', shown('city')); vis('country', shown('country'));
  // flights: through the air (deck.gl), with their line on the ground faint beneath; else that line alone
  const flights = shown('flight') ? d.flights : [], air = deckOverlay && flights3d === 'air';
  set('flightLines', flights.map(f => line(greatCircle(f.from[1], f.from[0], f.to[1], f.to[0]))));  // the page's greatCircle
  map3d.setPaintProperty('flightLines', 'line-opacity', air ? 0.2 : 0.7);
  if (air) {
    const accent = mapVar('--accent'), rgb = accent.match(/\w\w/g)?.map(h => parseInt(h, 16)) || [79, 195, 247];
    const once = new Map();  // a route flown more often: once, a little wider
    flights.forEach(f => { const k = [f.from, f.to].map(String).sort().join('|'); once.set(k, { ...f, n: (once.get(k)?.n || 0) + 1, names: [...(once.get(k)?.names || []), f] }); });
    deckOverlay.setProps({ layers: [new deck.PathLayer({ id: 'flights', data: [...once.values()].map(f => ({ ...f, path: flightPath(f.from, f.to) })),
      getPath: f => f.path, getColor: [...rgb, 210], getWidth: f => Math.min(1.5 + Math.log2(f.n), 4) * lineStyle().w, widthUnits: 'pixels',
      jointRounded: true, capRounded: true, pickable: true,
      onClick: info => info.object && new maplibregl.Popup().setLngLat(info.coordinate).setHTML(`<b>✈️ ${escapeHTML(info.object.name.replace(/^\S+ /, ''))}</b><br><small>` +
        `${info.object.n} flight${info.object.n > 1 ? 's' : ''}: ${info.object.names.slice(-5).map(x => fmtDate(x.date)).join(', ')}${info.object.n > 5 ? ', …' : ''}</small>`).addTo(map3d) })] });
  } else deckOverlay?.setProps({ layers: [] });
  draw3dPanel();
}

// The panel at the top left: back to 2D, the trip, and the layers (the same switches as the 2D legend)
function draw3dPanel() {
  const box = document.getElementById('map3d-panel');
  const trip = document.getElementById('p-trip');
  const labels = { flight: '✈️ Flights', train: '🚆 Trains', commute: '🔁 Commutes', bus: '🚌 Buses', ferry: '⛴️ Ferries', hitch: '👍 Hitchhiking', drive: '🚙 By car', stay: '🏨 Stays', car: '🚗 Rental cars',
    photo: '📷 Photos', ride: '🚴 Cycling', run: '🏃 Running', walk: '🥾 Walks & hikes', sport: '🏅 Other sports', climb: '⛰️ Climbs',
    country: '🌍 Countries', city: '🏙️ Cities' };
  box.innerHTML = `<button class="btn btn-primary map3d-back" onclick="close3D()" title="Back to the 2D map (Esc)">← 2D map</button>` +
    `<div class="map3d-views" role="group" aria-label="View"><button class="btn ${view3d === 'globe' ? 'btn-primary' : 'btn-ghost'}" onclick="setView3d('globe')" ` +
    `aria-pressed="${view3d === 'globe'}">🌍 Globe</button><button class="btn ${view3d === 'flat' ? 'btn-primary' : 'btn-ghost'}" onclick="setView3d('flat')" ` +
    `aria-pressed="${view3d === 'flat'}">🗺️ Flat map</button></div>` +
    `<p class="map3d-note">${view3d === 'globe' ? 'The earth as a ball.' : 'A flat map you can tilt (right-drag or Ctrl-drag).'}</p>` +
    (window.deck ? `<div class="map3d-views" role="group" aria-label="Flights"><button class="btn ${flights3d === 'air' ? 'btn-primary' : 'btn-ghost'}" onclick="setFlights3d('air')" ` +
      `aria-pressed="${flights3d === 'air'}">✈️ In the air</button><button class="btn ${flights3d === 'ground' ? 'btn-primary' : 'btn-ghost'}" onclick="setFlights3d('ground')" ` +
      `aria-pressed="${flights3d === 'ground'}">〰️ On the ground</button></div>` +
      `<p class="map3d-note">${flights3d === 'air' ? 'Flights along their rough path: the shortest way over the globe, climbing, cruising and coming down (heights 10× higher, to show).'
        : 'Flights as their line on the ground.'}</p>` : '') +
    `<label class="map3d-trip">Trip <select id="map3d-trip">${trip ? trip.innerHTML : ''}</select></label>` +
    `<div class="map3d-layers">${Object.entries(labels).map(([k, label]) =>
      `<label><input type="checkbox" data-layer3d="${k}" ${shown(k) ? 'checked' : ''}> ${label}</label>`).join('')}</div>`;
  const sel = document.getElementById('map3d-trip');
  if (trip) sel.value = trip.value;
  sel.addEventListener('change', () => {  // the 2D map's trip choice, so both show the same
    trip.value = sel.value;
    trip.dispatchEvent(new Event('change'));
    refresh3D();
    const b = windowBounds();
    if (b) map3d.fitBounds([[b.getWest(), b.getSouth()], [b.getEast(), b.getNorth()]], { padding: 60, maxZoom: 9 });
  });
  box.querySelectorAll('[data-layer3d]').forEach(i => i.addEventListener('change', () => {
    const k = i.dataset.layer3d, layers = k === 'stay' ? Object.values(stayLayers) : [LAYERS3D[k]()];
    const twin = document.querySelector(k === 'stay' ? '#map-legend input[data-group="stay"]' : `#map-legend input[data-layer="${ACT_KINDS[k] ? 'act-' + k : k}"]`);
    if (twin && twin.checked !== i.checked) twin.click();  // the 2D legend switches the layer (and remembers it)
    else layers.forEach(l => (i.checked ? l.addTo(map) : map.removeLayer(l)));
    refresh3D();
  }));
}

function setView3d(v) {
  view3d = v;
  try { localStorage.setItem('cairn-3d-view', v); } catch (_) {}
  map3d?.setProjection({ type: v === 'flat' ? 'mercator' : 'globe' });
  refresh3D();
}
try { view3d = localStorage.getItem('cairn-3d-view') || 'globe'; } catch (_) {}

function setFlights3d(v) {
  flights3d = v;
  try { localStorage.setItem('cairn-3d-flights', v); } catch (_) {}
  refresh3D();
}
try { flights3d = localStorage.getItem('cairn-3d-flights') || 'air'; } catch (_) {}

function close3D() {
  document.getElementById('map3d').hidden = true;
  if (map3d) {
    const c = map3d.getCenter();
    map.setView([c.lat, c.lng], Math.round(map3d.getZoom() + 1));
  }
  setTimeout(() => map.invalidateSize(), 50);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.getElementById('map3d')?.hidden) close3D();
});

// A "3D" button with the others in the bottom right corner of the map
function add3DControl() {
  const Ctl = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar');
      const a = L.DomUtil.create('a', 'map-3d', bar);
      a.href = '#';
      a.title = '3D terrain and globe';
      a.setAttribute('role', 'button');
      a.textContent = '3D';
      L.DomEvent.on(a, 'click', e => { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); open3D(); });
      return bar;
    }
  });
  new Ctl().addTo(map);
}
