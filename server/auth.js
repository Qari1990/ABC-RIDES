const crypto = require('node:crypto');
const { HttpError } = require('./errors');

const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// Attaches req.user when a valid token is present; never rejects.
function loadUser(db) {
  const stmt = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.suspended = 0`);
  return (req, _res, next) => {
    const token = bearerToken(req);
    req.user = token ? stmt.get(token, new Date().toISOString()) || null : null;
    req.token = req.user ? token : null;
    next();
  };
}

function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please log in first'));
  next();
}

function requireAdmin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please log in first'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Admins only'));
  next();
}

module.exports = { hashPassword, verifyPassword, createSession, loadUser, requireUser, requireAdmin };
