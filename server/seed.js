// Fills the database with demo users and upcoming rides so the app has
// something to show. Every demo account uses the password "password123".
const { openDb, transaction } = require('./db');
const { hashPassword } = require('./auth');

const db = openDb();
const hash = hashPassword('password123');

const users = [
  ['Ahmed Raza', 'ahmed@example.com', '+92 300 1234567', 'professional', 'male', 'Software engineer, Systems Ltd'],
  ['Ayesha Khan', 'ayesha@example.com', '+92 301 7654321', 'student', 'female', 'NUST Islamabad'],
  ['Bilal Hussain', 'bilal@example.com', '+92 333 5550000', 'traveler', 'male', null],
  ['Sara Malik', 'sara@example.com', '+92 345 1112222', 'professional', 'female', 'Doctor, Shifa International'],
];

function at(daysAhead, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, minute, 0, 0);
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

  const rides = [
    ['ahmed@example.com', 'Lahore', 'Islamabad', 'Thokar Niaz Baig', 'Faizabad', at(1, 7), 3, 2500, 20, 0, 1, 'Honda Civic (white)', 'Weekly office commute, AC car, no smoking.'],
    ['ahmed@example.com', 'Islamabad', 'Lahore', 'Faizabad', 'Thokar Niaz Baig', at(4, 18), 3, 2500, 20, 0, 1, 'Honda Civic (white)', 'Friday evening ride back home.'],
    ['sara@example.com', 'Islamabad', 'Peshawar', 'G-9 Markaz', 'Hayatabad', at(2, 9), 2, 1800, 10, 1, 0, 'Toyota Corolla', 'Women only. Light luggage please.'],
    ['bilal@example.com', 'Karachi', 'Hyderabad', 'Sohrab Goth', 'Qasimabad', at(1, 16), 4, 900, 25, 0, 0, 'Suzuki Cultus', null],
    ['bilal@example.com', 'Lahore', 'Faisalabad', 'Kalma Chowk', 'Clock Tower', at(3, 8, 30), 3, 1200, 15, 0, 1, 'Suzuki Cultus', 'Students welcome, extra discount!'],
  ];
  const insert = db.prepare(`
    INSERT INTO rides (driver_id, from_city, to_city, pickup_point, dropoff_point, departure_at, seats_total,
      price_per_seat, student_discount_pct, women_only, instant_book, vehicle, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [email, ...rest] of rides) insert.run(ids[email], ...rest);
});

console.log('Seeded demo data. Log in as ahmed@example.com / password123 (or ayesha@, bilal@, sara@).');
