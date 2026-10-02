const express = require('express');
const { requireUser } = require('../auth');
const { HttpError, bad, str } = require('../errors');
const { sendPush } = require('../push');

// Chat between a driver and a passenger, one thread per booking.
module.exports = function messagesRouter(db) {
  const router = express.Router();

  // Returns the booking and ride if the user is part of the conversation.
  const thread = (bookingId, user) => {
    const row = db.prepare(`
      SELECT b.id, b.status, b.seats, b.passenger_id, r.id AS ride_id, r.driver_id, r.from_city, r.to_city,
             r.departure_at, r.status AS ride_status
      FROM bookings b JOIN rides r ON r.id = b.ride_id WHERE b.id = ?`).get(Number(bookingId));
    if (!row) throw new HttpError(404, 'Conversation not found');
    if (user.id !== row.passenger_id && user.id !== row.driver_id) throw new HttpError(403, 'This is not your conversation');
    const otherId = user.id === row.driver_id ? row.passenger_id : row.driver_id;
    const other = db.prepare('SELECT id, name FROM users WHERE id = ?').get(otherId);
    return { ...row, other, my_role: user.id === row.driver_id ? 'driver' : 'passenger' };
  };

  router.get('/bookings/:id/messages', requireUser, (req, res) => {
    const t = thread(req.params.id, req.user);
    db.prepare('UPDATE messages SET read_at = ? WHERE booking_id = ? AND sender_id != ? AND read_at IS NULL')
      .run(new Date().toISOString(), t.id, req.user.id);
    const messages = db.prepare('SELECT id, sender_id, body, created_at FROM messages WHERE booking_id = ? ORDER BY id').all(t.id);
    res.json({ thread: t, messages });
  });

  router.post('/bookings/:id/messages', requireUser, (req, res) => {
    const t = thread(req.params.id, req.user);
    if (!['pending', 'confirmed'].includes(t.status) || t.ride_status === 'cancelled') {
      throw bad('This conversation is closed');
    }
    const body = str(req.body && req.body.body, 'Message', { required: true, max: 1000 });
    const { lastInsertRowid } = db.prepare('INSERT INTO messages (booking_id, sender_id, body) VALUES (?, ?, ?)')
      .run(t.id, req.user.id, body);
    // Chat messages go to the inbox badge, and to the phone if push is on.
    try {
      sendPush(db, t.other.id, { title: `Message from ${req.user.name}`, body: body.slice(0, 120), link: `/chat/${t.id}` });
    } catch (err) {
      console.warn(`Push skipped: ${err.message}`);
    }
    res.status(201).json(db.prepare('SELECT id, sender_id, body, created_at FROM messages WHERE id = ?').get(lastInsertRowid));
  });

  // Inbox: every booking thread the user is part of, newest activity first.
  router.get('/me/conversations', requireUser, (req, res) => {
    const me = req.user.id;
    const rows = db.prepare(`
      SELECT b.id AS booking_id, b.status, r.id AS ride_id, r.from_city, r.to_city, r.departure_at,
             CASE WHEN r.driver_id = $me THEN p.name ELSE d.name END AS other_name,
             CASE WHEN r.driver_id = $me THEN 'driver' ELSE 'passenger' END AS my_role,
             (SELECT body FROM messages m WHERE m.booking_id = b.id ORDER BY m.id DESC LIMIT 1) AS last_message,
             (SELECT created_at FROM messages m WHERE m.booking_id = b.id ORDER BY m.id DESC LIMIT 1) AS last_at,
             (SELECT COUNT(*) FROM messages m WHERE m.booking_id = b.id AND m.sender_id != $me AND m.read_at IS NULL) AS unread
      FROM bookings b JOIN rides r ON r.id = b.ride_id
      JOIN users p ON p.id = b.passenger_id JOIN users d ON d.id = r.driver_id
      WHERE (b.passenger_id = $me OR r.driver_id = $me)
        AND (b.status IN ('pending', 'confirmed') OR EXISTS (SELECT 1 FROM messages m WHERE m.booking_id = b.id))
      ORDER BY COALESCE(last_at, b.created_at) DESC LIMIT 100`).all({ me });
    res.json(rows);
  });

  router.post('/reports', requireUser, (req, res) => {
    const b = req.body || {};
    const reportedId = Number(b.reported_user_id);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(reportedId)) throw bad('User not found');
    if (reportedId === req.user.id) throw bad('You cannot report yourself');
    const reason = str(b.reason, 'Reason', { required: true, max: 60 });
    db.prepare('INSERT INTO reports (reporter_id, reported_user_id, ride_id, reason, details) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, reportedId, b.ride_id ? Number(b.ride_id) : null, reason, str(b.details, 'Details', { max: 1000 }));
    res.status(201).json({ ok: true });
  });

  return router;
};
