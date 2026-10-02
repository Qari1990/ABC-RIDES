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
  phone_verified  INTEGER NOT NULL DEFAULT 0,
  verified_phone  TEXT,
  cnic            TEXT,
  student_status  TEXT NOT NULL DEFAULT 'none',
  driver_status   TEXT NOT NULL DEFAULT 'none',
  driver_note     TEXT,
  licence_number  TEXT,
  reliability     INTEGER NOT NULL DEFAULT 100,
  wallet_balance  INTEGER NOT NULL DEFAULT 0,
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
  stops                 TEXT,
  fare_per_km           INTEGER,
  home_pickup           INTEGER NOT NULL DEFAULT 0,
  home_drop             INTEGER NOT NULL DEFAULT 0,
  home_radius_km        INTEGER NOT NULL DEFAULT 0,
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
  driver_fee      INTEGER NOT NULL DEFAULT 0,
  passenger_fee   INTEGER NOT NULL DEFAULT 0,
  confirmed_at    TEXT,
  board_stop      INTEGER,
  alight_stop     INTEGER,
  segment_km      INTEGER,
  home_pickup     TEXT,
  home_drop       TEXT,
  home_charge     INTEGER NOT NULL DEFAULT 0,
  commission_discount_pct INTEGER NOT NULL DEFAULT 0,
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

-- Photos uploaded during onboarding (CNIC, selfie, licence, vehicle...).
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,
  file        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS documents_user ON documents (user_id, kind);

CREATE TABLE IF NOT EXISTS vehicles (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id),
  make        TEXT NOT NULL,
  model       TEXT NOT NULL,
  year        INTEGER NOT NULL,
  color       TEXT NOT NULL,
  plate       TEXT NOT NULL,
  seats       INTEGER NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One-time codes for "forgot password" (sent by SMS).
CREATE TABLE IF NOT EXISTS reset_codes (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id),
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phone_codes (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id),
  code_hash     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT NOT NULL,
  window_start  TEXT NOT NULL,
  sent_count    INTEGER NOT NULL DEFAULT 1
);

-- Popular pickup and drop-off points (seeded from places-data.js, editable by admins).
CREATE TABLE IF NOT EXISTS places (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  city     TEXT NOT NULL,
  name     TEXT NOT NULL,
  lat      REAL NOT NULL,
  lon      REAL NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1,
  UNIQUE (city, name)
);

-- Road distances between city centres from a map routing service.
CREATE TABLE IF NOT EXISTS route_distances (
  pair        TEXT PRIMARY KEY,
  km          INTEGER NOT NULL,
  source      TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Browsers that asked for push notifications (Web Push).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Road shapes between two points, fetched once from the routing service.
CREATE TABLE IF NOT EXISTS route_shapes (
  pair        TEXT PRIMARY KEY,   -- "lat,lon|lat,lon" rounded to 4 decimals
  points      TEXT NOT NULL,      -- JSON [[lat, lon], ...]
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Errors from phones/browsers and the server, shown to admins.
CREATE TABLE IF NOT EXISTS error_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL CHECK (source IN ('app', 'server')),
  message     TEXT NOT NULL,
  detail      TEXT,
  url         TEXT,
  user_id     INTEGER,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Admin-controlled policy (fees, booking mode, onboarding requirements).
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Every change to a wallet balance, newest last. amount is negative for charges.
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  amount         INTEGER NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('topup', 'commission', 'fee', 'refund', 'adjustment')),
  booking_id     INTEGER REFERENCES bookings(id),
  ride_id        INTEGER REFERENCES rides(id),
  note           TEXT,
  balance_after  INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS wallet_transactions_user ON wallet_transactions (user_id, id);

CREATE TABLE IF NOT EXISTS topup_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  amount       INTEGER NOT NULL CHECK (amount > 0),
  method       TEXT NOT NULL,
  reference    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at  TEXT
);
`;

// Indexes on columns that older databases only get from migrate().
const POST_MIGRATE = `
CREATE UNIQUE INDEX IF NOT EXISTS users_cnic ON users (cnic) WHERE cnic IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_verified_phone ON users (verified_phone) WHERE verified_phone IS NOT NULL;
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves
// older databases untouched, so add any missing columns here.
const ADDED_COLUMNS = {
  ride_requests: {
    from_place_id: 'INTEGER REFERENCES places(id)',
    to_place_id: 'INTEGER REFERENCES places(id)',
  },
  users: {
    role: `TEXT NOT NULL DEFAULT 'user'`,
    suspended: 'INTEGER NOT NULL DEFAULT 0',
    verification_status: `TEXT NOT NULL DEFAULT 'none'`,
    verification_doc_type: 'TEXT',
    verification_file: 'TEXT',
    verification_note: 'TEXT',
    emergency_name: 'TEXT',
    emergency_phone: 'TEXT',
    phone_verified: 'INTEGER NOT NULL DEFAULT 0',
    verified_phone: 'TEXT',
    cnic: 'TEXT',
    student_status: `TEXT NOT NULL DEFAULT 'none'`,
    driver_status: `TEXT NOT NULL DEFAULT 'none'`,
    driver_note: 'TEXT',
    licence_number: 'TEXT',
    reliability: 'INTEGER NOT NULL DEFAULT 100',
    wallet_balance: 'INTEGER NOT NULL DEFAULT 0',
  },
  bookings: {
    driver_fee: 'INTEGER NOT NULL DEFAULT 0',
    passenger_fee: 'INTEGER NOT NULL DEFAULT 0',
    confirmed_at: 'TEXT',
    board_stop: 'INTEGER',
    alight_stop: 'INTEGER',
    segment_km: 'INTEGER',
    home_pickup: 'TEXT',
    home_drop: 'TEXT',
    home_charge: 'INTEGER NOT NULL DEFAULT 0',
    commission_discount_pct: 'INTEGER NOT NULL DEFAULT 0',
  },
  rides: {
    payment_methods: `TEXT NOT NULL DEFAULT 'cash'`,
    payment_details: 'TEXT',
    duration_minutes: 'INTEGER',
    stops: 'TEXT',
    fare_per_km: 'INTEGER',
    home_pickup: 'INTEGER NOT NULL DEFAULT 0',
    home_drop: 'INTEGER NOT NULL DEFAULT 0',
    home_radius_km: 'INTEGER NOT NULL DEFAULT 0',
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

// Loads the built-in popular places the first time.
// Adds built-in places that are missing, so new versions bring new points to
// existing databases. Places an admin removed stay removed (they are only
// marked inactive, so INSERT OR IGNORE skips them).
function seedPlaces(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO places (city, name, lat, lon) VALUES (?, ?, ?, ?)');
  for (const p of require('./places-data')) insert.run(...p);
}

function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'abc-rides.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  db.exec(POST_MIGRATE);
  seedPlaces(db);
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
