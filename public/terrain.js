'use strict';
// The 3D view: the map as a globe with real terrain (MapLibre GL, loaded the first time it is opened), showing the
// layers that are on in the 2D map (switched here too, the same choice), for the period or trip chosen, with flights
// as arcs through the air (deck.gl). Heights from the open AWS Terrain Tiles; the base map as chosen in the settings.
// Esc or "← 2D map" goes back to the same place. Uses layers.js's and the page's globals.

const MAPLIBRE = 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.6.0/';
const DECK = 'https://unpkg.com/deck.gl@9.1.14/dist.min.js';
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
let map3d = null, deckOverlay = null, libsLoading = null;
let view3d = 'globe';  // 'globe': flights as lines along the globe; 'flat': a flat map with flights as arcs through the air

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

// --- what is shown: the 2D map's layers, for the period chosen ---

const fc = features => ({ type: 'FeatureCollection', features });
const pt = (lat, lon, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
const line = (latlons, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: latlons.map(([a, b]) => [b, a]) } });

const LAYERS3D = {  // key in the 2D legend -> what it is, and its 2D layer
  flight: () => routeLayer, train: () => groundLayer.train, bus: () => groundLayer.bus, ferry: () => groundLayer.ferry,
  stay: () => stayLayer, car: () => carLayer, photo: () => photoLayer, ride: () => kindLayer.ride, run: () => kindLayer.run,
  walk: () => kindLayer.walk, sport: () => kindLayer.sport, climb: () => climbLayer, country: () => countryLayer, city: () => cityLayer
};
const shown = key => map.hasLayer(LAYERS3D[key]());

function data3d() {
  const acts = allActivities.filter(a => a.pts && a.pts.length > 3 && inWin(a.date)).map(a => {
    const c = [];
    for (let i = 0; i < a.pts.length; i += 2) c.push([a.pts[i + 1], a.pts[i]]);
    return { type: 'Feature', properties: { kind: a.kind, id: a.id, name: a.name || a.sport, date: day(a.date) }, geometry: { type: 'LineString', coordinates: c } };
  });
  const ground = allTrips.filter(t => inWin(t.date) && t.from_lat != null && t.to_lat != null)
    .map(t => line(t.path ? decodePath(t.path) : [[t.from_lat, t.from_lon], [t.to_lat, t.to_lon]], { mode: t.mode, name: `${t.from} → ${t.to}`, date: day(t.date) }));
  const stays = allStays.filter(s => s.lat != null && overlapsWin(s.start, s.end))
    .map(s => pt(s.lat, s.lon, { what: s.what, name: s.hotel || s.type || s.place, place: s.place, date: s.start }));
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
  const st = lineStyle(), col = k => getCSSVar('--' + k), grey = /^grey/.test(prefs.basemap);
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
        { id: 'base', type: 'raster', source: 'base', paint: grey ? { 'raster-saturation': -1, 'raster-contrast': -0.15 } : {} },
        { id: 'hills', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.35 } },
        { id: 'country', type: 'fill', source: 'countries', paint: { 'fill-color': col('country'), 'fill-opacity': 0.15 } },
        { id: 'acts', type: 'line', source: 'acts', layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': ['match', ['get', 'kind'], 'ride', col('ride'), 'run', col('run'), 'walk', col('walk'), col('sport')],
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1 * st.w, 12, 2.5 * st.w, 16, 4 * st.w], 'line-opacity': Math.min(1, 0.85 * st.o) } },
        { id: 'ground', type: 'line', source: 'ground', layout: { 'line-join': 'round' },
          paint: { 'line-color': ['match', ['get', 'mode'], 'train', col('train'), 'bus', col('bus'), col('ferry')], 'line-width': 2.5 * st.w, 'line-opacity': 0.9 } },
        { id: 'flightLines', type: 'line', source: 'flightLines', paint: { 'line-color': col('accent'), 'line-width': 1.5, 'line-opacity': 0.7 } },
        { id: 'climbLines', type: 'line', source: 'climbLines', paint: { 'line-color': col('climb'), 'line-width': 4 * st.w, 'line-opacity': 0.9 } },
        { id: 'stays', type: 'circle', source: 'stays', paint: { 'circle-radius': 5 * st.r, 'circle-color': ['match', ['get', 'what'], 'car', col('car'), col('stay')],
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } },
        { id: 'photo-groups', type: 'circle', source: 'photos', filter: ['has', 'point_count'],
          paint: { 'circle-radius': ['step', ['get', 'point_count'], 12, 50, 16, 500, 22], 'circle-color': col('photo'), 'circle-opacity': 0.8, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } },
        { id: 'photo-count', type: 'symbol', source: 'photos', filter: ['has', 'point_count'],
          layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 11, 'text-font': ['Noto Sans Regular'] } },
        { id: 'photo', type: 'circle', source: 'photos', filter: ['!', ['has', 'point_count']],
          paint: { 'circle-radius': 5, 'circle-color': col('photo'), 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } },
        { id: 'cities', type: 'circle', source: 'cities', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'days'], 1, 3, 100, 9, 1000, 16],
          'circle-color': col('city'), 'circle-opacity': 0.35, 'circle-stroke-color': col('city'), 'circle-stroke-width': 1.5 } },
        { id: 'climbs', type: 'circle', source: 'climbs', paint: { 'circle-radius': ['case', ['==', ['get', 'done'], 1], 6 * st.r, 4 * st.r],
          'circle-color': ['case', ['==', ['get', 'done'], 1], col('climb'), 'rgba(0,0,0,0)'],
          'circle-stroke-color': ['case', ['==', ['get', 'done'], 1], '#ffffff', col('climb')], 'circle-stroke-width': 1.5 } }
      ],
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      terrain: { source: 'dem', exaggeration: 1.4 },
      sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.4, 9, 0] }
    }
  });
  map3d.once('load', () => { map3d.resize(); refresh3D(); });
  map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map3d.addControl(new maplibregl.TerrainControl({ source: 'dem', exaggeration: 1.4 }), 'bottom-right');
  if (window.deck) {  // flights as arcs through the air, on the flat view (deck.gl does not draw them on MapLibre's globe)
    deckOverlay = new deck.MapboxOverlay({ interleaved: false, layers: [] });
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
  const kinds = Object.keys(ACT_KINDS).filter(shown);
  set('acts', d.acts.filter(f => kinds.includes(f.properties.kind)));
  set('ground', d.ground.filter(f => shown(f.properties.mode)));
  set('stays', d.stays.filter(f => shown(f.properties.what === 'car' ? 'car' : 'stay')));
  set('photos', d.photos);
  set('climbs', d.climbs);
  set('climbLines', d.climbLines);
  set('cities', d.cities);
  set('countries', d.countries);
  ['photo-groups', 'photo-count', 'photo'].forEach(l => vis(l, shown('photo')));
  vis('climbs', shown('climb')); vis('climbLines', shown('climb'));
  vis('cities', shown('city')); vis('country', shown('country'));
  // flights: arcs (deck.gl), else great-circle lines on the ground
  const flights = shown('flight') ? d.flights : [];
  if (deckOverlay && view3d === 'flat') {
    const accent = getCSSVar('--accent'), rgb = accent.match(/\w\w/g)?.map(h => parseInt(h, 16)) || [79, 195, 247];
    deckOverlay.setProps({ layers: [new deck.ArcLayer({ id: 'flights', data: flights, getSourcePosition: f => f.from, getTargetPosition: f => f.to,
      getSourceColor: [...rgb, 200], getTargetColor: [...rgb, 120], getWidth: 2 * lineStyle().w, getHeight: 0.4, greatCircle: false, pickable: true,
      onClick: info => info.object && new maplibregl.Popup().setLngLat(info.coordinate).setHTML(`<b>✈️ ${escapeHTML(info.object.name)}</b><br><small>${fmtDate(info.object.date)}</small>`).addTo(map3d) })] });
    set('flightLines', []);
  } else {
    deckOverlay?.setProps({ layers: [] });
    set('flightLines', flights.map(f => line(greatCircle(f.from[1], f.from[0], f.to[1], f.to[0]))));  // the page's greatCircle
  }
  draw3dPanel();
}

