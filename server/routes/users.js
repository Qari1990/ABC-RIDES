const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword, verifyPassword, createSession, requireUser } = require('../auth');
const { HttpError, bad, str, oneOf } = require('../errors');
const { notify } = require('../notify');

const TRAVELER_TYPES = ['professional', 'student', 'traveler'];
const GENDERS = ['male', 'female', 'other'];
const DOC_TYPES = ['cnic', 'student_card', 'employee_card', 'driving_license'];
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const PHONE_RE = /^\+?[0-9 -]{7,20}$/;

// Comma-separated list of emails that get the admin role.
function adminEmails() {
  return (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

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
    verified: u.verification_status === 'verified',
    verified_as: u.verification_status === 'verified' ? u.verification_doc_type : null,
    member_since: u.created_at,
    ...ratingFor(db, u.id),
  };
}

function selfUser(db, u) {
  return {
    ...publicUser(db, u),
    email: u.email,
    phone: u.phone,
    role: u.role,
    verification_status: u.verification_status,
    verification_doc_type: u.verification_doc_type,
    verification_note: u.verification_note,
    emergency_name: u.emergency_name,
    emergency_phone: u.emergency_phone,
  };
}

function profileFields(body, { partial }) {
  const fields = {
    name: str(body.name, 'Name', { required: !partial, max: 80 }),
    phone: str(body.phone, 'Phone', { required: !partial, max: 20 }),
    traveler_type: oneOf(body.traveler_type, 'Traveller type', TRAVELER_TYPES, { required: !partial }),
    gender: oneOf(body.gender, 'Gender', GENDERS),
    organization: str(body.organization, 'Organization', { max: 100 }),
    bio: str(body.bio, 'Bio', { max: 500 }),
    emergency_name: str(body.emergency_name, 'Emergency contact name', { max: 80 }),
    emergency_phone: str(body.emergency_phone, 'Emergency contact phone', { max: 20 }),
  };
  if (fields.phone && !PHONE_RE.test(fields.phone)) throw bad('Phone number looks invalid');
  if (fields.emergency_phone && !PHONE_RE.test(fields.emergency_phone)) throw bad('Emergency contact phone looks invalid');
  return fields;
}

module.exports = function usersRouter(db, { uploadDir }) {
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
      INSERT INTO users (name, email, phone, password_hash, traveler_type, gender, organization, bio, emergency_name, emergency_phone, role)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(f.name, email, f.phone, hashPassword(body.password), f.traveler_type, f.gender, f.organization, f.bio,
        f.emergency_name, f.emergency_phone, adminEmails().includes(email) ? 'admin' : 'user');
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
    if (user.suspended) throw new HttpError(403, 'This account is suspended. Please contact support.');
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
    const body = req.body || {};
    const f = profileFields(body, { partial: true });
    // Required fields are only changed when given; optional ones can be cleared.
    const required = ['name', 'phone', 'traveler_type'];
    const updates = Object.entries(f).filter(([k, v]) => (required.includes(k) ? v !== null : k in body));
    if (updates.length) {
      const sets = updates.map(([k]) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...updates.map(([, v]) => v), req.user.id);
    }
    res.json(selfUser(db, db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
  });

  router.post('/me/password', requireUser, (req, res) => {
    const b = req.body || {};
    if (typeof b.current_password !== 'string' || !verifyPassword(b.current_password, req.user.password_hash)) {
      throw bad('Current password is wrong');
    }
    if (typeof b.new_password !== 'string' || b.new_password.length < 8) throw bad('New password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.new_password), req.user.id);
    // Sign out every other device.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.token);
    res.status(204).end();
  });

  // Upload a photo of a CNIC, student card, employee card or driving licence.
  // An admin reviews it and grants the "verified" badge.
  router.post('/me/verification', requireUser, express.json({ limit: '6mb' }), (req, res) => {
    const b = req.body || {};
    const docType = oneOf(b.doc_type, 'Document type', DOC_TYPES, { required: true });
    const match = typeof b.image === 'string' && b.image.match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match || !IMAGE_TYPES[match[1]]) throw bad('Please attach a JPG, PNG or WebP photo of the document');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > MAX_UPLOAD_BYTES) throw bad('The photo must be smaller than 4 MB');
    if (req.user.verification_status === 'verified') throw bad('Your account is already verified');

    fs.mkdirSync(uploadDir, { recursive: true });
    const file = `${req.user.id}-${crypto.randomBytes(8).toString('hex')}.${IMAGE_TYPES[match[1]]}`;
    fs.writeFileSync(path.join(uploadDir, file), bytes);
    if (req.user.verification_file) fs.rm(path.join(uploadDir, req.user.verification_file), { force: true }, () => {});

    db.prepare(`UPDATE users SET verification_status = 'pending', verification_doc_type = ?, verification_file = ?,
      verification_note = NULL WHERE id = ?`).run(docType, file, req.user.id);
    for (const admin of db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all()) {
      notify(db, admin.id, 'New verification request', `${req.user.name} uploaded a document`, '/admin');
    }
    res.json(selfUser(db, db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
  });

  router.get('/notifications', requireUser, (req, res) => {
    const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
    res.json(rows);
  });

  // Cheap endpoint the app polls for badges.
  router.get('/notifications/unread-count', requireUser, (req, res) => {
    const notifications = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n;
    const messages = db.prepare(`
      SELECT COUNT(*) n FROM messages m
      JOIN bookings b ON b.id = m.booking_id JOIN rides r ON r.id = b.ride_id
      WHERE m.read_at IS NULL AND m.sender_id != ? AND (b.passenger_id = ? OR r.driver_id = ?)`)
      .get(req.user.id, req.user.id, req.user.id).n;
    res.json({ notifications, messages });
  });

  router.post('/notifications/read-all', requireUser, (req, res) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(new Date().toISOString(), req.user.id);
    res.status(204).end();
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
module.exports.adminEmails = adminEmails;
