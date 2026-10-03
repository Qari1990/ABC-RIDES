const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, inHours, rideBody } = require('./helpers');
const { runLifecycle } = require('../server/lifecycle');

let db, call, register, close;
before(async () => { ({ db, call, register, close } = await startServer()); });
after(() => close());

const reliability = (u) => db.prepare('SELECT reliability FROM users WHERE id = ?').get(u.user.id).reliability;
const lastNote = (u) => db.prepare('SELECT title FROM notifications WHERE user_id = ? ORDER BY id DESC').get(u.user.id).title;

test('rides expire or complete by themselves; reviews move reliability by the star rating', async () => {
  const driver = await register();
  const rider = await register({ traveler_type: 'traveler' });
  const waiting = await register({ traveler_type: 'traveler' });
  const [empty] = (await call('POST', '/rides', { token: driver.token, body: rideBody() })).body;
  const [full] = (await call('POST', '/rides', { token: driver.token, body: rideBody({ instant_book: true, duration_minutes: 120 }) })).body;
  const [pendingOnly] = (await call('POST', '/rides', { token: driver.token, body: rideBody() })).body;
  assert.equal((await call('POST', `/rides/${full.id}/bookings`, { token: rider.token, body: { seats: 1 } })).body.status, 'confirmed');
  assert.equal((await call('POST', `/rides/${pendingOnly.id}/bookings`, { token: waiting.token, body: { seats: 1 } })).body.status, 'pending');
  const req = (await call('POST', '/ride-requests', { token: waiting.token, body: { from_city: 'Lahore', to_city: 'Multan', earliest_at: inHours(1), latest_at: inHours(2) } })).body;

  // Two hours from now: nothing has happened yet beyond the empty rides expiring? Not yet departed.
  assert.deepEqual(runLifecycle(db), { expired: 0, completed: 0, lapsed: 0, closed: 0 });

  // Jump ahead: departure was 24 h from now, trip 2 h, auto-complete after 6 h.
  const later = new Date(Date.now() + (24 + 1) * 36e5);
  const first = runLifecycle(db, later);
  assert.equal(first.expired, 2, 'the empty ride and the one with only an unanswered request');
  assert.equal(first.closed, 1, 'the passenger request whose window passed');
  assert.equal(db.prepare('SELECT status, ended_reason FROM rides WHERE id = ?').get(empty.id).ended_reason, 'expired');
  assert.equal(db.prepare('SELECT status FROM bookings WHERE ride_id = ?').get(pendingOnly.id).status, 'rejected');
  assert.match(lastNote(waiting), /lapsed/);
  assert.equal(db.prepare('SELECT status FROM ride_requests WHERE id = ?').get(req.id).status, 'closed');
  assert.equal(db.prepare('SELECT status FROM rides WHERE id = ?').get(full.id).status, 'scheduled', 'still within the grace time');

  const before = { driver: reliability(driver), rider: reliability(rider) };
  const done = runLifecycle(db, new Date(Date.now() + (24 + 2 + 7) * 36e5));
  assert.equal(done.completed, 1);
  const ride = db.prepare('SELECT status, ended_reason FROM rides WHERE id = ?').get(full.id);
  assert.deepEqual({ ...ride }, { status: 'completed', ended_reason: 'auto_completed' });
  assert.match(lastNote(rider), /How was your trip/);
  assert.match(lastNote(driver), /rate your passengers/);

  // Reviews: 5 stars +1, 1 star -5 (defaults).
  db.prepare('UPDATE users SET reliability = 80 WHERE id IN (?, ?)').run(driver.user.id, rider.user.id);
  assert.equal((await call('POST', `/rides/${full.id}/reviews`, { token: rider.token, body: { reviewee_id: driver.user.id, rating: 5, comment: 'Smooth drive' } })).body.reliability_change, 1);
  assert.equal(reliability(driver), 81);
  assert.equal((await call('POST', `/rides/${full.id}/reviews`, { token: driver.token, body: { reviewee_id: rider.user.id, rating: 1 } })).status, 201);
  assert.equal(reliability(rider), 75);
  assert.match(lastNote(rider), /rated you ★/);
  assert.ok(before.driver >= 0);
});
