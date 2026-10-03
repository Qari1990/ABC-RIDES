// Live trip tracking. While a trip is on, the driver's and passengers' phones
// can share their location; everyone on the trip sees the car on the map, and
// a link lets family follow it without an account. Locations are only kept
// for the trip and deleted when it ends (see lifecycle.js).
const express = require('express');
const crypto = require('node:crypto');
const { requireUser } = require('../auth');
const { HttpError, bad } = require('../errors');
const { notify, route } = require('../notify');
const { rateLimiter } = require('../security');

const BEFORE_MS = 2 * 36e5; // sharing opens 2 hours before departure
const AFTER_MS = 8 * 36e5; // and closes 8 hours after the expected arrival
const FRESH_MS = 15 * 60e3; // older positions are not shown
const DEFAULT_TRIP_MINUTES = 4 * 60;

const firstName = (name) => String(name || '').split(' ')[0];

function tripWindow(ride) {
  const start = new Date(ride.departure_at).getTime() - BEFORE_MS;
  const end = new Date(ride.departure_at).getTime() + (ride.duration_minutes || DEFAULT_TRIP_MINUTES) * 60000 + AFTER_MS;
  return { start, end };
}

module.exports = function trackingRouter(db) {
  const router = express.Router();
  const publicLimit = rateLimiter({ windowMs: 60e3, max: 30, message: 'Too many requests, please wait a moment' });

  const getRide = (id) => {
    const ride = db.prepare('SELECT * FROM rides WHERE id = ?').get(Number(id));
    if (!ride) throw new HttpError(404, 'Ride not found');
    return ride;
  };
  // The driver and confirmed passengers are on the trip.
  const roleOf = (ride, userId) => {
    if (ride.driver_id === userId) return 'driver';
    const b = db.prepare(`SELECT 1 FROM bookings WHERE ride_id = ? AND passenger_id = ? AND status = 'confirmed'`).get(ride.id, userId);
    return b ? 'passenger' : null;
  };
  const onTrip = (ride, user) => {
    const role = roleOf(ride, user.id);
    if (!role) throw new HttpError(403, 'Only the driver and confirmed passengers can do this');
    return role;
  };
  // Fresh positions, the driver's first.
  const positions = (rideId) => db.prepare(`
    SELECT l.user_id, u.name, l.lat, l.lon, l.accuracy, l.at, CASE WHEN r.driver_id = l.user_id THEN 'driver' ELSE 'passenger' END AS role
    FROM ride_locations l JOIN users u ON u.id = l.user_id JOIN rides r ON r.id = l.ride_id
    WHERE l.ride_id = ? AND l.at > ? ORDER BY role = 'driver' DESC, l.at DESC`)
    .all(rideId, new Date(Date.now() - FRESH_MS).toISOString())
    .map((p) => ({ ...p, name: firstName(p.name) }));

  router.post('/rides/:id/location', requireUser, (req, res) => {
    const ride = getRide(req.params.id);
    const role = onTrip(ride, req.user);
    if (ride.status !== 'scheduled') throw bad('This trip has ended, so location sharing has stopped');
    const { start, end } = tripWindow(ride);
    if (Date.now() < start) throw bad('Live location opens 2 hours before departure');
    if (Date.now() > end) throw bad('This trip has ended, so location sharing has stopped');
    const b = req.body || {};
    const lat = Number(b.lat);
    const lon = Number(b.lon);
    // Pakistan and a margin around it.
    if (!(lat >= 22 && lat <= 38 && lon >= 59 && lon <= 79)) throw bad('That location is outside Pakistan');
    const accuracy = Number.isFinite(Number(b.accuracy)) ? Math.round(Number(b.accuracy)) : null;
    const first = !db.prepare('SELECT 1 FROM ride_locations WHERE ride_id = ? AND user_id = ?').get(ride.id, req.user.id);
    db.prepare(`INSERT INTO ride_locations (ride_id, user_id, lat, lon, accuracy, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ride_id, user_id) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, accuracy = excluded.accuracy, at = excluded.at`)
      .run(ride.id, req.user.id, lat, lon, accuracy, new Date().toISOString());
    // The first time the driver shares, passengers hear that they can follow the car.
    if (first && role === 'driver') {
      for (const p of db.prepare(`SELECT passenger_id FROM bookings WHERE ride_id = ? AND status = 'confirmed'`).all(ride.id)) {
        notify(db, p.passenger_id, `${firstName(req.user.name)} is sharing the car’s live location`, `${route(ride)}: see the car on the map.`, `/ride/${ride.id}`);
      }
    }
    res.json({ ok: true });
  });

  router.delete('/rides/:id/location', requireUser, (req, res) => {
    const ride = getRide(req.params.id);
    db.prepare('DELETE FROM ride_locations WHERE ride_id = ? AND user_id = ?').run(ride.id, req.user.id);
    res.status(204).end();
  });

  router.get('/rides/:id/live', requireUser, (req, res) => {
    const ride = getRide(req.params.id);
    onTrip(ride, req.user);
    res.json({ locations: positions(ride.id) });
  });

  // A link for family: the same one each time for this person and trip.
  router.post('/rides/:id/track-link', requireUser, (req, res) => {
    const ride = getRide(req.params.id);
    onTrip(ride, req.user);
    if (ride.status !== 'scheduled') throw bad('This trip has ended');
    let row = db.prepare('SELECT token FROM track_links WHERE ride_id = ? AND user_id = ?').get(ride.id, req.user.id);
    if (!row) {
      row = { token: crypto.randomBytes(18).toString('base64url') };
      db.prepare('INSERT INTO track_links (token, ride_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(row.token, ride.id, req.user.id, new Date().toISOString());
    }
    res.json({ token: row.token, path: `/track/${row.token}` });
  });

  // What family sees: the route, the car and where it is now. No phone numbers.
  router.get('/track/:token', (req, res) => {
    publicLimit.check(req.ip);
    publicLimit.hit(req.ip);
    const link = db.prepare('SELECT * FROM track_links WHERE token = ?').get(String(req.params.token));
    if (!link) throw new HttpError(404, 'This tracking link is not valid');
    const ride = getRide(link.ride_id);
    const { end } = tripWindow(ride);
    if (ride.status === 'cancelled' || Date.now() > end) throw new HttpError(410, 'This trip has ended');
    const driver = db.prepare('SELECT name FROM users WHERE id = ?').get(ride.driver_id);
    const sharer = db.prepare('SELECT name FROM users WHERE id = ?').get(link.user_id);
    const temp = ride.temp_vehicle ? JSON.parse(ride.temp_vehicle) : null;
    const plate = temp ? temp.plate : (db.prepare('SELECT plate FROM vehicles WHERE user_id = ?').get(ride.driver_id) || {}).plate;
    const stops = ride.stops ? JSON.parse(ride.stops).map(({ city, name, lat, lon, km }) => ({ city, name, lat, lon, km })) : [];
    res.set('cache-control', 'no-store');
    res.json({
      shared_by: firstName(sharer && sharer.name),
      driver: firstName(driver && driver.name),
      from_city: ride.from_city,
      to_city: ride.to_city,
      departure_at: ride.departure_at,
      arrival_at: ride.duration_minutes ? new Date(new Date(ride.departure_at).getTime() + ride.duration_minutes * 60000).toISOString() : null,
      vehicle: ride.vehicle,
      plate: plate || null,
      status: ride.status === 'completed' ? 'completed' : 'on_the_way',
      stops,
      locations: ride.status === 'completed' ? [] : positions(ride.id).map(({ role, name, lat, lon, accuracy, at }) => ({ role, name, lat, lon, accuracy, at })),
    });
  });

  return router;
};

module.exports.tripWindow = tripWindow;
