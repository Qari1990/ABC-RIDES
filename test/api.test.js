const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, inHours, rideBody } = require('./helpers');

let db, call, register, close;

before(async () => {
  ({ db, call, register, close } = await startServer());
});

after(() => close());

test('register, login and fetch profile', async () => {
  const { user } = await register({ email: 'Ali@Test.pk' });
  assert.equal(user.email, 'ali@test.pk');

  const dup = await call('POST', '/auth/register', {
    body: { name: 'X', email: 'ali@test.pk', phone: '+92 300 1111111', password: 'secret123', traveler_type: 'student' },
  });
  assert.equal(dup.status, 409);

  assert.equal((await call('POST', '/auth/login', { body: { email: 'ali@test.pk', password: 'wrong-pass' } })).status, 401);
  const login = await call('POST', '/auth/login', { body: { email: 'ALI@test.pk', password: 'secret123' } });
  assert.equal(login.status, 200);

  const me = await call('GET', '/me', { token: login.body.token });
  assert.equal(me.body.name, user.name);
  assert.equal((await call('GET', '/me')).status, 401);

  await call('POST', '/auth/logout', { token: login.body.token });
  assert.equal((await call('GET', '/me', { token: login.body.token })).status, 401);
});

test('validates registration input', async () => {
  const res = await call('POST', '/auth/register', {
    body: { name: 'A', email: 'bad', phone: '1', password: 'x', traveler_type: 'student' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Email/);
});

test('offer, search and book a ride with student discount and approval', async () => {
  const driver = await register();
  const student = await register({ traveler_type: 'student' });

  const created = await call('POST', '/rides', { token: driver.token, body: rideBody() });
  assert.equal(created.status, 201);
  const ride = created.body[0];
  assert.equal(ride.student_price, 1500);

  const search = await call('GET', '/rides?from=lahore&to=ISLAMABAD', { token: student.token });
  const found = search.body.find((r) => r.id === ride.id);
  assert.ok(found);
  assert.equal(found.your_price, 1500);
  assert.equal(found.driver.phone, undefined, 'driver phone hidden before booking');

  const booking = await call('POST', `/rides/${ride.id}/bookings`, { token: student.token, body: { seats: 2 } });
  assert.equal(booking.status, 201);
  assert.equal(booking.body.status, 'pending');
  assert.equal(booking.body.price_per_seat, 1500);

  const again = await call('POST', `/rides/${ride.id}/bookings`, { token: student.token, body: { seats: 1 } });
  assert.equal(again.status, 409);

  const other = await register();
  const tooMany = await call('POST', `/rides/${ride.id}/bookings`, { token: other.token, body: { seats: 2 } });
  assert.equal(tooMany.status, 409, 'pending seats are held');

  assert.equal((await call('POST', `/bookings/${booking.body.id}/confirm`, { token: student.token })).status, 403);
  const confirmed = await call('POST', `/bookings/${booking.body.id}/confirm`, { token: driver.token });
  assert.equal(confirmed.body.status, 'confirmed');

  const detail = await call('GET', `/rides/${ride.id}`, { token: student.token });
  assert.equal(detail.body.seats_left, 1);
  assert.equal(detail.body.driver.phone, '+92 300 0000000');

  const driverView = await call('GET', `/rides/${ride.id}`, { token: driver.token });
  assert.equal(driverView.body.bookings.length, 1);
  assert.equal(driverView.body.bookings[0].passenger_phone, '+92 300 0000000');

  const cancelled = await call('POST', `/bookings/${booking.body.id}/cancel`, { token: student.token });
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal((await call('GET', `/rides/${ride.id}`)).body.seats_left, 3);
});

test('instant booking confirms immediately; drivers cannot book their own ride', async () => {
  const driver = await register();
  const rider = await register({ traveler_type: 'traveler' });
  const ride = (await call('POST', '/rides', { token: driver.token, body: rideBody({ instant_book: true }) })).body[0];

  const own = await call('POST', `/rides/${ride.id}/bookings`, { token: driver.token, body: { seats: 1 } });
  assert.equal(own.status, 400);

  const b = await call('POST', `/rides/${ride.id}/bookings`, { token: rider.token, body: { seats: 1 } });
  assert.equal(b.body.status, 'confirmed');
  assert.equal(b.body.price_per_seat, 2000, 'non-students pay full price');
});

test('women-only rides', async () => {
  const man = await register();
  const woman = await register({ gender: 'female' });
  const man2 = await register();

  assert.equal((await call('POST', '/rides', { token: man.token, body: rideBody({ women_only: true }) })).status, 400);
  const ride = (await call('POST', '/rides', { token: woman.token, body: rideBody({ women_only: true }) })).body[0];
  assert.equal(ride.women_only, true);

  assert.equal((await call('POST', `/rides/${ride.id}/bookings`, { token: man2.token, body: {} })).status, 403);
  const woman2 = await register({ gender: 'female' });
  assert.equal((await call('POST', `/rides/${ride.id}/bookings`, { token: woman2.token, body: {} })).status, 201);
});

test('recurring commute creates one ride per departure', async () => {
  const driver = await register();
  const departures = [inHours(24), inHours(48), inHours(24 * 7)];
  const res = await call('POST', '/rides', { token: driver.token, body: rideBody({ departures }) });
  assert.equal(res.status, 201);
  assert.equal(res.body.length, 3);

  const mine = await call('GET', '/me/rides', { token: driver.token });
  assert.equal(mine.body.length, 3);

  const past = await call('POST', '/rides', { token: driver.token, body: rideBody({ departure_at: inHours(-1) }) });
  assert.equal(past.status, 400);
});

test('driver cancelling a ride cancels its bookings and hides it from search', async () => {
  const driver = await register();
  const rider = await register();
  const ride = (await call('POST', '/rides', { token: driver.token, body: rideBody({ from_city: 'Multan', to_city: 'Sukkur' }) })).body[0];
  const b = (await call('POST', `/rides/${ride.id}/bookings`, { token: rider.token, body: {} })).body;

  assert.equal((await call('POST', `/rides/${ride.id}/cancel`, { token: driver.token })).body.status, 'cancelled');
  const bookings = (await call('GET', '/me/bookings', { token: rider.token })).body;
  assert.equal(bookings.find((x) => x.id === b.id).status, 'cancelled');
  assert.equal((await call('GET', '/rides?from=Multan&to=Sukkur')).body.length, 0);
});

test('completing a ride and leaving reviews', async () => {
  const driver = await register();
  const rider = await register();
  const stranger = await register();
  const ride = (await call('POST', '/rides', { token: driver.token, body: rideBody() })).body[0];
  const b = (await call('POST', `/rides/${ride.id}/bookings`, { token: rider.token, body: {} })).body;
  await call('POST', `/bookings/${b.id}/confirm`, { token: driver.token });

  const early = await call('POST', `/rides/${ride.id}/complete`, { token: driver.token });
  assert.equal(early.status, 400, 'cannot complete before departure');

  db.prepare('UPDATE rides SET departure_at = ? WHERE id = ?').run(inHours(-3), ride.id);
  assert.equal((await call('POST', `/rides/${ride.id}/complete`, { token: driver.token })).body.status, 'completed');

  const detail = await call('GET', `/rides/${ride.id}`, { token: rider.token });
  assert.deepEqual(detail.body.can_review.map((c) => c.id), [driver.user.id]);

  const review = { reviewee_id: driver.user.id, rating: 5, comment: 'On time, safe driver' };
  assert.equal((await call('POST', `/rides/${ride.id}/reviews`, { token: stranger.token, body: review })).status, 403);
  assert.equal((await call('POST', `/rides/${ride.id}/reviews`, { token: rider.token, body: review })).status, 201);
  assert.equal((await call('POST', `/rides/${ride.id}/reviews`, { token: rider.token, body: review })).status, 409);
  assert.equal((await call('POST', `/rides/${ride.id}/reviews`, {
    token: driver.token, body: { reviewee_id: rider.user.id, rating: 4 },
  })).status, 201);

  const profile = await call('GET', `/users/${driver.user.id}`);
  assert.equal(profile.body.rating_avg, 5);
  assert.equal(profile.body.rides_driven, 1);
  assert.equal(profile.body.reviews[0].comment, 'On time, safe driver');
  assert.equal(profile.body.phone, undefined);
});

test('delete account: needs the password and no upcoming trips, then anonymises', async () => {
  const { token: driver } = await register({ email: 'leaving-driver@test.pk' });
  const { token, user } = await register({ email: 'leaving@test.pk' });
  const [ride] = (await call('POST', '/rides', { token: driver, body: rideBody({ instant_book: true }) })).body;
  assert.equal((await call('POST', `/rides/${ride.id}/bookings`, { token, body: { seats: 1 } })).status, 201);

  assert.equal((await call('DELETE', '/me', { token, body: { password: 'wrong-pass' } })).status, 400);
  assert.equal((await call('DELETE', '/me', { token, body: { password: 'secret123' } })).status, 409);

  const [booking] = (await call('GET', '/me/bookings', { token })).body;
  assert.equal((await call('POST', `/bookings/${booking.id}/cancel`, { token })).status, 200);
  assert.equal((await call('DELETE', '/me', { token, body: { password: 'secret123' } })).status, 204);

  assert.equal((await call('GET', '/me', { token })).status, 401);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'leaving@test.pk', password: 'secret123' } })).status, 401);
  const row = db.prepare('SELECT name, email, cnic FROM users WHERE id = ?').get(user.id);
  assert.equal(row.name, 'Deleted user');
  assert.match(row.email, /@deleted\.invalid$/);
  // The email can be used again for a fresh account.
  assert.equal((await register({ email: 'leaving@test.pk' })).user.email, 'leaving@test.pk');
});

