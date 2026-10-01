const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db;

before(async () => {
  db = openDb(':memory:');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let n = 0;
async function register(overrides = {}) {
  n += 1;
  const { status, body } = await call('POST', '/auth/register', {
    body: {
      name: `User ${n}`, email: `user${n}@test.pk`, phone: '+92 300 0000000', password: 'secret123',
      traveler_type: 'professional', gender: 'male', ...overrides,
    },
  });
  assert.equal(status, 201, JSON.stringify(body));
  return body;
}

const inHours = (h) => new Date(Date.now() + h * 36e5).toISOString();

function rideBody(extra = {}) {
  return {
    from_city: 'Lahore', to_city: 'Islamabad', departure_at: inHours(24),
    seats_total: 3, price_per_seat: 2000, student_discount_pct: 25, ...extra,
  };
}

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
