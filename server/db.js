const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  traveler_type   TEXT NOT NULL CHECK (traveler_type IN ('professional', 'student', 'traveler')),
  gender          TEXT CHECK (gender IN ('male', 'female', 'other')),
  organization    TEXT,
  bio             TEXT,
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  suspended       INTEGER NOT NULL DEFAULT 0,
  verification_status TEXT NOT NULL DEFAULT 'none' CHECK (verification_status IN ('none', 'pending', 'verified', 'rejected')),
  verification_doc_type TEXT,
  verification_file TEXT,
  verification_note TEXT,
  emergency_name  TEXT,
  emergency_phone TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rides (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id             INTEGER NOT NULL REFERENCES users(id),
  from_city             TEXT NOT NULL,
  to_city               TEXT NOT NULL,
  pickup_point          TEXT,
  dropoff_point         TEXT,
  departure_at          TEXT NOT NULL,
  seats_total           INTEGER NOT NULL CHECK (seats_total BETWEEN 1 AND 8),
  price_per_seat        INTEGER NOT NULL CHECK (price_per_seat >= 0),
  student_discount_pct  INTEGER NOT NULL DEFAULT 0 CHECK (student_discount_pct BETWEEN 0 AND 100),
  women_only            INTEGER NOT NULL DEFAULT 0,
  instant_book          INTEGER NOT NULL DEFAULT 0,
  vehicle               TEXT,
  notes                 TEXT,
  payment_methods       TEXT NOT NULL DEFAULT 'cash',
  payment_details       TEXT,
  duration_minutes      INTEGER,
  status                TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS rides_search ON rides (from_city, to_city, departure_at);

CREATE TABLE IF NOT EXISTS bookings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id         INTEGER NOT NULL REFERENCES rides(id),
  passenger_id    INTEGER NOT NULL REFERENCES users(id),
  seats           INTEGER NOT NULL CHECK (seats >= 1),
  price_per_seat  INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled')),
  message         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS bookings_ride ON bookings (ride_id);
CREATE INDEX IF NOT EXISTS bookings_passenger ON bookings (passenger_id);

CREATE TABLE IF NOT EXISTS reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id      INTEGER NOT NULL REFERENCES rides(id),
  reviewer_id  INTEGER NOT NULL REFERENCES users(id),
  reviewee_id  INTEGER NOT NULL REFERENCES users(id),
  rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (ride_id, reviewer_id, reviewee_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, id);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id),
  sender_id   INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS messages_booking ON messages (booking_id, id);

CREATE TABLE IF NOT EXISTS ride_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  passenger_id  INTEGER NOT NULL REFERENCES users(id),
  from_city     TEXT NOT NULL,
  to_city       TEXT NOT NULL,
  earliest_at   TEXT NOT NULL,
  latest_at     TEXT NOT NULL,
  seats         INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 8),
  max_price     INTEGER,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS ride_requests_route ON ride_requests (from_city, to_city, latest_at);

CREATE TABLE IF NOT EXISTS reports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id       INTEGER NOT NULL REFERENCES users(id),
  reported_user_id  INTEGER NOT NULL REFERENCES users(id),
  ride_id           INTEGER REFERENCES rides(id),
  reason            TEXT NOT NULL,
  details           TEXT,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves
// older databases untouched, so add any missing columns here.
const ADDED_COLUMNS = {
  users: {
    role: `TEXT NOT NULL DEFAULT 'user'`,
    suspended: 'INTEGER NOT NULL DEFAULT 0',
    verification_status: `TEXT NOT NULL DEFAULT 'none'`,
    verification_doc_type: 'TEXT',
    verification_file: 'TEXT',
    verification_note: 'TEXT',
    emergency_name: 'TEXT',
    emergency_phone: 'TEXT',
  },
  rides: {
    payment_methods: `TEXT NOT NULL DEFAULT 'cash'`,
    payment_details: 'TEXT',
    duration_minutes: 'INTEGER',
  },
};

function migrate(db) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'abc-rides.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Runs fn inside a transaction; rolls back if it throws.
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, transaction };
