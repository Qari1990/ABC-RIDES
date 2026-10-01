const { bad } = require('./errors');

// Admin-controlled policy. Each setting has a default and a validator; the
// admin panel edits them and every request reads the current values.
const SPEC = {
  booking_mode: {
    default: 'driver_choice', options: ['driver_choice', 'manual', 'instant'],
    label: 'How bookings are accepted',
  },
  driver_commission_pct: { default: 5, min: 0, max: 50, label: 'Driver commission (%)' },
  passenger_commission_pct: { default: 2, min: 0, max: 50, label: 'Passenger booking fee (%)' },
  free_confirmations: { default: 3, min: 0, max: 1000, label: 'Free confirmed bookings per user' },
  reliability_threshold: { default: 70, min: 0, max: 100, label: 'Reliability below which a fee applies' },
  low_reliability_fee: { default: 100, min: 0, max: 10000, label: 'Low-reliability fee (Rs)' },
  penalty_driver_cancel: { default: 15, min: 0, max: 100, label: 'Points lost when a driver cancels a booked ride' },
  penalty_passenger_cancel: { default: 10, min: 0, max: 100, label: 'Points lost when a passenger cancels a confirmed booking' },
  late_cancel_hours: { default: 24, min: 0, max: 168, label: 'Cancellations closer than this (hours) cost double' },
  reward_completed: { default: 2, min: 0, max: 50, label: 'Points earned per completed trip' },
  min_topup: { default: 100, min: 1, max: 100000, label: 'Minimum wallet top-up (Rs)' },
  require_phone_verification: { default: true, label: 'Phone must be verified to book or post rides' },
  require_id_for_booking: { default: false, label: 'Passengers must be ID-verified to book' },
  require_driver_approval: { default: true, label: 'Drivers must be approved before posting rides' },
  student_price_requires_verification: { default: true, label: 'Student prices only for verified students' },
  topup_accounts: {
    default: 'JazzCash: 03XX-XXXXXXX (ABC Rides)\nEasypaisa: 03XX-XXXXXXX (ABC Rides)',
    maxLength: 500, label: 'Accounts users send top-ups to',
  },
};

function coerce(key, value) {
  const spec = SPEC[key];
  if (!spec) throw bad(`Unknown setting: ${key}`);
  const d = spec.default;
  if (typeof d === 'boolean') {
    if (typeof value !== 'boolean') throw bad(`${spec.label} must be true or false`);
    return value;
  }
  if (typeof d === 'number') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) throw bad(`${spec.label} must be a whole number from ${spec.min} to ${spec.max}`);
    return n;
  }
  if (spec.options) {
    if (!spec.options.includes(value)) throw bad(`${spec.label} must be one of: ${spec.options.join(', ')}`);
    return value;
  }
  if (typeof value !== 'string' || value.length > spec.maxLength) throw bad(`${spec.label} must be text up to ${spec.maxLength} characters`);
  return value.trim();
}

function getSettings(db) {
  const out = Object.fromEntries(Object.entries(SPEC).map(([k, s]) => [k, s.default]));
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (row.key in SPEC) out[row.key] = JSON.parse(row.value);
  }
  return out;
}

function setSettings(db, patch) {
  const clean = Object.entries(patch || {}).map(([k, v]) => [k, coerce(k, v)]);
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of clean) upsert.run(k, JSON.stringify(v));
  return getSettings(db);
}

const settingsSpec = () => Object.fromEntries(Object.entries(SPEC).map(([k, s]) => [k, {
  label: s.label, type: typeof s.default, options: s.options, min: s.min, max: s.max,
}]));

module.exports = { getSettings, setSettings, settingsSpec };
