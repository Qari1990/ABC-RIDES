const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { requireUser, verifyPassword, hashPassword } = require('../auth');
const { rateLimiter } = require('../security');
const { transaction } = require('../db');
const { HttpError, bad, str, int } = require('../errors');
const { notify } = require('../notify');
const { smsConfigured, sendSms, normalizePhone } = require('../sms');
const { emailConfigured, sendEmail } = require('../email');
const { decodeImage, saveDocuments } = require('../uploads');
const { selfUser } = require('./users');

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const CNIC_RE = /^\d{5}-?\d{7}-?\d$/;
const PLATE_RE = /^(?=.*\d)[A-Z0-9][A-Z0-9 -]{2,11}$/i;

const hashCode = (userId, code) => crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');
const formatCnic = (digits) => `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;

function notifyAdmins(db, title, body) {
  for (const a of db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all()) notify(db, a.id, title, body, '/admin?tab=verify');
}

module.exports = function onboardingRouter(db, { uploadDir }) {
  const router = express.Router();
  const reload = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const bigJson = express.json({ limit: '25mb' });

  // ---- Phone verification (one-time code by SMS) ---------------------------

  router.post('/me/phone/send-code', requireUser, async (req, res) => {
    const u = req.user;
    if (u.phone_verified) throw bad('Your phone number is already verified');
    const now = Date.now();
    const prev = db.prepare('SELECT * FROM phone_codes WHERE user_id = ?').get(u.id);
    if (prev && now - new Date(prev.sent_at) < RESEND_AFTER_MS) {
      throw new HttpError(429, 'Please wait a minute before requesting another code');
    }
    const sameWindow = prev && now - new Date(prev.window_start) < 36e5;
    if (sameWindow && prev.sent_count >= MAX_SENDS_PER_HOUR) {
      throw new HttpError(429, 'Too many codes requested. Please try again in an hour.');
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const iso = new Date(now).toISOString();
    db.prepare(`
      INSERT INTO phone_codes (user_id, code_hash, expires_at, attempts, sent_at, window_start, sent_count)
      VALUES (?, ?, ?, 0, ?, ?, 1)
      ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
        sent_at = excluded.sent_at, window_start = ?, sent_count = ?`)
      .run(u.id, hashCode(u.id, code), new Date(now + CODE_TTL_MS).toISOString(), iso, iso,
        sameWindow ? prev.window_start : iso, sameWindow ? prev.sent_count + 1 : 1);

    const message = `Your ABC Rides code is ${code}. It expires in 10 minutes. Never share it with anyone.`;
    if (smsConfigured()) {
      try {
        await sendSms(`+${normalizePhone(u.phone)}`, message);
      } catch (err) {
        console.error('SMS failed:', err.message);
        throw Object.assign(new HttpError(502, 'Could not send the SMS right now. Please try again shortly.'), { expected: true });
      }
      return res.json({ sent_to: u.phone });
    }
    // Development mode: no SMS provider configured, so hand the code back.
    console.log(`[dev] phone code for user ${u.id}: ${code}`);
    res.json({ sent_to: u.phone, dev_code: code });
  });

  router.post('/me/phone/verify', requireUser, (req, res) => {
    const u = req.user;
    const code = String((req.body && req.body.code) || '').trim();
    const row = db.prepare('SELECT * FROM phone_codes WHERE user_id = ?').get(u.id);
    if (!row || new Date(row.expires_at) < new Date()) throw bad('This code has expired. Please request a new one.');
    if (row.attempts >= MAX_ATTEMPTS) throw bad('Too many wrong attempts. Please request a new code.');
    const ok = /^\d{6}$/.test(code)
      && crypto.timingSafeEqual(Buffer.from(hashCode(u.id, code)), Buffer.from(row.code_hash));
    if (!ok) {
      db.prepare('UPDATE phone_codes SET attempts = attempts + 1 WHERE user_id = ?').run(u.id);
      throw bad(`Wrong code. ${MAX_ATTEMPTS - row.attempts - 1} attempt(s) left.`);
    }
    const phone = normalizePhone(u.phone);
    const taken = db.prepare('SELECT 1 FROM users WHERE verified_phone = ? AND id != ?').get(phone, u.id);
    if (taken) throw new HttpError(409, 'This phone number is already verified on another account');
    db.prepare('UPDATE users SET phone_verified = 1, verified_phone = ? WHERE id = ?').run(phone, u.id);
    db.prepare('DELETE FROM phone_codes WHERE user_id = ?').run(u.id);
    res.json(selfUser(db, reload(u.id)));
  });

  // ---- Identity: CNIC + selfie (+ student or employee card) ----------------

  router.post('/me/verification', requireUser, bigJson, (req, res) => {
    const u = req.user;
    const b = req.body || {};
    const images = {};
    let cnic = null;

    if (u.verification_status !== 'verified') {
      const raw = str(b.cnic_number, 'CNIC number', { required: true, max: 15 });
      if (!CNIC_RE.test(raw)) throw bad('CNIC number must look like 35202-1234567-1');
      cnic = raw.replace(/-/g, '');
      if (db.prepare('SELECT 1 FROM users WHERE cnic = ? AND id != ?').get(cnic, u.id)) {
        throw new HttpError(409, 'This CNIC is already registered with another account');
      }
      images.cnic_front = decodeImage(b.cnic_front, 'CNIC front');
      images.cnic_back = decodeImage(b.cnic_back, 'CNIC back');
      images.selfie = decodeImage(b.selfie, 'Selfie');
    }
    if (b.student_card) images.student_card = decodeImage(b.student_card, 'Student card');
    if (b.employee_card) images.employee_card = decodeImage(b.employee_card, 'Employee card');
    if (!Object.keys(images).length) throw bad('Your identity is already verified. Attach a student or employee card to add it.');

    saveDocuments(db, uploadDir, u.id, images);
    if (cnic) {
      db.prepare(`UPDATE users SET cnic = ?, verification_status = 'pending', verification_doc_type = 'cnic',
        verification_note = NULL WHERE id = ?`).run(cnic, u.id);
    }
    if (images.student_card) db.prepare(`UPDATE users SET student_status = 'pending' WHERE id = ?`).run(u.id);
    notifyAdmins(db, 'New verification request', `${u.name} submitted ${Object.keys(images).join(', ').replace(/_/g, ' ')}`);
    res.json(selfUser(db, reload(u.id)));
  });

  // ---- Driver: licence + vehicle -------------------------------------------

  router.post('/me/driver', requireUser, bigJson, (req, res) => {
    const u = req.user;
    const b = req.body || {};
    if (!['pending', 'verified'].includes(u.verification_status)) {
      throw bad('Please verify your identity (CNIC and selfie) first');
    }
    if (u.driver_status === 'pending') throw bad('Your driver application is already under review');
    const v = b.vehicle || {};
    const year = new Date().getFullYear();
    const vehicle = {
      make: str(v.make, 'Vehicle make', { required: true, max: 30 }),
      model: str(v.model, 'Vehicle model', { required: true, max: 30 }),
      year: int(v.year, 'Vehicle year', { min: 1980, max: year + 1 }),
      color: str(v.color, 'Vehicle colour', { required: true, max: 20 }),
      plate: str(v.plate, 'Number plate', { required: true, max: 12 }).toUpperCase(),
      seats: int(v.seats, 'Passenger seats', { min: 1, max: 8 }),
    };
    if (!PLATE_RE.test(vehicle.plate)) throw bad('Number plate looks invalid, e.g. LEA-1234');
    const licence = str(b.licence_number, 'Licence number', { required: true, max: 30 });
    const images = {
      driving_license: decodeImage(b.licence_photo, 'Driving licence'),
      vehicle_photo: decodeImage(b.vehicle_photo, 'Vehicle photo'),
      vehicle_registration: decodeImage(b.registration_photo, 'Vehicle registration'),
    };

    saveDocuments(db, uploadDir, u.id, images);
    db.prepare(`
      INSERT INTO vehicles (user_id, make, model, year, color, plate, seats) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET make = excluded.make, model = excluded.model, year = excluded.year,
        color = excluded.color, plate = excluded.plate, seats = excluded.seats, updated_at = excluded.updated_at`)
      .run(u.id, vehicle.make, vehicle.model, vehicle.year, vehicle.color, vehicle.plate, vehicle.seats);
    db.prepare(`UPDATE users SET driver_status = 'pending', driver_note = NULL, licence_number = ? WHERE id = ?`).run(licence, u.id);
    notifyAdmins(db, 'New driver application', `${u.name}: ${vehicle.make} ${vehicle.model} (${vehicle.plate})`);
    res.json(selfUser(db, reload(u.id)));
  });

  // ---- Forgot password (code by email or SMS) -------------------------------
  //
  // By email (free with Brevo) for any account, or by SMS to a verified phone.
  // The code is never shown on screen (that would let anyone take over any
  // account): with neither service set up, an admin sets a temporary password.
  const resetLimit = rateLimiter({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many reset attempts. Please try again in an hour.' });

  // Who is resetting: an email address (code by email) or a verified phone
  // (code by SMS). Returns { channel, user } (user may be null).
  const resetTarget = (body) => {
    const login = str(body.login ?? body.email ?? body.phone, 'Email or phone', { required: true, max: 120 }).trim();
    if (login.includes('@')) {
      return { channel: 'email', to: login.toLowerCase(), user: db.prepare('SELECT * FROM users WHERE email = ?').get(login.toLowerCase()) || null };
    }
    const phone = normalizePhone(login);
    return { channel: 'sms', to: phone, user: (phone && db.prepare('SELECT * FROM users WHERE verified_phone = ?').get(phone)) || null };
  };

  // Which ways of resetting are switched on, so the app can say so up front.
  router.get('/auth/reset/options', (_req, res) => res.json({ email: emailConfigured(), sms: smsConfigured() }));

  router.post('/auth/reset/send', async (req, res) => {
    resetLimit.check(`send|${req.ip}`);
    resetLimit.hit(`send|${req.ip}`);
    const { channel, to, user: u } = resetTarget(req.body || {});
    if (channel === 'email' ? !emailConfigured() : !smsConfigured()) {
      const other = channel === 'email' ? smsConfigured() && 'your verified phone number' : emailConfigured() && 'your email address';
      const err = new HttpError(503, `Password reset by ${channel === 'email' ? 'email' : 'SMS'} is not switched on yet. ${other ? `Try ${other} instead, or contact` : 'Please contact'} ABC Rides support to reset your password.`);
      err.code = 'reset_unavailable';
      err.expected = true; // a known state, not a crash: show the message, don't log it
      throw err;
    }
    // Same answer whether or not there is an account, so addresses can't be probed.
    const reply = { sent: true, message: `If this ${channel === 'email' ? 'email' : 'number'} has an ABC Rides account, a code is on its way.` };
    if (!u || u.suspended) return res.json(reply);
    const prev = db.prepare('SELECT * FROM reset_codes WHERE user_id = ?').get(u.id);
    if (prev && Date.now() - new Date(prev.sent_at) < RESEND_AFTER_MS) return res.json(reply);
    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare(`INSERT INTO reset_codes (user_id, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`)
      .run(u.id, hashCode(u.id, code), new Date(Date.now() + CODE_TTL_MS).toISOString(), new Date().toISOString());
    try {
      if (channel === 'email') {
        await sendEmail(to, `Your ABC Rides code: ${code}`,
          `Assalam-o-Alaikum ${u.name},\n\nYour ABC Rides password reset code is ${code}. It expires in 10 minutes.\n\nIf you didn't ask to reset your password, ignore this email; your account is safe.\n\nABC Rides`);
      } else {
        await sendSms(`+${to}`, `Your ABC Rides password reset code is ${code}. If you didn't ask for it, ignore this message.`);
      }
    } catch (err) {
      console.error(`${channel} failed:`, err.message);
      throw Object.assign(new HttpError(502, `Could not send the ${channel === 'email' ? 'email' : 'SMS'} right now. Please try again shortly.`), { expected: true });
    }
    res.json(reply);
  });

  router.post('/auth/reset/confirm', (req, res) => {
    resetLimit.check(`confirm|${req.ip}`);
    const b = req.body || {};
    const { user: u } = resetTarget(b);
    if (typeof b.new_password !== 'string' || b.new_password.length < 8) throw bad('New password must be at least 8 characters');
    const row = u && db.prepare('SELECT * FROM reset_codes WHERE user_id = ?').get(u.id);
    const wrong = () => { resetLimit.hit(`confirm|${req.ip}`); return bad('The code is wrong or has expired. Please request a new one.'); };
    if (!row || new Date(row.expires_at) < new Date() || row.attempts >= MAX_ATTEMPTS) throw wrong();
    if (hashCode(u.id, String(b.code || '').trim()) !== row.code_hash) {
      db.prepare('UPDATE reset_codes SET attempts = attempts + 1 WHERE user_id = ?').run(u.id);
      throw wrong();
    }
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.new_password), u.id);
      db.prepare('DELETE FROM reset_codes WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    });
    res.status(204).end();
  });

  // ---- Account deletion (required by Google Play) ---------------------------
  //
  // Removes personal details, ID photos and the vehicle, and signs out every
  // device. Past trips and reviews stay (other people's records point at them)
  // but show "Deleted user". Upcoming trips must be cancelled first so nobody
  // is left waiting at the roadside.
  router.delete('/me', requireUser, (req, res) => {
    const u = req.user;
    const b = req.body || {};
    if (typeof b.password !== 'string' || !verifyPassword(b.password, u.password_hash)) {
      throw bad('Password is wrong');
    }
    const now = new Date().toISOString();
    const upcoming = db.prepare(`
      SELECT 1 FROM rides WHERE driver_id = ? AND status = 'scheduled' AND departure_at > ?
      UNION ALL
      SELECT 1 FROM bookings b JOIN rides r ON r.id = b.ride_id
      WHERE b.passenger_id = ? AND b.status IN ('pending', 'confirmed') AND r.status = 'scheduled' AND r.departure_at > ?
      LIMIT 1`).get(u.id, now, u.id, now);
    if (upcoming) throw new HttpError(409, 'Cancel your upcoming rides and bookings first, then delete your account');
    const files = db.prepare('SELECT file FROM documents WHERE user_id = ?').all(u.id);
    transaction(db, () => {
      db.prepare(`UPDATE users SET name = 'Deleted user', email = ?, phone = '', password_hash = ?, bio = NULL,
        organization = NULL, emergency_name = NULL, emergency_phone = NULL, cnic = NULL, verified_phone = NULL,
        phone_verified = 0, licence_number = NULL, suspended = 1, role = 'user' WHERE id = ?`)
        .run(`deleted-${u.id}@deleted.invalid`, crypto.randomBytes(32).toString('hex'), u.id);
      for (const t of ['documents', 'vehicles', 'phone_codes', 'reset_codes', 'push_subscriptions', 'sessions', 'notifications', 'ride_requests']) {
        const col = t === 'ride_requests' ? 'passenger_id' : 'user_id';
        db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(u.id);
      }
    });
    for (const { file } of files) fs.rm(path.join(uploadDir, path.basename(file)), { force: true }, () => {});
    res.status(204).end();
  });

  return router;
};

module.exports.formatCnic = formatCnic;
