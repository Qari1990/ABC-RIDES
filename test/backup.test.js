// Runs only when a PostgreSQL database is available, e.g.
//   TEST_DATABASE_URL=postgres://postgres@/postgres?host=/tmp&port=5433 npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL;

test('database and uploads survive a wiped disk', { skip: !url && 'set TEST_DATABASE_URL to run' }, async () => {
  process.env.DATABASE_URL = url;
  const { openDb } = require('../server/db');
  const { restore, startBackups, closeBackups } = require('../server/backup');
  const { Client } = require('pg');
  const pg = new Client({ connectionString: url });
  await pg.connect();
  await pg.query('DROP TABLE IF EXISTS abc_rides_files');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abc-backup-'));
  const dbFile = path.join(dir, 'a.db');
  const uploadDir = path.join(dir, 'up');

  assert.equal((await restore({ dbFile, uploadDir })).restored, false);
  const db = openDb(dbFile);
  db.prepare(`INSERT INTO users (name, email, phone, password_hash, traveler_type) VALUES ('Kept', 'kept@test.pk', '1', 'x', 'student')`).run();
  fs.writeFileSync(path.join(uploadDir, 'cnic.jpg'), 'photo');
  const backups = startBackups(db, { uploadDir, intervalMs: 60000 });
  await backups.flush();
  db.close();

  // The host wipes the disk; the next start brings everything back.
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal((await restore({ dbFile, uploadDir })).restored, true);
  const again = openDb(dbFile);
  assert.equal(again.prepare('SELECT name FROM users WHERE email = ?').get('kept@test.pk').name, 'Kept');
  assert.equal(fs.readFileSync(path.join(uploadDir, 'cnic.jpg'), 'utf8'), 'photo');

  // A deleted photo leaves the backup too.
  fs.rmSync(path.join(uploadDir, 'cnic.jpg'));
  await startBackups(again, { uploadDir, intervalMs: 60000 }).flush();
  const { rows } = await pg.query(`SELECT name FROM abc_rides_files WHERE name LIKE 'upload/%'`);
  assert.deepEqual(rows, []);

  again.close();
  await pg.query('DROP TABLE abc_rides_files');
  await pg.end();
  await closeBackups();
  fs.rmSync(dir, { recursive: true, force: true });
});
