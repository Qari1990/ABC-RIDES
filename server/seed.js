// Fills the database with demo users and upcoming rides so the app has
// something to show. Every demo account uses the password "password123";
// admin@example.com is an admin.
//
// Run it with `npm run seed`, or set DEMO_SEED=1 so the server seeds itself
// whenever it starts with an empty database (useful on hosts like Render's
// free plan, which wipe the disk on every restart).
const { openDb, transaction } = require('./db');
const { hashPassword } = require('./auth');
const { placeKm, minutesFor } = require('./geo');
const { normalizePhone } = require('./phone');
const { TERMS_VERSION } = require('./terms');

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

function seedDemo(db) {
  const hash = hashPassword('password123');
  transaction(db, () => {
    const ids = {};
    for (const [name, email, phone, type, gender, org] of users) {
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      ids[email] = existing ? existing.id : Number(db.prepare(`
        INSERT INTO users (name, email, phone, password_hash, traveler_type, gender, organization)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(name, email, phone, hash, type, gender, org).lastInsertRowid);
    }
    db.prepare(`UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'`).run();
  db.prepare(`UPDATE users SET terms_version = ?, terms_accepted_at = ? WHERE email LIKE '%@example.com'`).run(TERMS_VERSION, new Date().toISOString());
    // Demo accounts are already through onboarding: phone verified, ID checked, Rs 1,000 in the wallet.
    let cnic = 3520210000001;
    for (const [, email, phone] of users) {
      db.prepare(`UPDATE users SET phone_verified = 1, email_verified = 1, verified_phone = ?, verification_status = 'verified',
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

    // [driver, stops (city, place name), departure, seats, Rs/km, student %, women only, instant, home pickup/drop, vehicle, notes, payment, account]
    const rides = [
      ['ahmed@example.com', [['Lahore', 'Thokar Niaz Baig'], ['Islamabad', 'Faizabad Interchange']], at(1, 7), 3, 8, 20, 0, 1, 1, 'Honda Civic (White)', 'Weekly office commute, AC car, no smoking.', 'cash,jazzcash', 'JazzCash 0300 1234567 (Ahmed Raza)'],
      ['ahmed@example.com', [['Islamabad', 'Faizabad Interchange'], ['Lahore', 'Thokar Niaz Baig']], at(4, 18), 3, 8, 20, 0, 1, 0, 'Honda Civic (White)', 'Friday evening ride back home.', 'cash,jazzcash', 'JazzCash 0300 1234567 (Ahmed Raza)'],
      ['sara@example.com', [['Islamabad', 'G-9 Markaz (Karachi Company)'], ['Peshawar', 'Hayatabad']], at(2, 9), 2, 9, 10, 1, 0, 1, 'Toyota Corolla (Grey)', 'Women only. Light luggage please.', 'cash,easypaisa', 'Easypaisa 0345 1112222'],
      ['bilal@example.com', [['Karachi', 'Sohrab Goth'], ['Hyderabad', 'Qasimabad']], at(1, 16), 4, 7, 25, 0, 0, 0, 'Suzuki Cultus (Red)', null, 'cash', null],
      ['bilal@example.com', [['Lahore', 'Kalma Chowk'], ['Gujranwala', 'City centre (Sheranwala Bagh)'], ['Sialkot', 'City centre (Allama Iqbal Chowk)']], at(3, 8, 30), 3, 7, 15, 0, 1, 1, 'Suzuki Cultus (Red)', 'Students welcome, extra discount! Stopping in Gujranwala.', 'cash', null],
    ];
    const place = db.prepare('SELECT * FROM places WHERE city = ? AND name = ?');
    const insert = db.prepare(`
      INSERT INTO rides (driver_id, from_city, to_city, pickup_point, dropoff_point, departure_at, seats_total,
        price_per_seat, fare_per_km, student_discount_pct, women_only, instant_book, home_pickup, home_drop, home_radius_km,
        vehicle, notes, payment_methods, payment_details, duration_minutes, stops)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [email, route, when, seats, rate, student, women, instant, home, ...rest] of rides) {
      const places = route.map(([city, name]) => place.get(city, name));
      let km = 0;
      const stops = places.map((p, i) => {
        if (i) km += placeKm(db, places[i - 1], p);
        return { place_id: p.id, city: p.city, name: p.name, lat: p.lat, lon: p.lon, km };
      });
      const first = stops[0];
      const last = stops[stops.length - 1];
      insert.run(ids[email], first.city, last.city, first.name, last.name, when, seats, Math.max(10, Math.round((km * rate) / 10) * 10),
        rate, student, women, instant, home, home, home ? 5 : 0, ...rest, minutesFor(km), JSON.stringify(stops));
    }

    db.prepare(`
      INSERT INTO ride_requests (passenger_id, from_city, to_city, earliest_at, latest_at, seats, max_price, notes, from_place_id, to_place_id)
      VALUES (?, 'Islamabad', 'Lahore', ?, ?, 1, 2500, 'Going home for the weekend, one backpack.', ?, ?)`)
      .run(ids['ayesha@example.com'], at(5, 6), at(5, 22), place.get('Islamabad', 'NUST (H-12)').id, place.get('Lahore', 'Thokar Niaz Baig').id);
  });
}

/**
 * Removes the demo accounts and everything tied to them (their rides, the
 * bookings on those rides, chats, reviews...). Real users' wallet records are
 * kept; only their link to a deleted ride or booking is cleared. Returns the
 * number of demo accounts removed.
 */
function removeDemoData(db) {
  const emails = users.map((u) => u[1]);
  const ids = db.prepare(`SELECT id FROM users WHERE email IN (${emails.map(() => '?').join(', ')})`).all(...emails).map((r) => r.id);
  if (!ids.length) return 0;
  const who = `(${ids.map(Number).join(', ')})`; // integer ids from our own query
  const rides = `(SELECT id FROM rides WHERE driver_id IN ${who})`;
  const bookings = `(SELECT id FROM bookings WHERE passenger_id IN ${who} OR ride_id IN ${rides})`;
  transaction(db, () => {
    db.exec(`
      DELETE FROM messages WHERE booking_id IN ${bookings} OR sender_id IN ${who};
      DELETE FROM wallet_transactions WHERE user_id IN ${who};
      UPDATE wallet_transactions SET booking_id = NULL WHERE booking_id IN ${bookings};
      UPDATE wallet_transactions SET ride_id = NULL WHERE ride_id IN ${rides};
      DELETE FROM reviews WHERE ride_id IN ${rides} OR reviewer_id IN ${who} OR reviewee_id IN ${who};
      DELETE FROM reports WHERE reporter_id IN ${who} OR reported_user_id IN ${who} OR ride_id IN ${rides};
      DELETE FROM request_offers WHERE driver_id IN ${who} OR ride_id IN ${rides}
        OR request_id IN (SELECT id FROM ride_requests WHERE passenger_id IN ${who});
      DELETE FROM bookings WHERE passenger_id IN ${who} OR ride_id IN ${rides};
      DELETE FROM rides WHERE driver_id IN ${who};
      DELETE FROM ride_requests WHERE passenger_id IN ${who};
      DELETE FROM notifications WHERE user_id IN ${who};
      DELETE FROM documents WHERE user_id IN ${who};
      DELETE FROM vehicles WHERE user_id IN ${who};
      DELETE FROM phone_codes WHERE user_id IN ${who};
      DELETE FROM reset_codes WHERE user_id IN ${who};
      DELETE FROM topup_requests WHERE user_id IN ${who};
      DELETE FROM push_subscriptions WHERE user_id IN ${who};
      DELETE FROM app_push_tokens WHERE user_id IN ${who};
      DELETE FROM sessions WHERE user_id IN ${who};
      DELETE FROM users WHERE id IN ${who};
    `);
  });
  return ids.length;
}

/** Seeds only when nobody has signed up yet, so real data is never touched. */
function seedIfEmpty(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;
  seedDemo(db);
  return true;
}

module.exports = { seedDemo, seedIfEmpty, removeDemoData };

if (require.main === module) {
  seedDemo(openDb());
  console.log('Seeded demo data. Log in as ahmed@example.com / password123 (or ayesha@, bilal@, sara@, admin@).');
}
