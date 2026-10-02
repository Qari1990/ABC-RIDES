const express = require('express');
const { requireUser } = require('../auth');
const { HttpError, bad, str, int, isoDate } = require('../errors');
const { publicUser } = require('./users');
const { getSettings } = require('../settings');
const { requirePhone } = require('../policy');
const { canonicalCity, CITY_CENTRES, haversineKm } = require('../geo');
const { findSegment } = require('../fares');
const { notify, when } = require('../notify');

// "I need a ride" posts. Drivers browse them, and passengers are notified
// when a matching ride is offered (see POST /rides).
module.exports = function requestsRouter(db) {
  const router = express.Router();

  const placeById = (id) => (id ? db.prepare('SELECT id, city, name, lat, lon FROM places WHERE id = ?').get(id) || null : null);
  const shape = (r) => ({
    ...r,
    from_place: placeById(r.from_place_id),
    to_place: placeById(r.to_place_id),
    home_pickup: r.home_pickup ? JSON.parse(r.home_pickup) : null,
    home_drop: r.home_drop ? JSON.parse(r.home_drop) : null,
    passenger: publicUser(db, db.prepare('SELECT * FROM users WHERE id = ?').get(r.passenger_id)),
  });

  // Optional home pickup/drop: { lat, lon, address } near the city (within 40 km
  // of its centre, or of the chosen point for cities we have no centre for).
  const homeIn = (h, city, placeId, label) => {
    if (!h) return null;
    const lat = Number(h.lat);
    const lon = Number(h.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw bad(`Choose your ${label} location on the map`);
    const place = placeId ? db.prepare('SELECT lat, lon FROM places WHERE id = ?').get(placeId) : null;
    const centre = CITY_CENTRES[city] || (place && [place.lat, place.lon]);
    if (centre && haversineKm([lat, lon], centre) > 40) throw bad(`Your ${label} location must be in or near ${city}`);
    const address = str(h.address, `${label} address`, { max: 200 });
    return JSON.stringify({ lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)), address: address || '' });
  };

  // An optional pickup or drop-off point, which must be a listed point in that city.
  const pointIn = (id, city, label) => {
    if (id === undefined || id === null || id === '') return null;
    const place = db.prepare('SELECT * FROM places WHERE id = ? AND active = 1').get(Number(id));
    if (!place) throw bad(`${label} point not found`);
    if (place.city.toLowerCase() !== city.toLowerCase()) throw bad(`${label} point must be in ${city}`);
    return place.id;
  };

  router.get('/ride-requests', (req, res) => {
    const where = [`status = 'open'`, 'latest_at > ?'];
    const params = [new Date().toISOString()];
    if (req.query.from) { where.push('from_city = ? COLLATE NOCASE'); params.push(String(req.query.from).trim()); }
    if (req.query.to) { where.push('to_city = ? COLLATE NOCASE'); params.push(String(req.query.to).trim()); }
    const rows = db.prepare(`SELECT * FROM ride_requests WHERE ${where.join(' AND ')} ORDER BY earliest_at LIMIT 100`).all(...params);
    res.json(rows.map(shape));
  });

  router.post('/ride-requests', requireUser, (req, res) => {
    requirePhone(getSettings(db), req.user);
    const b = req.body || {};
    const fromRaw = str(b.from_city, 'From city', { required: true, max: 60 });
    const toRaw = str(b.to_city, 'To city', { required: true, max: 60 });
    const from = canonicalCity(fromRaw) || fromRaw;
    const to = canonicalCity(toRaw) || toRaw;
    if (from.toLowerCase() === to.toLowerCase()) throw bad('From and To cities must be different');
    const earliest = isoDate(b.earliest_at, 'Earliest time');
    const latest = isoDate(b.latest_at, 'Latest time');
    if (latest <= earliest) throw bad('Latest time must be after the earliest time');
    if (latest <= new Date()) throw bad('Travel time must be in the future');
    const open = db.prepare(`SELECT COUNT(*) n FROM ride_requests WHERE passenger_id = ? AND status = 'open' AND latest_at > ?`)
      .get(req.user.id, new Date().toISOString()).n;
    if (open >= 10) throw bad('You can have at most 10 open ride requests');
    const fromPlace = pointIn(b.from_place_id, from, 'Pickup');
    const toPlace = pointIn(b.to_place_id, to, 'Drop-off');
    const homePickup = homeIn(b.home_pickup, from, fromPlace, 'home pickup');
    const homeDrop = homeIn(b.home_drop, to, toPlace, 'home drop-off');

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO ride_requests (passenger_id, from_city, to_city, earliest_at, latest_at, seats, max_price, notes, from_place_id, to_place_id, home_pickup, home_drop)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.user.id, from, to, earliest.toISOString(), latest.toISOString(),
      int(b.seats, 'Seats', { min: 1, max: 8, fallback: 1 }),
      int(b.max_price, 'Max price', { min: 0, max: 100000, fallback: null }),
      str(b.notes, 'Notes', { max: 300 }),
      fromPlace, toPlace, homePickup, homeDrop,
    );
    const row = db.prepare('SELECT * FROM ride_requests WHERE id = ?').get(lastInsertRowid);
    const notified = alertDrivers(row, req.user);
    res.status(201).json({ ...shape(row), drivers_notified: notified });
  });

  // Tells drivers about a new request: those who drive this route (rides in
  // the last 90 days or upcoming, passing through both cities in order), or
  // every approved driver when nobody drives it yet. Admins hear about every
  // request if the admin setting says so. Returns how many drivers were told.
  function alertDrivers(r, passenger) {
    const since = new Date(Date.now() - 90 * 864e5).toISOString();
    const rides = db.prepare(`SELECT * FROM rides WHERE driver_id != ? AND status != 'cancelled' AND departure_at > ?`).all(passenger.id, since);
    const drivers = new Set(rides.filter((ride) => findSegment(ride, r.from_city, r.to_city)).map((ride) => ride.driver_id));
    if (!drivers.size) {
      for (const d of db.prepare(`SELECT id FROM users WHERE driver_status = 'approved' AND suspended = 0 AND id != ? LIMIT 300`).all(passenger.id)) drivers.add(d.id);
    }
    const recipients = new Set(drivers);
    if (getSettings(db).notify_admins_of_requests) {
      for (const a of db.prepare(`SELECT id FROM users WHERE role = 'admin' AND id != ?`).all(passenger.id)) recipients.add(a.id);
    }
    const place = (id) => (id ? db.prepare('SELECT name FROM places WHERE id = ?').get(id) : null);
    const from = place(r.from_place_id);
    const homes = [r.home_pickup && 'home pickup', r.home_drop && 'home drop-off'].filter(Boolean);
    const body = [
      `${passenger.name} · ${r.seats} seat${r.seats > 1 ? 's' : ''} · ${when(r.earliest_at)}`,
      from ? `from ${from.name}` : null,
      r.max_price ? `up to Rs ${r.max_price}/seat` : null,
      homes.length ? `wants ${homes.join(' & ')}` : null,
    ].filter(Boolean).join(' · ');
    const link = `/requests?${new URLSearchParams({ from: r.from_city, to: r.to_city })}`;
    for (const id of recipients) notify(db, id, `New ride request: ${r.from_city} → ${r.to_city}`, body, link);
    return drivers.size;
  }

  router.get('/me/ride-requests', requireUser, (req, res) => {
    const rows = db.prepare('SELECT * FROM ride_requests WHERE passenger_id = ? ORDER BY earliest_at DESC LIMIT 100').all(req.user.id);
    res.json(rows.map(shape));
  });

  router.post('/ride-requests/:id/close', requireUser, (req, res) => {
    const row = db.prepare('SELECT * FROM ride_requests WHERE id = ?').get(Number(req.params.id));
    if (!row) throw new HttpError(404, 'Request not found');
    if (row.passenger_id !== req.user.id) throw new HttpError(403, 'This is not your request');
    db.prepare(`UPDATE ride_requests SET status = 'closed' WHERE id = ?`).run(row.id);
    res.json(shape(db.prepare('SELECT * FROM ride_requests WHERE id = ?').get(row.id)));
  });

  return router;
};
