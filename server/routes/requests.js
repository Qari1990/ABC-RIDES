const express = require('express');
const { requireUser } = require('../auth');
const { HttpError, bad, str, int, isoDate } = require('../errors');
const { publicUser } = require('./users');

// "I need a ride" posts. Drivers browse them, and passengers are notified
// when a matching ride is offered (see POST /rides).
module.exports = function requestsRouter(db) {
  const router = express.Router();

  const shape = (r) => ({
    ...r,
    passenger: publicUser(db, db.prepare('SELECT * FROM users WHERE id = ?').get(r.passenger_id)),
  });

  router.get('/ride-requests', (req, res) => {
    const where = [`status = 'open'`, 'latest_at > ?'];
    const params = [new Date().toISOString()];
    if (req.query.from) { where.push('from_city = ? COLLATE NOCASE'); params.push(String(req.query.from).trim()); }
    if (req.query.to) { where.push('to_city = ? COLLATE NOCASE'); params.push(String(req.query.to).trim()); }
    const rows = db.prepare(`SELECT * FROM ride_requests WHERE ${where.join(' AND ')} ORDER BY earliest_at LIMIT 100`).all(...params);
    res.json(rows.map(shape));
  });

  router.post('/ride-requests', requireUser, (req, res) => {
    const b = req.body || {};
    const from = str(b.from_city, 'From city', { required: true, max: 60 });
    const to = str(b.to_city, 'To city', { required: true, max: 60 });
    if (from.toLowerCase() === to.toLowerCase()) throw bad('From and To cities must be different');
    const earliest = isoDate(b.earliest_at, 'Earliest time');
    const latest = isoDate(b.latest_at, 'Latest time');
    if (latest <= earliest) throw bad('Latest time must be after the earliest time');
    if (latest <= new Date()) throw bad('Travel time must be in the future');
    const open = db.prepare(`SELECT COUNT(*) n FROM ride_requests WHERE passenger_id = ? AND status = 'open' AND latest_at > ?`)
      .get(req.user.id, new Date().toISOString()).n;
    if (open >= 10) throw bad('You can have at most 10 open ride requests');

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO ride_requests (passenger_id, from_city, to_city, earliest_at, latest_at, seats, max_price, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.user.id, from, to, earliest.toISOString(), latest.toISOString(),
      int(b.seats, 'Seats', { min: 1, max: 8, fallback: 1 }),
      int(b.max_price, 'Max price', { min: 0, max: 100000, fallback: null }),
      str(b.notes, 'Notes', { max: 300 }),
    );
    res.status(201).json(shape(db.prepare('SELECT * FROM ride_requests WHERE id = ?').get(lastInsertRowid)));
  });

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
