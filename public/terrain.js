'use strict';
// The 3D view: the map as a globe with real terrain (MapLibre GL, loaded the first time it is opened), with your
// activities of the types shown on the map and the famous climbs, done ones filled. Heights from the open AWS
// Terrain Tiles (terrarium); the base map as chosen in the settings. Uses layers.js's globals.

const MAPLIBRE = 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.6.0/';
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
let map3d = null, maplibreLoading = null;

function loadMaplibre() {
  if (window.maplibregl) return Promise.resolve();
  if (!maplibreLoading) {
    maplibreLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = MAPLIBRE + 'maplibre-gl.min.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = MAPLIBRE + 'maplibre-gl.min.js';
      js.onload = resolve;
      js.onerror = () => { maplibreLoading = null; reject(new Error('could not load MapLibre')); };
      document.head.appendChild(js);
    });
  }
  return maplibreLoading;
}

// The base map's tiles as MapLibre wants them ({s} subdomains are not supported there: the first one is used)
function baseSource() {
  const b = BASEMAPS[prefs.basemap] || BASEMAPS.auto, [url, attribution, maxzoom = 19] = b.tiles;
  return { type: 'raster', tiles: [url.replace('{s}', 'a')], tileSize: 256, attribution, maxzoom };
}

function activitiesGeoJSON() {
  const kinds = shownKinds();
  return {
    type: 'FeatureCollection',
    features: allActivities.filter(a => a.pts && a.pts.length > 3 && kinds.includes(a.kind) && inWin(a.date)).map(a => {
      const coords = [];
      for (let i = 0; i < a.pts.length; i += 2) coords.push([a.pts[i + 1], a.pts[i]]);
      return { type: 'Feature', properties: { kind: a.kind, id: a.id, name: a.name || a.sport, date: day(a.date) }, geometry: { type: 'LineString', coordinates: coords } };
    })
  };
}

function climbsGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: allClimbs.map(c => ({ type: 'Feature', properties: { name: c.name, done: climbDone(c) ? 1 : 0, ele: c.ele || 0, times: c.times },
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] } }))
  };
}

async function open3D() {
  try { await loadMaplibre(); } catch (e) { return toast(e.message, 'error'); }
  const box = document.getElementById('map3d');
  box.hidden = false;
  await new Promise(r => requestAnimationFrame(r));  // laid out before MapLibre measures it
  const c = map.getCenter(), z = Math.max(0, map.getZoom() - 1);  // MapLibre's tiles are twice Leaflet's
  const grey = /^grey/.test(prefs.basemap);
  if (map3d) {  // again: the same view, with what is shown now
    map3d.getSource('activities').setData(activitiesGeoJSON());
    map3d.getSource('climbs').setData(climbsGeoJSON());
    map3d.jumpTo({ center: [c.lng, c.lat], zoom: z });
    map3d.resize();
    return;
  }
  const st = lineStyle(), colour = k => getCSSVar('--' + k);
  map3d = new maplibregl.Map({
    container: 'map3d-canvas',
    center: [c.lng, c.lat], zoom: z, pitch: z > 7 ? 60 : 0, maxPitch: 80,
    style: {
      version: 8,
      projection: { type: 'globe' },
      sources: {
        base: baseSource(),
        dem: { type: 'raster-dem', tiles: [DEM_TILES], tileSize: 256, encoding: 'terrarium', maxzoom: 15,
          attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>' },
        activities: { type: 'geojson', data: activitiesGeoJSON() },
        climbs: { type: 'geojson', data: climbsGeoJSON() }
      },
      layers: [
        { id: 'base', type: 'raster', source: 'base', paint: grey ? { 'raster-saturation': -1, 'raster-contrast': -0.15 } : {} },
        { id: 'hills', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.35 } },
        { id: 'activities', type: 'line', source: 'activities', layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': ['match', ['get', 'kind'], 'ride', colour('ride'), 'run', colour('run'), 'walk', colour('walk'), colour('sport')],
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1 * st.w, 12, 2.5 * st.w, 16, 4 * st.w], 'line-opacity': Math.min(1, 0.85 * st.o) } },
        { id: 'climbs', type: 'circle', source: 'climbs',
          paint: { 'circle-radius': ['case', ['==', ['get', 'done'], 1], 6 * st.r, 4 * st.r],
            'circle-color': ['case', ['==', ['get', 'done'], 1], colour('climb'), 'rgba(0,0,0,0)'],
            'circle-stroke-color': ['case', ['==', ['get', 'done'], 1], '#ffffff', colour('climb')], 'circle-stroke-width': 1.5 } }
      ],
      terrain: { source: 'dem', exaggeration: 1.4 },
      sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.4, 9, 0] }
    }
  });
  map3d.once('load', () => map3d.resize());  // drawn at its full size once the page has laid it out
  map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map3d.addControl(new maplibregl.TerrainControl({ source: 'dem', exaggeration: 1.4 }), 'bottom-right');
  const popup = (e, html) => new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(html).addTo(map3d);
  map3d.on('click', 'climbs', e => {
    const p = e.features[0].properties;
    popup(e, `<b>⛰️ ${escapeHTML(p.name)}</b>${p.ele ? ` · ${fmtHeight(p.ele)}` : ''}<br><small>${p.done ? `climbed ${p.times} time${p.times !== 1 ? 's' : ''}` : 'not climbed yet'}</small>`);
  });
  map3d.on('click', 'activities', e => {
    const p = e.features[0].properties;
    popup(e, `<b>${escapeHTML(p.name)}</b><br><small>${fmtDate(p.date)}</small>`);
  });
  ['climbs', 'activities'].forEach(l => {
    map3d.on('mouseenter', l, () => { map3d.getCanvas().style.cursor = 'pointer'; });
    map3d.on('mouseleave', l, () => { map3d.getCanvas().style.cursor = ''; });
  });
}

function close3D() {
  document.getElementById('map3d').hidden = true;
  if (map3d) {
    const c = map3d.getCenter();
    map.setView([c.lat, c.lng], Math.round(map3d.getZoom() + 1));
  }
  setTimeout(() => map.invalidateSize(), 50);
}

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
