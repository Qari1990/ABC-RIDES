const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { startServer, rideBody } = require('./helpers');

test('Android push through Firebase: signed sign-in, data message, dead tokens removed', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const tokenRequests = [];
  const messages = [];
  const google = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') {
        const jwt = new URLSearchParams(body).get('assertion');
        const [h, p, sig] = jwt.split('.');
        tokenRequests.push({ valid: crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url')), claims: JSON.parse(Buffer.from(p, 'base64url')) });
        return res.end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
      }
      const msg = JSON.parse(body).message;
      messages.push({ url: req.url, auth: req.headers.authorization, ...msg });
      if (msg.token.startsWith('dead')) { res.statusCode = 404; return res.end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })); }
      res.end(JSON.stringify({ name: 'projects/abc/messages/1' }));
    });
  }).listen(0);
  await new Promise((r) => google.once('listening', r));
  const base = `http://127.0.0.1:${google.address().port}`;
  Object.assign(process.env, {
    FIREBASE_SERVICE_ACCOUNT: Buffer.from(JSON.stringify({
      project_id: 'abc-rides-test', client_email: 'push@abc-rides-test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    })).toString('base64'),
    GOOGLE_TOKEN_URL: `${base}/token`,
    FCM_API_URL: base,
  });
  const srv = await startServer();
  try {
    assert.equal((await srv.call('GET', '/settings')).body.app_push, true);
    const driver = await srv.register();
    const rider = await srv.register({ traveler_type: 'traveler' });
    const live = `live-token-${'x'.repeat(40)}`;
    const dead = `dead-token-${'x'.repeat(40)}`;
    assert.equal((await srv.call('POST', '/me/push-app', { token: driver.token, body: { token: 'short' } })).status, 400);
    for (const t of [live, dead]) assert.equal((await srv.call('POST', '/me/push-app', { token: driver.token, body: { token: t } })).status, 204);

    const [ride] = (await srv.call('POST', '/rides', { token: driver.token, body: rideBody() })).body;
    await srv.call('POST', `/rides/${ride.id}/bookings`, { token: rider.token, body: { seats: 1 } });
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(tokenRequests.length >= 1 && tokenRequests.every((t) => t.valid), 'JWT signed with the service account key');
    assert.equal(tokenRequests[0].claims.iss, 'push@abc-rides-test.iam.gserviceaccount.com');
    const toLive = messages.find((m) => m.token === live);
    assert.equal(toLive.url, '/v1/projects/abc-rides-test/messages:send');
    assert.equal(toLive.auth, 'Bearer ya29.test');
    assert.match(toLive.data.title, /request/i);
    assert.equal(toLive.android.priority, 'HIGH');
    assert.deepEqual(srv.db.prepare('SELECT token FROM app_push_tokens').all().map((r) => r.token), [live], 'dead token removed');
  } finally {
    for (const k of ['FIREBASE_SERVICE_ACCOUNT', 'GOOGLE_TOKEN_URL', 'FCM_API_URL']) delete process.env[k];
    srv.close();
    google.close();
  }
});
