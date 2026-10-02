const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { setSettings } = require('../server/settings');

// The original tests predate onboarding checks and fees, so by default the
// test server switches those off; tests for them turn them back on.
const RELAXED = {
  require_phone_verification: false,
  require_driver_approval: false,
  student_price_requires_verification: false,
  driver_commission_pct: 0,
  passenger_commission_pct: 0,
  // Their fixed prices predate the per-km fare limits.
  enforce_fare_limits: false,
};

// Starts the app on a random port with an in-memory database.
async function startServer({ settings = RELAXED } = {}) {
  process.env.SIGNUP_LIMIT_PER_HOUR = '100000';
  const db = openDb(':memory:');
  setSettings(db, settings);
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abc-rides-'));
  const server = createApp(db, { uploadDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  async function call(method, urlPath, { token, body } = {}) {
    const res = await fetch(base + urlPath, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  let n = 0;
  async function register(overrides = {}) {
    n += 1;
    const { status, body } = await call('POST', '/auth/register', {
      body: {
        name: `User ${n}`, email: `user${n}@test.pk`, phone: '+92 300 0000000', password: 'secret123',
        traveler_type: 'professional', gender: 'male', accept_terms: true, ...overrides,
      },
    });
    assert.equal(status, 201, JSON.stringify(body));
    return body;
  }

  const close = () => { server.close(); fs.rmSync(uploadDir, { recursive: true, force: true }); };
  return { db, call, register, close, uploadDir };
}

const inHours = (h) => new Date(Date.now() + h * 36e5).toISOString();

function rideBody(extra = {}) {
  return {
    from_city: 'Lahore', to_city: 'Islamabad', departure_at: inHours(24),
    seats_total: 3, price_per_seat: 2000, student_discount_pct: 25, ...extra,
  };
}

module.exports = { startServer, inHours, rideBody };
