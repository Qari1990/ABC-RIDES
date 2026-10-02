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
  auto_complete_hours: { default: 6, min: 1, max: 72, label: 'Rides with passengers complete by themselves this many hours after arrival' },
  review_points_5: { default: 1, min: -20, max: 20, label: 'Reliability points for a 5-star review' },
  review_points_4: { default: 0, min: -20, max: 20, label: 'Reliability points for a 4-star review' },
  review_points_3: { default: -1, min: -20, max: 20, label: 'Reliability points for a 3-star review' },
  review_points_2: { default: -3, min: -20, max: 20, label: 'Reliability points for a 2-star review' },
  review_points_1: { default: -5, min: -20, max: 20, label: 'Reliability points for a 1-star review' },
  min_topup: { default: 100, min: 1, max: 100000, label: 'Minimum wallet top-up (Rs)' },
  // Fares per km and per seat. Defaults compare with Daewoo Luxury (~Rs 7/km per seat, Lahore-Islamabad,
  // Oct 2026) and a private intercity car (~Rs 15/km for the whole car).
  fare_per_km: { default: 8, min: 1, max: 100, label: 'Suggested fare per km per seat (Rs)' },
  fare_min_per_km: { default: 6, min: 1, max: 100, label: 'Lowest fare drivers may set per km (Rs)' },
  fare_max_per_km: { default: 11, min: 1, max: 100, label: 'Highest fare drivers may set per km (Rs)' },
  enforce_fare_limits: { default: true, label: 'Keep fares within the per-km limits' },
  // The per-km fares above are for a standard car with AC; other cars are scaled (percent).
  fare_factor_economy: { default: 90, min: 50, max: 200, label: 'Fare for economy cars (% of standard)' },
  fare_factor_standard: { default: 100, min: 50, max: 200, label: 'Fare for standard cars (%)' },
  fare_factor_premium: { default: 120, min: 50, max: 200, label: 'Fare for premium cars (% of standard)' },
  fare_factor_suv: { default: 130, min: 50, max: 200, label: 'Fare for SUVs (% of standard)' },
  fare_factor_van: { default: 95, min: 50, max: 200, label: 'Fare for vans / MPVs (% of standard)' },
  no_ac_fare_factor: { default: 85, min: 50, max: 100, label: 'Fare for cars without AC (% of the same car with AC)' },
  // Private rides: the whole car for one group, priced per km for the car.
  private_per_km: { default: 18, min: 1, max: 200, label: 'Suggested private ride fare per km, whole car (Rs)' },
  private_min_per_km: { default: 12, min: 1, max: 200, label: 'Lowest private ride fare per km (Rs)' },
  private_max_per_km: { default: 30, min: 1, max: 300, label: 'Highest private ride fare per km (Rs)' },
  private_requires_id: { default: true, label: 'Private rides only for ID-verified passengers' },
  home_pickup_per_km: { default: 50, min: 0, max: 1000, label: 'Home pickup/drop charge per km (Rs)' },
  home_pickup_min: { default: 150, min: 0, max: 10000, label: 'Minimum home pickup/drop charge (Rs)' },
  home_max_radius_km: { default: 15, min: 1, max: 50, label: 'Largest home pickup/drop radius drivers may offer (km)' },
  share_discount_2_pct: { default: 25, min: 0, max: 100, label: 'Commission discount with 2 passengers (%)' },
  share_discount_3_pct: { default: 50, min: 0, max: 100, label: 'Commission discount with 3+ passengers (%)' },
  share_bonus_points: { default: 1, min: 0, max: 20, label: 'Extra reliability points per extra passenger on a completed trip' },
  petrol_price: { default: 390, min: 1, max: 2000, label: 'Petrol price per litre (Rs), for the driver calculator' },
  car_km_per_litre: { default: 13, min: 1, max: 50, label: 'Typical car mileage (km per litre)' },
  ref_bus_per_km: { default: 7, min: 0, max: 100, label: 'Bus fare per km per seat, for comparison (Rs)' },
  ref_private_car_per_km: { default: 15, min: 0, max: 200, label: 'Private car fare per km, whole car, for comparison (Rs)' },
  require_phone_verification: { default: true, label: 'Phone must be verified to book or post rides' },
  require_id_for_booking: { default: false, label: 'Passengers must be ID-verified to book' },
  require_driver_approval: { default: true, label: 'Drivers must be approved before posting rides' },
  student_price_requires_verification: { default: true, label: 'Student prices only for verified students' },
  notify_admins_of_requests: { default: true, label: 'Tell admins about every new passenger ride request' },
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