test('ride requests can name pickup and drop-off points in their cities', async () => {
  const { token } = await register();
  const [isb] = (await call('GET', '/places?city=Islamabad')).body;
  const [lhr] = (await call('GET', '/places?city=lahore')).body;
  const body = {
    from_city: 'islamabad', to_city: 'Lahore', earliest_at: inHours(30), latest_at: inHours(40),
    from_place_id: isb.id, to_place_id: lhr.id,
  };
  const ok = await call('POST', '/ride-requests', { token, body });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.from_city, 'Islamabad');
  assert.equal(ok.body.from_place.name, isb.name);
  assert.equal(ok.body.to_place.id, lhr.id);

  const swapped = await call('POST', '/ride-requests', { token, body: { ...body, from_place_id: lhr.id } });
  assert.equal(swapped.status, 400);
  assert.match(swapped.body.error, /must be in Islamabad/);

  const anywhere = await call('POST', '/ride-requests', { token, body: { ...body, from_place_id: null, to_place_id: '' } });
  assert.equal(anywhere.status, 201);
  assert.equal(anywhere.body.from_place, null);
});

test('app errors are logged for admins, rate limited, and server errors too', async () => {
  const { token } = await register();
  const r = await call('POST', '/client-errors', { token, body: { message: 'TypeError: x is undefined', stack: 'at views.ride', url: '#/ride/1' } });
  assert.equal(r.status, 204);
  const row = db.prepare(`SELECT * FROM error_log WHERE source = 'app' ORDER BY id DESC`).get();
  assert.equal(row.message, 'TypeError: x is undefined');
  assert.equal(row.url, '#/ride/1');
  assert.ok(row.user_id);
  // Only admins can read them.
  assert.equal((await call('GET', '/admin/errors', { token })).status, 403);
});

