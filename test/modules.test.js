const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, inHours, rideBody } = require('./helpers');

let db, call, register, close;

// 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

before(async () => {
  process.env.ADMIN_EMAILS = 'boss@test.pk';
  ({ db, call, register, close } = await startServer());
});

after(() => close());

async function bookedRide({ instant = false } = {}) {
  const driver = await register();
  const rider = await register({ traveler_type: 'student' });
  const ride = (await call('POST', '/rides', {
    token: driver.token,
    body: rideBody({ instant_book: instant, payment_methods: ['cash', 'jazzcash'], payment_details: 'JazzCash 0300 1234567' }),
  })).body[0];
  const booking = (await call('POST', `/rides/${ride.id}/bookings`, { token: rider.token, body: { seats: 1 } })).body;
  return { driver, rider, ride, booking };
}

test('notifications follow the booking lifecycle', async () => {
  const { driver, rider, ride, booking } = await bookedRide();

  let count = await call('GET', '/notifications/unread-count', { token: driver.token });
  assert.equal(count.body.notifications, 1);
  const list = await call('GET', '/notifications', { token: driver.token });
  assert.match(list.body[0].title, /New booking request/);
  assert.equal(list.body[0].link, `/ride/${ride.id}`);

  await call('POST', `/bookings/${booking.id}/confirm`, { token: driver.token });
  const riderNotes = await call('GET', '/notifications', { token: rider.token });
  assert.match(riderNotes.body[0].title, /confirmed/);

  await call('POST', '/notifications/read-all', { token: driver.token });
  count = await call('GET', '/notifications/unread-count', { token: driver.token });
  assert.equal(count.body.notifications, 0);

  await call('POST', `/rides/${ride.id}/cancel`, { token: driver.token });
  const afterCancel = await call('GET', '/notifications', { token: rider.token });
  assert.match(afterCancel.body[0].title, /cancelled by the driver/);
});

test('payment details are shown only to the driver and confirmed passengers', async () => {
  const { driver, rider, ride, booking } = await bookedRide();
  const outsider = await register();

  const search = await call('GET', '/rides?from=Lahore&to=Islamabad', { token: outsider.token });
  const listed = search.body.find((r) => r.id === ride.id);
  assert.deepEqual(listed.payment_methods, ['cash', 'jazzcash']);
  assert.equal(listed.payment_details, undefined);

  assert.equal((await call('GET', `/rides/${ride.id}`, { token: rider.token })).body.payment_details, undefined, 'pending passenger');
  await call('POST', `/bookings/${booking.id}/confirm`, { token: driver.token });
  assert.equal((await call('GET', `/rides/${ride.id}`, { token: rider.token })).body.payment_details, 'JazzCash 0300 1234567');
  assert.equal((await call('GET', `/rides/${ride.id}`, { token: driver.token })).body.payment_details, 'JazzCash 0300 1234567');

  const bad = await call('POST', '/rides', { token: driver.token, body: rideBody({ payment_methods: ['bitcoin'] }) });
  assert.equal(bad.status, 400);
});

test('driver can edit ride details and passengers are told', async () => {
  const { driver, rider, ride, booking } = await bookedRide({ instant: true });
  assert.equal(booking.status, 'confirmed');
  const outsider = await register();

  assert.equal((await call('PATCH', `/rides/${ride.id}`, { token: outsider.token, body: { notes: 'x' } })).status, 403);
  const edited = await call('PATCH', `/rides/${ride.id}`, { token: driver.token, body: { pickup_point: 'Kalma Chowk', notes: null } });
  assert.equal(edited.body.pickup_point, 'Kalma Chowk');
  assert.equal(edited.body.notes, null);
  const notes = await call('GET', '/notifications', { token: rider.token });
  assert.match(notes.body[0].title, /Ride details updated/);
});

test('chat between driver and passenger', async () => {
  const { driver, rider, booking } = await bookedRide();
  const outsider = await register();

  const sent = await call('POST', `/bookings/${booking.id}/messages`, { token: rider.token, body: { body: 'Can you pick me up at Kalma Chowk?' } });
  assert.equal(sent.status, 201);
  assert.equal((await call('GET', `/bookings/${booking.id}/messages`, { token: outsider.token })).status, 403);
  assert.equal((await call('POST', `/bookings/${booking.id}/messages`, { token: rider.token, body: { body: '  ' } })).status, 400);

  assert.equal((await call('GET', '/notifications/unread-count', { token: driver.token })).body.messages, 1);
  const inbox = await call('GET', '/me/conversations', { token: driver.token });
  assert.equal(inbox.body[0].booking_id, booking.id);
  assert.equal(inbox.body[0].unread, 1);
  assert.equal(inbox.body[0].other_name, rider.user.name);

  const threadView = await call('GET', `/bookings/${booking.id}/messages`, { token: driver.token });
  assert.equal(threadView.body.messages.length, 1);
  assert.equal(threadView.body.thread.other.id, rider.user.id);
  assert.equal((await call('GET', '/notifications/unread-count', { token: driver.token })).body.messages, 0, 'opening marks read');

  await call('POST', `/bookings/${booking.id}/cancel`, { token: rider.token });
  assert.equal((await call('POST', `/bookings/${booking.id}/messages`, { token: driver.token, body: { body: 'ok' } })).status, 400);
});