// The panel at the top left: back to 2D, the trip, and the layers (the same switches as the 2D legend)
function draw3dPanel() {
  const box = document.getElementById('map3d-panel');
  const trip = document.getElementById('p-trip');
  const labels = { flight: '✈️ Flights', train: '🚆 Trains', bus: '🚌 Buses', ferry: '⛴️ Ferries', stay: '🏨 Stays', car: '🚗 Rental cars',
    photo: '📷 Photos', ride: '🚴 Cycling', run: '🏃 Running', walk: '🥾 Walks & hikes', sport: '🏅 Other sports', climb: '⛰️ Climbs',
    country: '🌍 Countries', city: '🏙️ Cities' };
  box.innerHTML = `<button class="btn btn-primary map3d-back" onclick="close3D()" title="Back to the 2D map (Esc)">← 2D map</button>` +
    `<div class="map3d-views" role="group" aria-label="View"><button class="btn ${view3d === 'globe' ? 'btn-primary' : 'btn-ghost'}" onclick="setView3d('globe')" ` +
    `aria-pressed="${view3d === 'globe'}">🌍 Globe</button><button class="btn ${view3d === 'flat' ? 'btn-primary' : 'btn-ghost'}" onclick="setView3d('flat')" ` +
    `aria-pressed="${view3d === 'flat'}">🗺️ Flat map</button></div>` +
    `<p class="map3d-note">${view3d === 'globe' ? 'The earth as a ball; flights follow its curve on the ground. Choose Flat map to see them as arcs through the air.'
      : 'A flat map you can tilt (right-drag or Ctrl-drag); flights are arcs through the air.'}</p>` +
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
    const twin = document.querySelector(`#map-legend input[data-layer="${i.dataset.layer3d === 'ride' || i.dataset.layer3d === 'run' || i.dataset.layer3d === 'walk' || i.dataset.layer3d === 'sport' ? 'act-' + i.dataset.layer3d : i.dataset.layer3d}"]`);
    if (twin && twin.checked !== i.checked) twin.click();  // the 2D legend switches the layer (and remembers it)
    else (i.checked ? LAYERS3D[i.dataset.layer3d]().addTo(map) : map.removeLayer(LAYERS3D[i.dataset.layer3d]()));
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