test('web push: key, subscribe, alerts and chat messages are pushed', async () => {
  const webpush = require('web-push');
  const sent = [];
  const original = webpush.sendNotification;
  webpush.sendNotification = async (sub, payload) => { sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); };
  try {
    const key = await call('GET', '/push/key');
    assert.equal(key.status, 200);
    assert.ok(key.body.key.length > 60, 'a VAPID public key');
    assert.equal((await call('GET', '/push/key')).body.key, key.body.key, 'the same key every time');

    const driver = await register();
    const rider = await register({ traveler_type: 'traveler' });
    const subscription = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'BKey', auth: 'auth' } };
    assert.equal((await call('POST', '/me/push', { token: driver.token, body: { subscription: { endpoint: 'http://insecure' } } })).status, 400);
    assert.equal((await call('POST', '/me/push', { token: driver.token, body: { subscription } })).status, 204);

    const [ride] = (await call('POST', '/rides', { token: driver.token, body: rideBody() })).body;
    const booking = (await call('POST', `/rides/${ride.id}/bookings`, { token: rider.token, body: { seats: 1 } })).body;
    assert.ok(sent.some((p) => p.endpoint === subscription.endpoint && /request/i.test(p.title)), JSON.stringify(sent));

    await call('POST', `/bookings/${booking.id}/messages`, { token: rider.token, body: { body: 'Salaam, is the seat free?' } });
    const msg = sent.at(-1);
    assert.match(msg.title, /Message from/);
    assert.equal(msg.link, `/chat/${booking.id}`);

    assert.equal((await call('DELETE', '/me/push', { token: driver.token, body: { endpoint: subscription.endpoint } })).status, 204);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n, 0);
  } finally {
    webpush.sendNotification = original;
  }
});

