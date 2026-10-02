const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { adminEmails } = require('./routes/users');
const { seedIfEmpty, removeDemoData } = require('./seed');
const { restore, startBackups, closeBackups } = require('./backup');

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'abc-rides.db');
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');

async function main() {
  // With DATABASE_URL set, bring back the saved data before opening it.
  const saved = await restore({ dbFile, uploadDir });
  if (saved.configured) {
    console.log(saved.restored ? `Restored the database saved at ${saved.last_saved_at}.` : 'Backups on; no saved database yet.');
  }

  const db = openDb(dbFile);

  // Going live: REMOVE_DEMO_DATA=1 deletes the demo accounts and their rides.
  if (/^(1|true|yes)$/i.test(process.env.REMOVE_DEMO_DATA || '')) {
    const removed = removeDemoData(db);
    if (removed) console.log(`Removed ${removed} demo accounts and their rides (REMOVE_DEMO_DATA is on).`);
  } else if (/^(1|true|yes)$/i.test(process.env.DEMO_SEED || '') && seedIfEmpty(db)) {
    console.log('Empty database: loaded the demo users and rides (DEMO_SEED is on).');
  }

  // Promote accounts listed in ADMIN_EMAILS that registered before the list was set.
  for (const email of adminEmails()) {
    db.prepare(`UPDATE users SET role = 'admin' WHERE email = ?`).run(email);
  }

  const backups = startBackups(db, { uploadDir });
  const server = createApp(db, { uploadDir }).listen(port, () => {
    console.log(`ABC Rides running at http://localhost:${port}`);
    keepAwake(process.env.KEEP_AWAKE_URL || process.env.RENDER_EXTERNAL_URL);
  });

  // Hosts send SIGTERM before a restart or deploy: save the latest changes first.
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      server.close();
      await backups.flush();
      await closeBackups();
      process.exit(0);
    });
  }
}

// Free hosting plans (Render's included) put the server to sleep after ~15
// minutes without visitors, and the next visitor waits ~50 seconds for it to
// wake up. Calling our own public address every 10 minutes keeps it awake.
// Render sets RENDER_EXTERNAL_URL itself; set KEEP_AWAKE=0 to turn this off.
function keepAwake(baseUrl) {
  if (!baseUrl || /^(0|false|no)$/i.test(process.env.KEEP_AWAKE || '')) return;
  const url = baseUrl.replace(/\/+$/, '') + '/api/health';
  const ping = () => fetch(url).catch((err) => console.warn(`Keep-awake ping failed: ${err.message}`));
  setInterval(ping, 10 * 60 * 1000).unref();
  console.log(`Keeping the server awake by calling ${url} every 10 minutes.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