test('ride requests and matching-ride alerts', async () => {
  const passenger = await register();
  const driver = await register();
  const day = new Date(Date.now() + 3 * 864e5);
  const earliest = new Date(day); earliest.setHours(0, 0, 0, 0);
  const latest = new Date(earliest.getTime() + 864e5);

  const created = await call('POST', '/ride-requests', {
    token: passenger.token,
    body: { from_city: 'Multan', to_city: 'Lahore', earliest_at: earliest.toISOString(), latest_at: latest.toISOString(), seats: 2, max_price: 3000 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.passenger.id, passenger.user.id);

  const browse = await call('GET', '/ride-requests?from=multan&to=lahore');
  assert.equal(browse.body.length, 1);

  const departure = new Date(earliest.getTime() + 10 * 36e5).toISOString();
  await call('POST', '/rides', { token: driver.token, body: rideBody({ from_city: 'Multan', to_city: 'Lahore', departure_at: departure }) });
  const notes = await call('GET', '/notifications', { token: passenger.token });
  assert.match(notes.body[0].title, /matches your request/);

  assert.equal((await call('POST', `/ride-requests/${created.body.id}/close`, { token: driver.token })).status, 403);
  await call('POST', `/ride-requests/${created.body.id}/close`, { token: passenger.token });
  assert.equal((await call('GET', '/ride-requests?from=multan&to=lahore')).body.length, 0);

  const bad = await call('POST', '/ride-requests', {
    token: passenger.token, body: { from_city: 'Multan', to_city: 'Lahore', earliest_at: inHours(5), latest_at: inHours(2) },
  });
  assert.equal(bad.status, 400);
});

test('document verification reviewed by an admin', async () => {
  const admin = await register({ email: 'boss@test.pk' });
  assert.equal(admin.user.role, 'admin');
  const user = await register({ traveler_type: 'student' });

  assert.equal((await call('POST', '/me/verification', { token: user.token, body: { doc_type: 'student_card', image: 'nope' } })).status, 400);
  const up = await call('POST', '/me/verification', { token: user.token, body: { doc_type: 'student_card', image: PNG } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.verification_status, 'pending');

  assert.equal((await call('GET', '/admin/verifications', { token: user.token })).status, 403);
  const queue = await call('GET', '/admin/verifications', { token: admin.token });
  assert.deepEqual(queue.body.map((u) => u.id), [user.user.id]);

  const doc = await call('GET', `/admin/users/${user.user.id}/document`, { token: admin.token });
  assert.equal(doc.status, 200);
  assert.equal(doc.headers.get('content-type'), 'image/png');

  await call('POST', `/admin/users/${user.user.id}/verification`, { token: admin.token, body: { approve: true } });
  const profile = await call('GET', `/users/${user.user.id}`);
  assert.equal(profile.body.verified, true);
  assert.equal(profile.body.verified_as, 'student_card');
  assert.match((await call('GET', '/notifications', { token: user.token })).body[0].title, /verified/);
});

test('reports, suspension and admin stats', async () => {
  const admin = (await call('POST', '/auth/login', { body: { email: 'boss@test.pk', password: 'secret123' } })).body;
  const reporter = await register();
  const bad = await register({ email: 'bad@test.pk' });

  assert.equal((await call('POST', '/reports', { token: reporter.token, body: { reported_user_id: reporter.user.id, reason: 'x' } })).status, 400);
  const r = await call('POST', '/reports', { token: reporter.token, body: { reported_user_id: bad.user.id, reason: 'Rude behaviour', details: 'Shouted at passengers' } });
  assert.equal(r.status, 201);

  const reports = await call('GET', '/admin/reports', { token: admin.token });
  assert.equal(reports.body[0].reported_name, bad.user.name);

  await call('POST', `/admin/users/${bad.user.id}/suspend`, { token: admin.token, body: { suspended: true } });
  assert.equal((await call('GET', '/me', { token: bad.token })).status, 401, 'sessions revoked');
  assert.equal((await call('POST', '/auth/login', { body: { email: 'bad@test.pk', password: 'secret123' } })).status, 403);
  assert.equal((await call('POST', `/admin/users/${admin.user.id}/suspend`, { token: admin.token, body: { suspended: true } })).status, 400);

  await call('POST', `/admin/reports/${reports.body[0].id}/resolve`, { token: admin.token, body: { resolution: 'Suspended' } });
  const stats = await call('GET', '/admin/stats', { token: admin.token });
  assert.equal(stats.body.open_reports, 0);
  assert.ok(stats.body.users.professional >= 2);
});

test('change password signs out other devices; profile fields can be cleared', async () => {
  const u = await register({ organization: 'Acme', emergency_name: 'Ammi', emergency_phone: '+92 300 9999999' });
  const other = (await call('POST', '/auth/login', { body: { email: u.user.email, password: 'secret123' } })).body;

  assert.equal((await call('POST', '/me/password', { token: u.token, body: { current_password: 'wrong', new_password: 'newsecret1' } })).status, 400);
  assert.equal((await call('POST', '/me/password', { token: u.token, body: { current_password: 'secret123', new_password: 'newsecret1' } })).status, 204);
  assert.equal((await call('GET', '/me', { token: other.token })).status, 401);
  assert.equal((await call('GET', '/me', { token: u.token })).status, 200);

  const patched = await call('PATCH', '/me', { token: u.token, body: { organization: '', name: '' } });
  assert.equal(patched.body.organization, null);
  assert.equal(patched.body.name, u.user.name, 'required fields are not cleared');
  assert.equal(patched.body.emergency_phone, '+92 300 9999999');
});
