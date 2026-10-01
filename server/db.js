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
`;

function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'abc-rides.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
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
