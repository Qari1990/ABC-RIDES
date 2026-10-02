const express = require('express');
const { requireAdmin } = require('../auth');
const { rateLimiter } = require('../security');
const { HttpError, bad, str } = require('../errors');
const { CITIES, canonicalCity, placeKm, suggestStops, minutesFor, refreshFromOsrm, roadShape } = require('../geo');

function coord(value, field, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${field} must be a number between ${min} and ${max}`);
  return Math.round(n * 1e5) / 1e5;
}

module.exports = function placesRouter(db) {
  const router = express.Router();
  const activePlaces = () => db.prepare('SELECT id, city, name, lat, lon FROM places WHERE active = 1 ORDER BY city, id').all();
  const getPlace = (id) => db.prepare('SELECT id, city, name, lat, lon FROM places WHERE id = ? AND active = 1').get(Number(id));

  // Popular pickup/drop-off points, optionally for one city.
  router.get('/places', (req, res) => {
    const city = req.query.city ? canonicalCity(req.query.city) || String(req.query.city) : null;
    res.json(city ? activePlaces().filter((p) => p.city.toLowerCase() === city.toLowerCase()) : activePlaces());
  });

  // Distances along a list of places, plus stops the route passes near.
  //   GET /route-plan?stops=12,40   (place ids in travel order)
  router.get('/route-plan', (req, res) => {
    const ids = String(req.query.stops || '').split(',').filter(Boolean);
    if (ids.length < 2) throw bad('Choose a pickup and a drop-off point');
    const stops = ids.map((id) => getPlace(id) || (() => { throw new HttpError(404, 'Place not found'); })());
    let km = 0;
    const withKm = stops.map((p, i) => {
      if (i) km += placeKm(db, stops[i - 1], p);
      return { ...p, km };
    });
    const chosen = new Set(stops.map((p) => p.id));
    res.json({
      stops: withKm,
      distance_km: km,
      duration_minutes: minutesFor(km),
      suggested_stops: suggestStops(db, stops[0], stops[stops.length - 1], activePlaces().filter((p) => !chosen.has(p.id)))
        .map(({ id, city, name, lat, lon, km: along }) => ({ id, city, name, lat, lon, km: along })),
    });
  });

  // Road shapes for drawing a route on a map, one leg per pair of stops.
  //   GET /route-shape?points=lat,lon;lat,lon;...   (2 to 12 points)
  // → { legs: [[[lat, lon], ...] or null, ...] }  (null: draw a straight line)
  const shapeLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 120, message: 'Too many map requests, please wait a moment' });
  router.get('/route-shape', async (req, res) => {
    shapeLimit.check(req.ip);
    shapeLimit.hit(req.ip);
    const pts = String(req.query.points || '').split(';').filter(Boolean).map((p) => p.split(',').map(Number));
    const valid = pts.length >= 2 && pts.length <= 12
      && pts.every(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180);
    if (!valid) throw bad('Give 2 to 12 points as lat,lon;lat,lon');
    const legs = [];
    for (let i = 1; i < pts.length; i += 1) {
      legs.push(await roadShape(db, { lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] }));
    }
    res.set('cache-control', 'public, max-age=86400');
    res.json({ legs });
  });

  // ---- Admin: manage places and distances ----------------------------------

  const admin = express.Router();
  admin.use(requireAdmin);

  admin.post('/places', (req, res) => {
    const b = req.body || {};
    const city = canonicalCity(b.city);
    if (!city) throw bad(`City must be one of: ${CITIES.join(', ')}`);
    const name = str(b.name, 'Name', { required: true, max: 60 });
    const lat = coord(b.lat, 'Latitude', 23, 37.5); // Pakistan's bounding box
    const lon = coord(b.lon, 'Longitude', 60, 78);
    if (db.prepare('SELECT 1 FROM places WHERE city = ? AND name = ? AND active = 1').get(city, name)) {
      throw new HttpError(409, 'A place with this name already exists in this city');
    }
    const { lastInsertRowid } = db.prepare(`INSERT INTO places (city, name, lat, lon) VALUES (?, ?, ?, ?)
      ON CONFLICT(city, name) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, active = 1`).run(city, name, lat, lon);
    res.status(201).json(db.prepare('SELECT * FROM places WHERE city = ? AND name = ?').get(city, name) || { id: Number(lastInsertRowid) });
  });

  admin.patch('/places/:id', (req, res) => {
    const place = getPlace(req.params.id);
    if (!place) throw new HttpError(404, 'Place not found');
    const b = req.body || {};
    const name = b.name !== undefined ? str(b.name, 'Name', { required: true, max: 60 }) : place.name;
    const lat = b.lat !== undefined ? coord(b.lat, 'Latitude', 23, 37.5) : place.lat;
    const lon = b.lon !== undefined ? coord(b.lon, 'Longitude', 60, 78) : place.lon;
    db.prepare('UPDATE places SET name = ?, lat = ?, lon = ? WHERE id = ?').run(name, lat, lon, place.id);
    res.json(getPlace(place.id));
  });

  // Hidden rather than deleted: existing rides keep their copy of the stop.
  admin.delete('/places/:id', (req, res) => {
    if (!getPlace(req.params.id)) throw new HttpError(404, 'Place not found');
    db.prepare('UPDATE places SET active = 0 WHERE id = ?').run(Number(req.params.id));
    res.status(204).end();
  });

  admin.get('/distances', (_req, res) => {
    res.json(db.prepare('SELECT * FROM route_distances ORDER BY pair').all());
  });

  admin.post('/distances/refresh', async (_req, res) => {
    try {
      const count = await refreshFromOsrm(db);
      res.json({ updated: count });
    } catch (err) {
      throw new HttpError(502, `Could not reach the map routing service: ${err.message}`);
    }
  });

  router.use('/admin', admin);
  return router;
};
