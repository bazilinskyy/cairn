'use strict';
// Past the date line: Leaflet draws a layer once, at its own longitudes, so the copy of the world beside it (the
// Americas east of a map centred on the Pacific) stays empty. Each marker, line and area is moved here, whole, to the
// copy nearest the view's middle (360° on), when it is added and after each move; a group of photos or airports
// (marker clusters) is filled again with its markers so moved.

function wrapWorld(map) {
  const shiftOf = (lng, mid) => 360 * Math.round((mid - lng) / 360);
  const deep = (lls, f) => Array.isArray(lls) ? lls.map(x => deep(x, f)) : f(lls);
  const flat = lls => Array.isArray(lls) ? lls.flatMap(flat) : [lls];
  const mid = () => map.getCenter().lng;

  function place(layer, c) {
    if (layer instanceof L.MarkerCluster || layer.__parent || layer instanceof L.GridLayer) return;  // a cluster's own: moved with it
    if (L.MarkerClusterGroup && layer instanceof L.MarkerClusterGroup) return placeGroup(layer, c);
    if (layer.getLatLng && layer.setLatLng) {
      if (!layer._wrapBase) layer._wrapBase = layer.getLatLng(), layer._wrapShift = 0;
      const s = shiftOf(layer._wrapBase.lng, c);
      if (s !== layer._wrapShift) layer._wrapShift = s, layer.setLatLng([layer._wrapBase.lat, layer._wrapBase.lng + s]);
    } else if (layer.getLatLngs && layer.setLatLngs) {
      if (!layer._wrapBase) {
        const all = flat(layer.getLatLngs());
        if (!all.length) return;
        layer._wrapBase = layer.getLatLngs();
        layer._wrapRef = (Math.min(...all.map(p => p.lng)) + Math.max(...all.map(p => p.lng))) / 2;
        layer._wrapShift = 0;
      }
      const s = shiftOf(layer._wrapRef, c);
      if (s !== layer._wrapShift) layer._wrapShift = s, layer.setLatLngs(deep(layer._wrapBase, p => L.latLng(p.lat, p.lng + s)));
    }
  }
  // a cluster group: its markers taken out and put back in, each at its nearest copy (only when one of them moves)
  function placeGroup(group, c) {
    const markers = group.getLayers();
    markers.forEach(m => { if (!m._wrapBase) m._wrapBase = m.getLatLng(), m._wrapShift = 0; });
    if (markers.every(m => shiftOf(m._wrapBase.lng, c) === m._wrapShift)) return;
    group.clearLayers();  // first: a marker moved inside the group is re-clustered one at a time
    for (const m of markers) {
      const s = shiftOf(m._wrapBase.lng, c);
      if (s !== m._wrapShift) m._wrapShift = s, m.setLatLng([m._wrapBase.lat, m._wrapBase.lng + s]);
    }
    group.addLayers(markers);
  }

  map.on('layeradd', e => place(e.layer, mid()));
  map.on('moveend', () => { const c = mid(); map.eachLayer(l => place(l, c)); });
}
