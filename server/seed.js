// Fills the database with demo users and upcoming rides so the app has
// something to show. Every demo account uses the password "password123";
// admin@example.com is an admin.
const { openDb, transaction } = require('./db');
const { hashPassword } = require('./auth');
const { estimateRoute } = require('./cities');
const { normalizePhone } = require('./sms');

const db = openDb();
const hash = hashPassword('password123');

const users = [
  ['Ahmed Raza', 'ahmed@example.com', '+92 300 1234567', 'professional', 'male', 'Software engineer, Systems Ltd'],
  ['Ayesha Khan', 'ayesha@example.com', '+92 301 7654321', 'student', 'female', 'NUST Islamabad'],
  ['Bilal Hussain', 'bilal@example.com', '+92 333 5550000', 'traveler', 'male', null],
  ['Sara Malik', 'sara@example.com', '+92 345 1112222', 'professional', 'female', 'Doctor, Shifa International'],
  ['ABC Admin', 'admin@example.com', '+92 300 0000001', 'professional', null, 'ABC Rides'],
];

// A time N days from today in Pakistan (UTC+5), whatever the server's timezone.
const PKT_OFFSET_HOURS = 5;
function at(daysAhead, hour, minute = 0) {
  const d = new Date(Date.now() + PKT_OFFSET_HOURS * 36e5);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour - PKT_OFFSET_HOURS, minute, 0, 0);
  return d.toISOString();
}

transaction(db, () => {
  const ids = {};
  for (const [name, email, phone, type, gender, org] of users) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    ids[email] = existing ? existing.id : Number(db.prepare(`
      INSERT INTO users (name, email, phone, password_hash, traveler_type, gender, organization)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(name, email, phone, hash, type, gender, org).lastInsertRowid);
  }
  db.prepare(`UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'`).run();
  // Demo accounts are already through onboarding: phone verified, ID checked, Rs 1,000 in the wallet.
  let cnic = 3520210000001;
  for (const [, email, phone] of users) {
    db.prepare(`UPDATE users SET phone_verified = 1, verified_phone = ?, verification_status = 'verified',
      verification_doc_type = 'cnic', cnic = COALESCE(cnic, ?), wallet_balance = 1000 WHERE email = ?`)
      .run(normalizePhone(phone), String(cnic++), email);
  }
  db.prepare(`UPDATE users SET student_status = 'verified' WHERE email = 'ayesha@example.com'`).run();
  const vehicles = [
    ['ahmed@example.com', 'Honda', 'Civic', 2020, 'White', 'LEB-4521', 4],
    ['sara@example.com', 'Toyota', 'Corolla', 2018, 'Grey', 'ICT-7788', 4],
    ['bilal@example.com', 'Suzuki', 'Cultus', 2017, 'Red', 'KHI-3302', 4],
  ];
  for (const [email, ...v] of vehicles) {
    db.prepare(`UPDATE users SET driver_status = 'approved', licence_number = 'DEMO-LICENCE' WHERE email = ?`).run(email);
    db.prepare(`INSERT OR REPLACE INTO vehicles (user_id, make, model, year, color, plate, seats) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(ids[email], ...v);
  }

  const rides = [
    ['ahmed@example.com', 'Lahore', 'Islamabad', 'Thokar Niaz Baig', 'Faizabad', at(1, 7), 3, 2500, 20, 0, 1, 'Honda Civic (white)', 'Weekly office commute, AC car, no smoking.', 'cash,jazzcash', 'JazzCash 0300 1234567 (Ahmed Raza)'],
    ['ahmed@example.com', 'Islamabad', 'Lahore', 'Faizabad', 'Thokar Niaz Baig', at(4, 18), 3, 2500, 20, 0, 1, 'Honda Civic (white)', 'Friday evening ride back home.', 'cash,jazzcash', 'JazzCash 0300 1234567 (Ahmed Raza)'],
    ['sara@example.com', 'Islamabad', 'Peshawar', 'G-9 Markaz', 'Hayatabad', at(2, 9), 2, 1800, 10, 1, 0, 'Toyota Corolla', 'Women only. Light luggage please.', 'cash,easypaisa', 'Easypaisa 0345 1112222'],
    ['bilal@example.com', 'Karachi', 'Hyderabad', 'Sohrab Goth', 'Qasimabad', at(1, 16), 4, 900, 25, 0, 0, 'Suzuki Cultus', null, 'cash', null],
    ['bilal@example.com', 'Lahore', 'Faisalabad', 'Kalma Chowk', 'Clock Tower', at(3, 8, 30), 3, 1200, 15, 0, 1, 'Suzuki Cultus', 'Students welcome, extra discount!', 'cash', null],
  ];
  const insert = db.prepare(`
    INSERT INTO rides (driver_id, from_city, to_city, pickup_point, dropoff_point, departure_at, seats_total,
      price_per_seat, student_discount_pct, women_only, instant_book, vehicle, notes, payment_methods, payment_details,
      duration_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [email, from, to, ...rest] of rides) {
    insert.run(ids[email], from, to, ...rest, estimateRoute(from, to).duration_minutes);
  }

  db.prepare(`
    INSERT INTO ride_requests (passenger_id, from_city, to_city, earliest_at, latest_at, seats, max_price, notes)
    VALUES (?, 'Islamabad', 'Lahore', ?, ?, 1, 2500, 'Going home for the weekend, one backpack.')`)
    .run(ids['ayesha@example.com'], at(5, 6), at(5, 22));
});

console.log('Seeded demo data. Log in as ahmed@example.com / password123 (or ayesha@, bilal@, sara@, admin@).');
