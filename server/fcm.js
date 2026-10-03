// Push notifications to the Android app through Firebase Cloud Messaging
// (free). Set FIREBASE_SERVICE_ACCOUNT to the service account JSON from
// Firebase console → Project settings → Service accounts → Generate new
// private key (paste the whole JSON, or the same JSON base64-encoded).
// No extra packages: the OAuth token is a JWT signed with Node's crypto.
const crypto = require('node:crypto');

let account = null;
let accountSource = null;
let cachedToken = null; // { value, expires }

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw) return null;
  if (raw === accountSource) return account;
  accountSource = raw;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const json = JSON.parse(text);
    account = json.client_email && json.private_key && json.project_id ? json : null;
  } catch {
    account = null;
  }
  if (!account) console.error('FIREBASE_SERVICE_ACCOUNT is not a valid service account JSON');
  cachedToken = null;
  return account;
}

const fcmConfigured = () => Boolean(serviceAccount());
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60000) return cachedToken.value;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const tokenUrl = process.env.GOOGLE_TOKEN_URL || sa.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUrl, iat: now, exp: now + 3600,
  })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Google sign-in failed (${res.status})`);
  cachedToken = { value: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

/**
 * Sends a data message to one app install. The app shows the notification
 * itself (so it looks the same whether the app is open or closed).
 * Resolves to 'ok', 'gone' (token no longer valid: delete it) or throws.
 */
async function sendFcm(token, { title, body, link }) {
  const sa = serviceAccount();
  const base = process.env.FCM_API_URL || 'https://fcm.googleapis.com';
  const res = await fetch(`${base}/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        data: { title: String(title || 'ABC Rides'), body: String(body || ''), link: String(link || '/') },
        android: { priority: 'HIGH', ttl: '86400s' },
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.ok) return 'ok';
  const err = await res.json().catch(() => ({}));
  const code = JSON.stringify(err);
  if (res.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(code)
    || (res.status === 400 && /INVALID_ARGUMENT/.test(code) && /token/i.test(code))) return 'gone';
  throw new Error(`FCM answered ${res.status}`);
}

module.exports = { fcmConfigured, sendFcm };
