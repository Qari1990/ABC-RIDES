'use strict';

// Maps for ABC Rides: Leaflet (served from /vendor/leaflet) with OpenStreetMap
// tiles, or whatever tile server the backend names in settings.map. Leaflet is
// only downloaded the first time a page shows a map.

let leafletLoading = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletLoading) {
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'vendor/leaflet/leaflet.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = 'vendor/leaflet/leaflet.js';
      js.onload = () => resolve(window.L);
      js.onerror = () => {
        leafletLoading = null;
        reject(new Error('The map could not be loaded'));
      };
      document.head.appendChild(js);
    });
  }
  return leafletLoading;
}

const PAKISTAN = [30.4, 69.3];
const googleMaps = (lat, lon) => `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
const directions = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;

/** A map in el (an empty element with a height). Replaces any map already there. */
async function createMap(el, { center = PAKISTAN, zoom = 5 } = {}) {
  const L = await loadLeaflet();
  if (el._abcMap) el._abcMap.remove();
  // No zoom/fade animations: pages re-render often, and an animation still
  // running on a map that was just removed throws errors inside Leaflet.
  const map = L.map(el, { scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView(center, zoom);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  const cfg = (typeof settings === 'object' && settings && settings.map) || {};
  L.tileLayer(cfg.tile_url || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: cfg.attribution || '© OpenStreetMap contributors',
    // Tile servers ask to know which site is using them.
    referrerPolicy: 'strict-origin-when-cross-origin',
  }).addTo(map);
  el._abcMap = map;
  // Maps created while hidden or still laying out need a size check.
  setTimeout(() => { if (el.isConnected && el._abcMap === map) map.invalidateSize({ animate: false }); }, 60);
  return { L, map };
}

function pin(L, label, kind = '') {
  return L.divIcon({ className: '', html: `<span class="map-pin ${kind}">${label}</span>`, iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14] });
}

function placePopup(p, extra = '') {
  return `<b>${esc(p.name)}</b>${p.city ? `, ${esc(p.city)}` : ''}${extra}<br>
    <a href="${googleMaps(p.lat, p.lon)}" target="_blank" rel="noopener">Google Maps</a> ·
    <a href="${directions(p.lat, p.lon)}" target="_blank" rel="noopener">Directions</a>`;
}

/**
 * A ride's stops in order. The part between board and alight (the passenger's
 * trip) is drawn solid; homes are optional home pickup/drop points.
 * Lines follow the roads when the routing service answers, else join the stops directly.
 */
// Road shapes per leg, fetched once per page load for each set of stops.
const shapeCache = new Map();
function roadLegs(stops) {
  const key = stops.map((s) => `${(+s.lat).toFixed(4)},${(+s.lon).toFixed(4)}`).join(';');
  if (!shapeCache.has(key)) {
    shapeCache.set(key, fetch(`/api/route-shape?points=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : { legs: [] }))
      .then((d) => d.legs || [])
      .catch(() => []));
  }
  return shapeCache.get(key);
}

