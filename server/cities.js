// Cities offered in the pickers, with approximate coordinates used to estimate
// travel time. Searches match case-insensitively, so drivers can still type a
// city that is not listed here (they then enter the travel time themselves).
const COORDS = {
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
};

const CITIES = Object.keys(COORDS);

// Straight-line distance stretched to road distance, at an average intercity
// speed. Rough, so drivers can adjust it.
const ROAD_FACTOR = 1.3;
const AVG_KMH = 80;

function lookup(name) {
  const key = CITIES.find((c) => c.toLowerCase() === String(name || '').trim().toLowerCase());
  return key ? COORDS[key] : null;
}

function estimateRoute(from, to) {
  const a = lookup(from);
  const b = lookup(to);
  if (!a || !b || a === b) return null;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  const straightKm = 2 * 6371 * Math.asin(Math.sqrt(h));
  const roadKm = straightKm * ROAD_FACTOR;
  return {
    distance_km: Math.round(roadKm / 5) * 5,
    // Nearest 15 minutes, at least 30.
    duration_minutes: Math.max(30, Math.round((roadKm / AVG_KMH) * 4) * 15),
  };
}

module.exports = { CITIES, estimateRoute };
