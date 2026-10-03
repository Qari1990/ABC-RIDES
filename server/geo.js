// Distances between cities and places.
//
// Road distances between city centres come from, in order of preference:
//   1. the route_distances table, filled from a map routing service
//      (OSRM) by the admin's "Update distances from maps" button;
//   2. a built-in table of well-known routes (approximate);
//   3. the straight-line distance stretched by a road factor.
// Distances between two places scale the city-to-city road distance by how
// far apart the places are compared with the city centres.

const CITY_CENTRES = {
  Abbottabad: [34.15, 73.22],
  Bahawalpur: [29.40, 71.68],
  Faisalabad: [31.42, 73.08],
  Gujranwala: [32.16, 74.19],
  Gujrat: [32.57, 74.08],
  Hyderabad: [25.40, 68.37],
  Islamabad: [33.68, 73.05],
  Jhelum: [32.94, 73.73],
  Karachi: [24.86, 67.01],
  Lahore: [31.55, 74.34],
  Mardan: [34.20, 72.04],
  Multan: [30.20, 71.47],
  Murree: [33.91, 73.39],
  Peshawar: [34.01, 71.58],
  Quetta: [30.18, 66.98],
  'Rahim Yar Khan': [28.42, 70.30],
  Rawalpindi: [33.60, 73.04],
  Sahiwal: [30.66, 73.11],
  Sargodha: [32.08, 72.67],
  Sialkot: [32.49, 74.53],
  Sukkur: [27.71, 68.86],
  Attock: [33.77, 72.36],
  Chakwal: [32.93, 72.86],
  Chiniot: [31.72, 72.98],
  'Dera Ghazi Khan': [30.06, 70.63],
  'Dera Ismail Khan': [31.83, 70.90],
  Gilgit: [35.92, 74.31],
  Hafizabad: [32.07, 73.69],
  Haripur: [33.99, 72.93],
  Jhang: [31.27, 72.32],
  Kasur: [31.12, 74.45],
  Khanewal: [30.30, 71.93],
  Kohat: [33.59, 71.44],
  Larkana: [27.56, 68.23],
  'Mandi Bahauddin': [32.59, 73.49],
  Mansehra: [34.33, 73.20],
  Mianwali: [32.58, 71.54],
  'Mirpur (AJK)': [33.15, 73.75],
  'Mirpur Khas': [25.53, 69.01],
  Muzaffarabad: [34.37, 73.47],
  Nawabshah: [26.24, 68.41],
  Nowshera: [34.02, 71.97],
  Okara: [30.81, 73.45],
  Sheikhupura: [31.71, 73.98],
  Skardu: [35.30, 75.63],
  'Swat (Mingora)': [34.77, 72.36],
  Taxila: [33.75, 72.84],
  'Wah Cantt': [33.80, 72.73],
};
const CITIES = Object.keys(CITY_CENTRES);

// Approximate road distances (km) of common routes, mostly by motorway.
const KNOWN_ROAD_KM = {
  'Islamabad|Lahore': 375,
  'Lahore|Rawalpindi': 380,
  'Faisalabad|Lahore': 185,
  'Faisalabad|Sahiwal': 120,
  'Lahore|Multan': 340,
  'Gujranwala|Lahore': 70,
  'Lahore|Sialkot': 130,
  'Lahore|Sahiwal': 170,
  'Gujrat|Lahore': 120,
  'Islamabad|Peshawar': 185,
  'Peshawar|Rawalpindi': 175,
  'Abbottabad|Islamabad': 120,
  'Islamabad|Murree': 60,
  'Islamabad|Jhelum': 120,
  'Islamabad|Rawalpindi': 15,
  'Hyderabad|Karachi': 165,
  'Karachi|Sukkur': 470,
  'Hyderabad|Sukkur': 320,
  'Bahawalpur|Multan': 100,
  'Faisalabad|Multan': 240,
  'Multan|Sukkur': 400,
  'Faisalabad|Islamabad': 300,
  // Mountain roads are much longer than the straight line suggests.
  'Gilgit|Islamabad': 600,
  'Gilgit|Rawalpindi': 610,
  'Islamabad|Skardu': 770,
  'Gilgit|Skardu': 210,
  'Islamabad|Muzaffarabad': 135,
  'Islamabad|Swat (Mingora)': 250,
  'Islamabad|Mansehra': 160,
  'Islamabad|Mirpur (AJK)': 130,
  'Lahore|Okara': 110,
  'Lahore|Sheikhupura': 40,
  'Kasur|Lahore': 55,
};

const ROAD_FACTOR = 1.3; // straight line → road, used when nothing better is known
const AVG_KMH = 85;

const pairKey = (a, b) => [a, b].sort().join('|');

function canonicalCity(name) {
  return CITIES.find((c) => c.toLowerCase() === String(name || '').trim().toLowerCase()) || null;
}

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Road km between two city centres; db (optional) supplies map-based distances.
function cityRoadKm(db, a, b) {
  const ca = canonicalCity(a);
  const cb = canonicalCity(b);
  if (!ca || !cb) return null;
  if (ca === cb) return 0;
  const key = pairKey(ca, cb);
  if (db) {
    const row = db.prepare('SELECT km FROM route_distances WHERE pair = ?').get(key);
    if (row) return row.km;
  }
  return KNOWN_ROAD_KM[key] ?? Math.round(haversineKm(CITY_CENTRES[ca], CITY_CENTRES[cb]) * ROAD_FACTOR);
}