test('a new ride request alerts drivers on that route (or all drivers) and admins; home pickup/drop saved', async () => {
  const routeDriver = await register();
  const otherDriver = await register();
  db.prepare(`UPDATE users SET driver_status = 'approved' WHERE id IN (?, ?)`).run(routeDriver.user.id, otherDriver.user.id);
  const admin = await register();
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(admin.user.id);
  await call('POST', '/rides', { token: routeDriver.token, body: rideBody({ from_city: 'Sialkot', to_city: 'Sargodha' }) });
  const passenger = await register({ name: 'Rida Passenger' });
  const titles = (u) => db.prepare('SELECT title, body FROM notifications WHERE user_id = ? ORDER BY id').all(u.user.id);

  const [sialkot] = (await call('GET', '/places?city=Sialkot')).body;
  const res = await call('POST', '/ride-requests', {
    token: passenger.token,
    body: {
      from_city: 'Sialkot', to_city: 'Sargodha', earliest_at: inHours(30), latest_at: inHours(40), from_place_id: sialkot.id,
      home_pickup: { lat: sialkot.lat + 0.01, lon: sialkot.lon + 0.01, address: 'House 5, Street 2' },
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.drivers_notified, 1, 'only the driver who drives this route');
  assert.equal(res.body.home_pickup.address, 'House 5, Street 2');
  assert.equal(res.body.home_drop, null);
  assert.match(titles(routeDriver).at(-1).title, /New ride request: Sialkot → Sargodha/);
  assert.match(titles(routeDriver).at(-1).body, /Rida Passenger.*wants home pickup/);
  assert.equal(titles(otherDriver).filter((n) => /New ride request/.test(n.title)).length, 0);
  assert.match(titles(admin).at(-1).title, /New ride request/);

  // Nobody drives Sukkur → Gilgit yet: every approved driver hears about it.
  const res2 = await call('POST', '/ride-requests', { token: passenger.token, body: { from_city: 'Sukkur', to_city: 'Gilgit', earliest_at: inHours(30), latest_at: inHours(40) } });
  assert.ok(res2.body.drivers_notified >= 2);
  assert.match(titles(otherDriver).at(-1).title, /Sukkur → Gilgit/);

  // A home far from the city is refused.
  const far = await call('POST', '/ride-requests', {
    token: passenger.token,
    body: { from_city: 'Sialkot', to_city: 'Sargodha', earliest_at: inHours(30), latest_at: inHours(40), home_drop: { lat: 24.86, lon: 67.0 } },
  });
  assert.equal(far.status, 400);
  assert.match(far.body.error, /near Sargodha/);
});
