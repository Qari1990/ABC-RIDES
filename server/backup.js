// Keeps the SQLite database and uploaded ID photos safe on hosts that wipe
// the disk on every restart (Render's free plan, for example).
//
// Set DATABASE_URL to any PostgreSQL database (Neon's free plan works well).
// On start-up the latest copy is downloaded before the app opens the database;
// while running, the database is copied there a few seconds after every change
// and once more when the server shuts down. Uploaded files are copied once.
//
// The app itself keeps using SQLite, so nothing else changes. Worst case, a
// crash (not a normal restart or deploy) loses the last few seconds of changes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TABLE = 'abc_rides_files';
const DB_KEY = 'db';
const UPLOAD_PREFIX = 'upload/';

const status = { configured: false, last_saved_at: null, last_error: null, restored: false };

let pool = null;

function backupConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

async function getPool() {
  if (pool) return pool;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 20000 });
  // Free databases drop idle connections; the pool reconnects on next use.
  pool.on('error', (err) => console.warn(`Backup database connection dropped: ${err.message}`));
  await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    name TEXT PRIMARY KEY, data BYTEA NOT NULL, saved_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  return pool;
}

async function save(name, data) {
  await (await getPool()).query(
    `INSERT INTO ${TABLE} (name, data, saved_at) VALUES ($1, $2, now())
     ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, saved_at = now()`, [name, data]);
}

/**
 * Downloads the saved database and uploads, unless a local database already
 * exists (a host with a real disk keeps its own, newer copy).
 */
async function restore({ dbFile, uploadDir }) {
  if (!backupConfigured()) return status;
  status.configured = true;
  const db = await getPool();
  if (!fs.existsSync(dbFile)) {
    const { rows } = await db.query(`SELECT data, saved_at FROM ${TABLE} WHERE name = $1`, [DB_KEY]);
    if (rows.length) {
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      for (const extra of ['-wal', '-shm']) fs.rmSync(dbFile + extra, { force: true });
      fs.writeFileSync(dbFile, rows[0].data);
      status.restored = true;
      status.last_saved_at = rows[0].saved_at.toISOString();
    }
  }
  const { rows: files } = await db.query(`SELECT name FROM ${TABLE} WHERE name LIKE $1`, [`${UPLOAD_PREFIX}%`]);
  fs.mkdirSync(uploadDir, { recursive: true });
  for (const { name } of files) {
    const target = path.join(uploadDir, path.basename(name.slice(UPLOAD_PREFIX.length)));
    if (fs.existsSync(target)) continue;
    const { rows } = await db.query(`SELECT data FROM ${TABLE} WHERE name = $1`, [name]);
    if (rows.length) fs.writeFileSync(target, rows[0].data);
  }
  return status;
}

/**
 * Copies the database to the backup every few seconds when it has changed,
 * and mirrors the upload folder. Returns flush(), to call before shutting down.
 */
function startBackups(sqlite, { uploadDir, intervalMs = 10000 }) {
  if (!backupConfigured()) return { flush: async () => {} };
  status.configured = true;
  let savedChanges = null;
  let savedUploads = null;
  let running = null;

  async function snapshotDb() {
    // total_changes() counts every row this connection has written; the app
    // uses a single connection, so an unchanged count means nothing to save.
    const changes = sqlite.prepare('SELECT total_changes() AS n').get().n;
    if (changes === savedChanges) return;
    const tmp = path.join(os.tmpdir(), `abc-rides-backup-${process.pid}.db`);
    fs.rmSync(tmp, { force: true });
    // A consistent, compacted copy even while the app keeps running.
    sqlite.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    try {
      await save(DB_KEY, fs.readFileSync(tmp));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    savedChanges = changes;
    status.last_saved_at = new Date().toISOString();
  }

  async function mirrorUploads() {
    const db = await getPool();
    if (!savedUploads) {
      const { rows } = await db.query(`SELECT name FROM ${TABLE} WHERE name LIKE $1`, [`${UPLOAD_PREFIX}%`]);
      savedUploads = new Set(rows.map((r) => r.name.slice(UPLOAD_PREFIX.length)));
    }
    const local = new Set(fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : []);
    for (const file of local) {
      if (savedUploads.has(file)) continue;
      await save(UPLOAD_PREFIX + file, fs.readFileSync(path.join(uploadDir, file)));
      savedUploads.add(file);
    }
    // Photos removed here (e.g. a deleted account) are removed from the backup too.
    for (const file of savedUploads) {
      if (local.has(file)) continue;
      await db.query(`DELETE FROM ${TABLE} WHERE name = $1`, [UPLOAD_PREFIX + file]);
      savedUploads.delete(file);
    }
  }

  function run() {
    if (!running) {
      running = (async () => {
        try {
          await snapshotDb();
          await mirrorUploads();
          status.last_error = null;
        } catch (err) {
          status.last_error = err.message;
          console.error(`Backup failed: ${err.message}`);
        } finally {
          running = null;
        }
      })();
    }
    return running;
  }

  setInterval(run, intervalMs).unref();
  run();
  return {
    async flush() {
      if (running) await running;
      await run();
    },
  };
}

async function closeBackups() {
  if (pool) await pool.end().catch(() => {});
  pool = null;
}

module.exports = { backupConfigured, restore, startBackups, closeBackups, backupStatus: () => ({ ...status }) };