// Road km between two places ({city, lat, lon}).
function placeKm(db, p, q) {
  const straight = haversineKm([p.lat, p.lon], [q.lat, q.lon]);
  const cp = canonicalCity(p.city);
  const cq = canonicalCity(q.city);
  if (!cp || !cq || cp === cq) return Math.max(1, Math.round(straight * ROAD_FACTOR));
  const centres = haversineKm(CITY_CENTRES[cp], CITY_CENTRES[cq]);
  const scale = Math.min(1.3, Math.max(0.7, straight / centres));
  return Math.round(cityRoadKm(db, cp, cq) * scale);
}

function minutesFor(km) {
  return Math.max(30, Math.round((km / AVG_KMH) * 4) * 15);
}

function estimateRoute(db, from, to) {
  const km = cityRoadKm(db, from, to);
  if (!km) return null;
  return { distance_km: km, duration_minutes: minutesFor(km) };
}

// Stops (places) the route passes near: places whose detour is small, ordered
// along the way. Used to suggest intermediate stops to drivers.
function suggestStops(db, start, end, places, { maxDetour = 1.1, limit = 6 } = {}) {
  const direct = placeKm(db, start, end);
  return places
    .filter((p) => p.city !== start.city && p.city !== end.city)
    .map((p) => {
      const fromStart = placeKm(db, start, p);
      const toEnd = placeKm(db, p, end);
      return { ...p, km: fromStart, toEnd, detour: (fromStart + toEnd) / direct };
    })
    // Between the two ends, and not much of a detour; the closest few, in travel order.
    .filter((p) => p.detour <= maxDetour && p.km < direct && p.toEnd < direct)
    .sort((a, b) => a.detour - b.detour)
    .slice(0, limit)
    .sort((a, b) => a.km - b.km);
}

// Fills route_distances with real road distances between city centres from an
// OSRM server (its "table" service returns the whole matrix in one request).
async function refreshFromOsrm(db, baseUrl = process.env.ROUTING_URL || 'https://router.project-osrm.org') {
  const coords = CITIES.map((c) => `${CITY_CENTRES[c][1]},${CITY_CENTRES[c][0]}`).join(';');
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/table/v1/driving/${coords}?annotations=distance`, {
    headers: { 'user-agent': 'ABC-Rides/1.0' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Routing service answered ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !Array.isArray(data.distances)) throw new Error('Routing service returned no distances');
  const upsert = db.prepare(`INSERT INTO route_distances (pair, km, source, updated_at) VALUES (?, ?, 'osrm', ?)
    ON CONFLICT(pair) DO UPDATE SET km = excluded.km, source = excluded.source, updated_at = excluded.updated_at`);
  const now = new Date().toISOString();
  let count = 0;
  CITIES.forEach((a, i) => CITIES.forEach((b, j) => {
    const metres = data.distances[i][j];
    if (j > i && metres) {
      // Average both directions where available (one-way systems differ slightly).
      const back = data.distances[j][i] || metres;
      upsert.run(pairKey(a, b), Math.round((metres + back) / 2000), now);
      count += 1;
    }
  }));
  return count;
}

// The road between two points as [[lat, lon], ...], from the routing service
// (OSRM's free public server by default), cached forever in route_shapes.
// Returns null when the service can't be reached; maps then draw a straight line.
const SHAPE_FAILURES = new Map(); // pair → time of last failure, to avoid hammering
async function roadShape(db, a, b, baseUrl = process.env.ROUTING_URL || 'https://router.project-osrm.org') {
  const r4 = (n) => Number(n).toFixed(4);
  const pair = `${r4(a.lat)},${r4(a.lon)}|${r4(b.lat)},${r4(b.lon)}`;
  const hit = db.prepare('SELECT points FROM route_shapes WHERE pair = ?').get(pair);
  if (hit) return JSON.parse(hit.points);
  if (Date.now() - (SHAPE_FAILURES.get(pair) || 0) < 10 * 60 * 1000) return null;
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/route/v1/driving/${r4(a.lon)},${r4(a.lat)};${r4(b.lon)},${r4(b.lat)}?overview=simplified&geometries=geojson`;
    const res = await fetch(url, { headers: { 'user-agent': 'ABC-Rides/1.0' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Routing service answered ${res.status}`);
    const data = await res.json();
    const coords = data.routes && data.routes[0] && data.routes[0].geometry && data.routes[0].geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) throw new Error('No route found');
    const points = coords.map(([lon, lat]) => [Number(lat.toFixed(5)), Number(lon.toFixed(5))]);
    db.prepare('INSERT OR REPLACE INTO route_shapes (pair, points) VALUES (?, ?)').run(pair, JSON.stringify(points));
    return points;
  } catch {
    SHAPE_FAILURES.set(pair, Date.now());
    return null;
  }
}

module.exports = {
  roadShape,
  CITIES, CITY_CENTRES, canonicalCity, haversineKm, cityRoadKm, placeKm, minutesFor, estimateRoute, suggestStops,
  refreshFromOsrm, ROAD_FACTOR,
};
