const express = require('express');
const { hashPassword, verifyPassword, createSession, requireUser } = require('../auth');
const { HttpError, bad, str, oneOf } = require('../errors');
const { rateLimiter } = require('../security');
const { normalizePhone, validMobile } = require('../phone');
const { getSettings } = require('../settings');
const { freeConfirmationsLeft } = require('../wallet');
const { vapidKeys, saveSubscription, saveAppToken } = require('../push');
const { TERMS_VERSION } = require('../terms');
const { shapeVehicle } = require('../cars');

const TRAVELER_TYPES = ['professional', 'student', 'traveler'];
const GENDERS = ['male', 'female', 'other'];

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
    phone_verified: !!u.phone_verified,
    email_verified: !!u.email_verified,
    student_verified: u.student_status === 'verified',
    approved_driver: u.driver_status === 'approved',
    reliability: u.reliability,
    member_since: u.created_at,
    ...ratingFor(db, u.id),
  };
}

function selfUser(db, u) {
  return {
    ...publicUser(db, u),
    terms_current: u.terms_version === TERMS_VERSION,
    email: u.email,
    phone: u.phone,
    role: u.role,
    verification_status: u.verification_status,
    verification_doc_type: u.verification_doc_type,
    verification_note: u.verification_note,
    cnic_masked: u.cnic ? `${u.cnic.slice(0, 5)}-*******-${u.cnic.slice(12)}` : null,
    student_status: u.student_status,
    driver_status: u.driver_status,
    driver_note: u.driver_note,
    ...(() => {
      const v = db.prepare('SELECT * FROM vehicles WHERE user_id = ?').get(u.id);
      return {
        vehicle: shapeVehicle(v),
        vehicle_change: v && v.pending_change ? { ...JSON.parse(v.pending_change), since: v.pending_since } : null,
        vehicle_change_note: v ? v.change_note : null,
      };
    })(),
    wallet_balance: u.wallet_balance,
    free_confirmations_left: freeConfirmationsLeft(db, getSettings(db), u.id),
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
  if (fields.phone) fields.phone = validMobile(fields.phone);
  if (fields.emergency_phone) fields.emergency_phone = validMobile(fields.emergency_phone, 'Emergency contact number');
  return fields;
}

module.exports = function usersRouter(db) {
  const router = express.Router();
  // Per network address. Mobile networks share addresses between many people, so keep this generous.
  const signups = rateLimiter({
    windowMs: 36e5, max: Number(process.env.SIGNUP_LIMIT_PER_HOUR) || 100,
    message: 'Too many sign-ups from this network. Please try again later.',
  });
  const failedLogins = rateLimiter({ windowMs: 15 * 60e3, max: 8, message: 'Too many failed attempts. Please wait 15 minutes and try again.' });

  router.post('/auth/register', (req, res) => {
    signups.check(req.ip);
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
    if (body.accept_terms !== true) throw bad('Please read and accept the Terms of Use, Privacy Policy and disclaimer to sign up');
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO users (name, email, phone, password_hash, traveler_type, gender, organization, bio, emergency_name, emergency_phone, role)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(f.name, email, f.phone, hashPassword(body.password), f.traveler_type, f.gender, f.organization, f.bio,
        f.emergency_name, f.emergency_phone, adminEmails().includes(email) ? 'admin' : 'user');
    signups.hit(req.ip);
    db.prepare('UPDATE users SET terms_version = ?, terms_accepted_at = ? WHERE id = ?').run(TERMS_VERSION, new Date().toISOString(), lastInsertRowid);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    res.status(201).json({ token: createSession(db, user.id), user: selfUser(db, user) });
  });

  // Log in with email, or with a verified phone number.
  router.post('/auth/login', (req, res) => {
    const body = req.body || {};
    const id = str(body.email, 'Email or phone', { required: true }).toLowerCase();
    const key = `${req.ip}|${id}`;
    failedLogins.check(key);
    const user = id.includes('@')
      ? db.prepare('SELECT * FROM users WHERE email = ?').get(id)
      : db.prepare('SELECT * FROM users WHERE verified_phone = ?').get(normalizePhone(id));
    if (!user || typeof body.password !== 'string' || !verifyPassword(body.password, user.password_hash)) {
      failedLogins.hit(key);
      throw new HttpError(401, 'Wrong email/phone or password');
    }
    failedLogins.clear(key);
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
    // A new phone number has to be verified again.
    if (f.phone && normalizePhone(f.phone) !== normalizePhone(req.user.phone)) {
      db.prepare('UPDATE users SET phone_verified = 0, verified_phone = NULL WHERE id = ?').run(req.user.id);
    }
    res.json(selfUser(db, db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
  });

  router.post('/me/accept-terms', requireUser, (req, res) => {
    if ((req.body || {}).version !== TERMS_VERSION) throw bad('Please reload the app and accept the latest terms');
    db.prepare('UPDATE users SET terms_version = ?, terms_accepted_at = ? WHERE id = ?').run(TERMS_VERSION, new Date().toISOString(), req.user.id);
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

  // ---- Push notifications (Web Push) ----
  router.get('/push/key', (_req, res) => res.json({ key: vapidKeys(db).publicKey }));

  router.post('/me/push', requireUser, (req, res) => {
    if (!saveSubscription(db, req.user.id, req.body && req.body.subscription)) throw bad('Invalid push subscription');
    res.status(204).end();
  });

  router.delete('/me/push', requireUser, (req, res) => {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(req.user.id, String((req.body || {}).endpoint || ''));
    res.status(204).end();
  });

  // The Android app's Firebase token for this install.
  router.post('/me/push-app', requireUser, (req, res) => {
    if (!saveAppToken(db, req.user.id, (req.body || {}).token)) throw bad('Invalid app token');
    res.status(204).end();
  });

  router.delete('/me/push-app', requireUser, (req, res) => {
    db.prepare('DELETE FROM app_push_tokens WHERE user_id = ? AND token = ?').run(req.user.id, String((req.body || {}).token || ''));
    res.status(204).end();
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
module.exports.selfUser = selfUser;
module.exports.adminEmails = adminEmails;