async function routeMap(el, stops, { board = 0, alight = stops.length - 1, homes = [], extra = [], onExtra } = {}) {
  const { L, map } = await createMap(el);
  const pts = stops.map((s) => [s.lat, s.lon]);
  // Straight lines first; replaced by the actual roads once they arrive.
  const lines = L.layerGroup().addTo(map);
  const drawLegs = (legs) => {
    lines.clearLayers();
    for (let i = 1; i < pts.length; i += 1) {
      const road = legs[i - 1];
      const mine = i > board && i <= alight;
      L.polyline(road || [pts[i - 1], pts[i]], mine
        ? { color: '#0b7a5e', weight: 5, opacity: 0.9, dashArray: road ? null : '8 8' }
        : { color: '#94a3b8', weight: 4, opacity: 0.9, dashArray: road ? null : '6 8' }).addTo(lines);
    }
  };
  drawLegs([]);
  if (pts.length >= 2 && pts.length <= 12) {
    roadLegs(stops).then((legs) => { if (el._abcMap === map && legs.some(Boolean)) drawLegs(legs); });
  }
  stops.forEach((s, i) => {
    const kind = i === 0 ? 'start' : i === stops.length - 1 ? 'end' : '';
    const off = i < board || i > alight ? 'off' : '';
    L.marker([s.lat, s.lon], { icon: pin(L, String.fromCharCode(65 + i), `${kind} ${off}`), title: s.name })
      .bindPopup(placePopup(s, s.km !== undefined ? ` · ${s.km} km` : '')).addTo(map);
  });
  // Points that could be added to the route (e.g. suggested stops); tapping one calls onExtra.
  for (const p of extra) {
    L.marker([p.lat, p.lon], { icon: pin(L, '+', 'extra'), title: p.name })
      .on('click', () => onExtra && onExtra(p)).bindTooltip(`Add stop: ${p.name}`).addTo(map);
  }
  for (const h of homes) {
    L.marker([h.lat, h.lon], { icon: pin(L, '⌂', 'home'), title: h.label })
      .bindPopup(placePopup({ name: h.label, lat: h.lat, lon: h.lon })).addTo(map);
    if (h.near) L.polyline([[h.lat, h.lon], [h.near.lat, h.near.lon]], { color: '#f59e0b', weight: 3, dashArray: '4 6' }).addTo(map);
  }
  const all = [...pts, ...homes.map((h) => [h.lat, h.lon]), ...extra.map((p) => [p.lat, p.lon])];
  if (all.length) map.fitBounds(all, { padding: [28, 28], maxZoom: 14, animate: false });
  return map;
}

/**
 * Listed pickup points to choose from. groups: [{ places, selected, onPick }];
 * tapping a point calls its group's onPick(place). Returns a function that
 * redraws with new selections.
 */
async function pointsMap(el, groups, { end = false } = {}) {
  const { L, map } = await createMap(el);
  const layer = L.layerGroup().addTo(map);
  let shown = '';
  const draw = (next) => {
    layer.clearLayers();
    const all = [];
    next.forEach((g, gi) => g.places.forEach((p) => {
      const chosen = String(p.id) === String(g.selected || '');
      all.push([p.lat, p.lon]);
      const last = end || gi > 0;
      L.marker([p.lat, p.lon], { icon: pin(L, chosen ? '✓' : last ? 'B' : 'A', `${chosen ? 'chosen' : 'choice'} ${last ? 'end' : 'start'}`), title: p.name, zIndexOffset: chosen ? 500 : 0 })
        .bindTooltip(`${p.name}${chosen ? ' (chosen)' : ''}`)
        .on('click', () => g.onPick(p))
        .addTo(layer);
    }));
    // Re-fit only when the set of points changes, not when one is chosen.
    const key = all.join(';');
    if (all.length && key !== shown) map.fitBounds(all, { padding: [28, 28], maxZoom: 13, animate: false });
    shown = key;
  };
  draw(groups);
  return draw;
}

/**
 * Tap to choose a spot (e.g. a home address). Shows the allowed radius around
 * a stop; onPick({lat, lon}) is called with the chosen point.
 */
async function locationPicker(el, { around, radiusKm, value, onPick }) {
  const { L, map } = await createMap(el, { center: [around.lat, around.lon], zoom: 13 });
  L.marker([around.lat, around.lon], { icon: pin(L, 'A', 'start'), title: around.name }).bindTooltip(around.name).addTo(map);
  if (radiusKm) {
    const circle = L.circle([around.lat, around.lon], { radius: radiusKm * 1000, color: '#0b7a5e', weight: 1, fillOpacity: 0.06 }).addTo(map);
    map.fitBounds(circle.getBounds(), { padding: [10, 10], animate: false });
  }
  let marker = null;
  const place = (lat, lon) => {
    if (marker) marker.setLatLng([lat, lon]);
    else marker = L.marker([lat, lon], { icon: pin(L, '⌂', 'home') }).addTo(map);
  };
  if (value) place(value.lat, value.lon);
  map.on('click', (e) => {
    const lat = Number(e.latlng.lat.toFixed(5));
    const lon = Number(e.latlng.lng.toFixed(5));
    place(lat, lon);
    onPick({ lat, lon });
  });
  return { set: (v) => { place(v.lat, v.lon); map.panTo([v.lat, v.lon], { animate: false }); } };
}
