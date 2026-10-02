// Push notifications to browsers and installed web apps (Chrome, Edge,
// Firefox, Safari 16.4+ when added to the home screen), using the free Web
// Push standard: no Firebase or other account needed. The server's VAPID keys
// are created on first start and kept in the database.
//
// The Android app gets the same notifications through Firebase (see fcm.js).
const webpush = require('web-push');
const { fcmConfigured, sendFcm } = require('./fcm');

let configured = null;

function vapidKeys(db) {
  if (configured) return configured;
  db.exec('CREATE TABLE IF NOT EXISTS app_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  let row = db.prepare(`SELECT value FROM app_secrets WHERE key = 'vapid'`).get();
  if (!row) {
    db.prepare(`INSERT OR IGNORE INTO app_secrets (key, value) VALUES ('vapid', ?)`).run(JSON.stringify(webpush.generateVAPIDKeys()));
    row = db.prepare(`SELECT value FROM app_secrets WHERE key = 'vapid'`).get();
  }
  configured = JSON.parse(row.value);
  webpush.setVapidDetails(process.env.PUSH_CONTACT || 'mailto:support@abc-rides.invalid', configured.publicKey, configured.privateKey);
  return configured;
}

function saveSubscription(db, userId, sub) {
  const ok = sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000
    && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
  if (!ok) return false;
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(userId, sub.endpoint, sub.keys.p256dh.slice(0, 200), sub.keys.auth.slice(0, 100));
  return true;
}

/** Sends a notification to all of a user's devices, in the background. */
function sendPush(db, userId, { title, body, link }) {
  // Android app installs, through Firebase.
  if (fcmConfigured()) {
    for (const t of db.prepare('SELECT * FROM app_push_tokens WHERE user_id = ?').all(userId)) {
      sendFcm(t.token, { title, body, link })
        .then((r) => { if (r === 'gone') db.prepare('DELETE FROM app_push_tokens WHERE id = ?').run(t.id); })
        .catch((err) => console.warn(`App push failed: ${err.message}`));
    }
  }
  // Browsers and home-screen web apps, through Web Push.
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  if (!subs.length) return;
  vapidKeys(db);
  const payload = JSON.stringify({ title, body: body || '', link: link || '/' });
  for (const s of subs) {
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 24 * 3600 })
      .catch((err) => {
        // 404/410: the browser dropped the subscription (app uninstalled, permission revoked).
        if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        else console.warn(`Push failed (${err.statusCode || err.message})`);
      });
  }
}

function saveAppToken(db, userId, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return false;
  db.prepare(`INSERT INTO app_push_tokens (user_id, token) VALUES (?, ?)
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id`).run(userId, token);
  return true;
}

module.exports = { vapidKeys, saveSubscription, saveAppToken, sendPush };
