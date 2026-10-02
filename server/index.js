const { openDb } = require('./db');
const { createApp } = require('./app');
const { adminEmails } = require('./routes/users');
const { seedIfEmpty } = require('./seed');

const port = Number(process.env.PORT) || 3000;
const db = openDb();

if (/^(1|true|yes)$/i.test(process.env.DEMO_SEED || '') && seedIfEmpty(db)) {
  console.log('Empty database: loaded the demo users and rides (DEMO_SEED is on).');
}

// Promote accounts listed in ADMIN_EMAILS that registered before the list was set.
for (const email of adminEmails()) {
  db.prepare(`UPDATE users SET role = 'admin' WHERE email = ?`).run(email);
}

const app = createApp(db);
app.listen(port, () => {
  console.log(`ABC Rides running at http://localhost:${port}`);
  keepAwake(process.env.KEEP_AWAKE_URL || process.env.RENDER_EXTERNAL_URL);
});

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
