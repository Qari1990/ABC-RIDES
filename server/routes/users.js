const express = require('express');
const { hashPassword, verifyPassword, createSession, requireUser } = require('../auth');
const { HttpError, bad, str, oneOf } = require('../errors');

const TRAVELER_TYPES = ['professional', 'student', 'traveler'];
const GENDERS = ['male', 'female', 'other'];

function ratingFor(db, userId) {
  const row = db.prepare('SELECT AVG(rating) avg, COUNT(*) count FROM reviews WHERE reviewee_id = ?').get(userId);
  return { rating_avg: row.avg ? Math.round(row.avg * 10) / 10 : null, rating_count: row.count };
}

// What anyone may see about a user. Phone and email stay private.
function publicUser(db, u) {
  return {
    id: u.id,
    name: u.name,
    traveler_type: u.traveler_type,
    gender: u.gender,
    organization: u.organization,
    bio: u.bio,
    member_since: u.created_at,
    ...ratingFor(db, u.id),
  };
}

function selfUser(db, u) {
  return { ...publicUser(db, u), email: u.email, phone: u.phone };
}

function profileFields(body, { partial }) {
  const fields = {
    name: str(body.name, 'Name', { required: !partial, max: 80 }),
    phone: str(body.phone, 'Phone', { required: !partial, max: 20 }),
    traveler_type: oneOf(body.traveler_type, 'Traveller type', TRAVELER_TYPES, { required: !partial }),
    gender: oneOf(body.gender, 'Gender', GENDERS),
    organization: str(body.organization, 'Organization', { max: 100 }),
    bio: str(body.bio, 'Bio', { max: 500 }),
  };
  if (fields.phone && !/^\+?[0-9 -]{7,20}$/.test(fields.phone)) throw bad('Phone number looks invalid');
  return fields;
}

module.exports = function usersRouter(db) {
  const router = express.Router();

  router.post('/auth/register', (req, res) => {
    const body = req.body || {};
    const email = str(body.email, 'Email', { required: true, max: 120 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Email looks invalid');
    if (typeof body.password !== 'string' || body.password.length < 8) {
      throw bad('Password must be at least 8 characters');
    }
    const f = profileFields(body, { partial: false });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'An account with this email already exists');
    }
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO users (name, email, phone, password_hash, traveler_type, gender, organization, bio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(f.name, email, f.phone, hashPassword(body.password), f.traveler_type, f.gender, f.organization, f.bio);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    res.status(201).json({ token: createSession(db, user.id), user: selfUser(db, user) });
  });

  router.post('/auth/login', (req, res) => {
    const body = req.body || {};
    const email = str(body.email, 'Email', { required: true }).toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || typeof body.password !== 'string' || !verifyPassword(body.password, user.password_hash)) {
      throw new HttpError(401, 'Wrong email or password');
    }
    res.json({ token: createSession(db, user.id), user: selfUser(db, user) });
  });

  router.post('/auth/logout', requireUser, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.status(204).end();
  });

  router.get('/me', requireUser, (req, res) => {
    res.json(selfUser(db, req.user));
  });

  router.patch('/me', requireUser, (req, res) => {
    const f = profileFields(req.body || {}, { partial: true });
    const updates = Object.entries(f).filter(([, v]) => v !== null);
    if (updates.length) {
      const sets = updates.map(([k]) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...updates.map(([, v]) => v), req.user.id);
    }
    res.json(selfUser(db, db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
  });

  router.get('/users/:id', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!user) throw new HttpError(404, 'User not found');
    const reviews = db.prepare(`
      SELECT r.rating, r.comment, r.created_at, u.id reviewer_id, u.name reviewer_name
      FROM reviews r JOIN users u ON u.id = r.reviewer_id
      WHERE r.reviewee_id = ? ORDER BY r.created_at DESC LIMIT 20`).all(user.id);
    const trips = db.prepare(`SELECT COUNT(*) n FROM rides WHERE driver_id = ? AND status = 'completed'`).get(user.id).n;
    res.json({ ...publicUser(db, user), rides_driven: trips, reviews });
  });

  return router;
};

module.exports.publicUser = publicUser;
