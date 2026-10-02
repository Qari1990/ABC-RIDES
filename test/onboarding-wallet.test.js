const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, inHours, rideBody } = require('./helpers');
const { setSettings } = require('../server/settings');

let db, call, register, close;
let admin;

// 1x1 PNG, and a "PNG" whose bytes are not an image.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const FAKE_PNG = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;

// Production defaults: everything on.
const STRICT = {
  require_email_verification: true,
  require_driver_approval: true,
  student_price_requires_verification: true,
  driver_commission_pct: 0,
  passenger_commission_pct: 0,
  // Their fixed prices predate the per-km fare limits.
  enforce_fare_limits: false,
};

before(async () => {
  process.env.ADMIN_EMAILS = 'admin@test.pk';
  ({ db, call, register, close } = await startServer({ settings: STRICT }));
  admin = await register({ email: 'admin@test.pk' });
});

after(() => close());

let phoneCounter = 1000000;
const uniquePhone = () => `0300 ${phoneCounter++}`;

async function verifyEmail(u) {
  const sent = await call('POST', '/me/email/send-code', { token: u.token });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const ok = await call('POST', '/me/email/verify', { token: u.token, body: { code: sent.body.dev_code } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return ok.body;
}

let cnicCounter = 1000000;
const uniqueCnic = () => `35202-${cnicCounter++}-1`;

async function submitIdentity(u, extra = {}) {
  return call('POST', '/me/verification', {
    token: u.token, body: { cnic_number: uniqueCnic(), cnic_front: PNG, cnic_back: PNG, selfie: PNG, ...extra },
  });
}

const VEHICLE = { make: 'Toyota', model: 'Corolla', year: 2019, color: 'White', plate: 'LEA-1234', seats: 4 };
async function applyAsDriver(u, vehicle = VEHICLE) {
  return call('POST', '/me/driver', {
    token: u.token,
    body: { licence_number: 'LHR-123456', licence_photo: PNG, vehicle_photo: PNG, registration_photo: PNG, vehicle, driver_declaration: true },
  });
}

// A fully onboarded user: verified email, approved identity (and driver, if asked).
async function onboard({ driver = false, ...overrides } = {}) {
  const u = await register({ phone: uniquePhone(), ...overrides });
  await verifyEmail(u);
  assert.equal((await submitIdentity(u)).status, 200);
  if (driver) assert.equal((await applyAsDriver(u)).status, 200);
  assert.equal((await call('POST', `/admin/users/${u.user.id}/review`, { token: admin.token, body: { approve: true } })).status, 200);
  return u;
}

async function topUp(u, amount) {
  const ref = `TXN${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
  const t = await call('POST', '/me/wallet/topups', { token: u.token, body: { amount, method: 'jazzcash', reference: ref } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.equal((await call('POST', `/admin/topups/${t.body.id}/approve`, { token: admin.token })).status, 200);
}

const balance = async (u) => (await call('GET', '/me/wallet', { token: u.token })).body.balance;
const me = async (u) => (await call('GET', '/me', { token: u.token })).body;

test('email verification with one-time codes, and by hand by an admin', async () => {
  const u = await register({ email: 'typo@test' + '.pk' });
  const sent = await call('POST', '/me/email/send-code', { token: u.token });
  assert.match(sent.body.dev_code, /^\d{6}$/, 'dev mode returns the code when no email service is set');
  assert.equal((await call('POST', '/me/email/send-code', { token: u.token })).status, 429, 'resend is rate limited');

  const wrong = await call('POST', '/me/email/verify', { token: u.token, body: { code: '000000' === sent.body.dev_code ? '111111' : '000000' } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /4 attempt/);
  const ok = await call('POST', '/me/email/verify', { token: u.token, body: { code: sent.body.dev_code } });
  assert.equal(ok.body.email_verified, true);
  assert.equal((await call('POST', '/me/email/send-code', { token: u.token })).status, 400, 'already verified');

  // A mistyped address can be corrected before verifying, but not to someone else's.
  const typo = await register({ email: 'wrongaddress@test.pk' });
  assert.equal((await call('POST', '/me/email/send-code', { token: typo.token, body: { email: 'typo@test.pk' } })).status, 409);
  const fixed = await call('POST', '/me/email/send-code', { token: typo.token, body: { email: 'Right.Address@test.pk' } });
  assert.equal(fixed.body.sent_to, 'right.address@test.pk');
  assert.equal((await call('POST', '/auth/login', { body: { email: 'right.address@test.pk', password: 'secret123' } })).status, 200);

  // An admin can verify by hand (and only an admin).
  assert.equal((await call('POST', `/admin/users/${typo.user.id}/verify`, { token: u.token, body: { email: true } })).status, 403);
  const hand = await call('POST', `/admin/users/${typo.user.id}/verify`, { token: admin.token, body: { email: true, identity: true } });
  assert.equal(hand.status, 200, JSON.stringify(hand.body));
  assert.equal(hand.body.email_verified, true);
  assert.equal(hand.body.verification_status, 'verified');
  assert.equal((await call('POST', `/admin/users/${typo.user.id}/verify`, { token: admin.token, body: { driver: true } })).status, 400, 'no car, no driver approval');
  assert.equal((await call('POST', `/admin/users/${typo.user.id}/verify`, { token: admin.token, body: {} })).status, 400);
});

test('onboarding gates: email before booking, approval before posting rides', async () => {
  const driverish = await register({ phone: uniquePhone() });
  let res = await call('POST', '/rides', { token: driverish.token, body: rideBody() });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'email_unverified');
  await verifyEmail(driverish);
  res = await call('POST', '/rides', { token: driverish.token, body: rideBody() });
  assert.equal(res.body.code, 'driver_required');

  const driver = await onboard({ driver: true });
  const ride = (await call('POST', '/rides', { token: driver.token, body: rideBody() })).body[0];
  const unverified = await register({ phone: uniquePhone() });
  res = await call('POST', `/rides/${ride.id}/bookings`, { token: unverified.token, body: {} });
  assert.equal(res.body.code, 'email_unverified');
  res = await call('POST', '/ride-requests', { token: unverified.token, body: {} });
  assert.equal(res.body.code, 'email_unverified');
});

test('identity verification: CNIC checks, real images, one account per CNIC', async () => {
  const u = await register({ phone: uniquePhone(), traveler_type: 'student' });
  let res = await call('POST', '/me/verification', { token: u.token, body: { cnic_number: '123', cnic_front: PNG, cnic_back: PNG, selfie: PNG } });
  assert.match(res.body.error, /CNIC number must look like/);
  res = await call('POST', '/me/verification', { token: u.token, body: { cnic_number: '35202-7654321-9', cnic_front: PNG, cnic_back: PNG } });
  assert.match(res.body.error, /Selfie/);
  res = await call('POST', '/me/verification', { token: u.token, body: { cnic_number: '35202-7654321-9', cnic_front: PNG, cnic_back: FAKE_PNG, selfie: PNG } });
  assert.match(res.body.error, /JPG, PNG or WebP/, 'file contents are checked, not just the claimed type');

  res = await call('POST', '/me/verification', {
    token: u.token, body: { cnic_number: '35202-7654321-9', cnic_front: PNG, cnic_back: PNG, selfie: PNG, student_card: PNG },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.verification_status, 'pending');
  assert.equal(res.body.student_status, 'pending');
  assert.equal(res.body.cnic_masked, '35202-*******-9');

  const other = await register({ phone: uniquePhone() });
  res = await call('POST', '/me/verification', { token: other.token, body: { cnic_number: '3520276543219', cnic_front: PNG, cnic_back: PNG, selfie: PNG } });
  assert.equal(res.status, 409);

  const queue = (await call('GET', '/admin/verifications', { token: admin.token })).body;
  const item = queue.find((q) => q.id === u.user.id);
  assert.deepEqual(item.documents.map((d) => d.kind), ['cnic_front', 'cnic_back', 'selfie', 'student_card']);
  const doc = await call('GET', `/admin/documents/${item.documents[0].id}`, { token: admin.token });
  assert.equal(doc.headers.get('content-type'), 'image/png');
  assert.equal((await call('GET', `/admin/documents/${item.documents[0].id}`, { token: u.token })).status, 403);
});

test('student prices only for verified students', async () => {
  const driver = await onboard({ driver: true });
  const ride = (await call('POST', '/rides', { token: driver.token, body: rideBody() })).body[0];
  const student = await register({ phone: uniquePhone(), traveler_type: 'student' });
  assert.equal((await call('GET', `/rides/${ride.id}`, { token: student.token })).body.your_price, 2000);
  await verifyEmail(student);
  await submitIdentity(student, { student_card: PNG });
  await call('POST', `/admin/users/${student.user.id}/review`, { token: admin.token, body: { approve: true } });
  assert.equal((await me(student)).student_verified, true);
  assert.equal((await call('GET', `/rides/${ride.id}`, { token: student.token })).body.your_price, 1500);
});

test('driver registration: vehicle checks, approval, plate shown only to confirmed passengers', async () => {
  const u = await register({ phone: uniquePhone() });
  await verifyEmail(u);
  assert.match((await applyAsDriver(u)).body.error, /verify your identity/);
  await submitIdentity(u);
  assert.match((await applyAsDriver(u, { ...VEHICLE, plate: '!!' })).body.error, /plate/i);
  assert.match((await applyAsDriver(u, { ...VEHICLE, year: 1950 })).body.error, /year/i);
  const applied = await applyAsDriver(u, { ...VEHICLE, plate: 'ict 777', seats: 3 });
  assert.equal(applied.body.driver_status, 'pending');
  assert.equal(applied.body.vehicle.plate, 'ICT 777');

  const rejected = await call('POST', `/admin/users/${u.user.id}/review`, { token: admin.token, body: { approve: false, note: 'Licence photo is blurry' } });
  assert.equal(rejected.body.driver_status, 'rejected');
  assert.match((await call('GET', '/notifications', { token: u.token })).body[0].body, /Licence photo is blurry/);

  await submitIdentity(u).catch(() => {});
  await applyAsDriver(u, { ...VEHICLE, plate: 'ICT 777', seats: 3 });
  await call('POST', `/admin/users/${u.user.id}/review`, { token: admin.token, body: { approve: true } });
  assert.equal((await me(u)).driver_status, 'approved');

  assert.match((await call('POST', '/rides', { token: u.token, body: rideBody({ seats_total: 4 }) })).body.error, /3 passenger seat/);
  const ride = (await call('POST', '/rides', { token: u.token, body: rideBody({ seats_total: 3, instant_book: true }) })).body[0];
  assert.equal(ride.vehicle, 'Toyota Corolla 2019 (White)');
  assert.equal(ride.driver.approved_driver, true);
  assert.equal(ride.vehicle_plate, undefined);

  const passenger = await onboard();
  assert.equal((await call('GET', `/rides/${ride.id}`, { token: passenger.token })).body.vehicle_plate, undefined);
  await call('POST', `/rides/${ride.id}/bookings`, { token: passenger.token, body: {} });
  assert.equal((await call('GET', `/rides/${ride.id}`, { token: passenger.token })).body.vehicle_plate, 'ICT 777');
});

test('wallet top-ups are approved or rejected by an admin', async () => {
  const u = await onboard();
  const small = await call('POST', '/me/wallet/topups', { token: u.token, body: { amount: 50, method: 'jazzcash', reference: 'ABC123456' } });
  assert.match(small.body.error, /at least 100/);
  const t = await call('POST', '/me/wallet/topups', { token: u.token, body: { amount: 500, method: 'easypaisa', reference: 'EP98765432' } });
  assert.equal(t.status, 201);
  assert.equal((await call('POST', '/me/wallet/topups', { token: u.token, body: { amount: 500, method: 'easypaisa', reference: 'ep98765432' } })).status, 409);
  assert.equal(await balance(u), 0, 'nothing credited until approved');

  const pending = (await call('GET', '/admin/topups', { token: admin.token })).body;
  assert.ok(pending.some((p) => p.reference === 'EP98765432'));
  await call('POST', `/admin/topups/${t.body.id}/approve`, { token: admin.token });
  assert.equal(await balance(u), 500);
  assert.equal((await call('POST', `/admin/topups/${t.body.id}/approve`, { token: admin.token })).status, 400, 'cannot approve twice');

  const t2 = await call('POST', '/me/wallet/topups', { token: u.token, body: { amount: 300, method: 'jazzcash', reference: 'JC11112222' } });
  await call('POST', `/admin/topups/${t2.body.id}/reject`, { token: admin.token, body: { note: 'Payment not received' } });
  assert.equal(await balance(u), 500);
  const wallet = (await call('GET', '/me/wallet', { token: u.token })).body;
  assert.equal(wallet.transactions[0].type, 'topup');
  assert.equal(wallet.topups[0].status, 'rejected');
});

test('commission on confirmation, after the free confirmations run out', async () => {
  setSettings(db, { driver_commission_pct: 10, passenger_commission_pct: 5, free_confirmations: 1 });
  try {
    const driver = await onboard({ driver: true });
    const p1 = await onboard();
    const p2 = await onboard();

    // First confirmation for each is free.
    const r1 = (await call('POST', '/rides', { token: driver.token, body: rideBody({ price_per_seat: 2000, student_discount_pct: 0 }) })).body[0];
    const b1 = (await call('POST', `/rides/${r1.id}/bookings`, { token: p1.token, body: { seats: 1 } })).body;
    const c1 = await call('POST', `/bookings/${b1.id}/confirm`, { token: driver.token });
    assert.equal(c1.body.status, 'confirmed');
    assert.equal(c1.body.driver_fee, 0);
    assert.equal(c1.body.passenger_fee, 0);

    // p1 has used their free one: 5% of Rs 4000 = Rs 200, so a request needs that balance.
    const r2 = (await call('POST', '/rides', { token: driver.token, body: rideBody({ price_per_seat: 2000, student_discount_pct: 0 }) })).body[0];
    const preview = (await call('GET', `/rides/${r2.id}`, { token: p1.token })).body.booking_fee;
    assert.deepEqual(preview, { pct: 5, free: false, low_reliability_fee: 0, per_seat_fare: 2000 });
    let res = await call('POST', `/rides/${r2.id}/bookings`, { token: p1.token, body: { seats: 2 } });
    assert.equal(res.status, 402);
    assert.equal(res.body.code, 'insufficient_balance');
    await topUp(p1, 200);
    const b2 = (await call('POST', `/rides/${r2.id}/bookings`, { token: p1.token, body: { seats: 2 } })).body;

    // The driver owes 10% of Rs 4000 = Rs 400, less 25% because the car now has
    // 2 passengers: Rs 300. Their wallet is empty.
    const driverView = (await call('GET', `/rides/${r2.id}`, { token: driver.token })).body;
    assert.equal(driverView.bookings[0].driver_fee_preview, 300);
    assert.equal(driverView.bookings[0].sharing_discount_pct, 25);
    res = await call('POST', `/bookings/${b2.id}/confirm`, { token: driver.token });
    assert.equal(res.status, 402);
    assert.match(res.body.error, /Your wallet balance/);
    await topUp(driver, 1000);
    res = await call('POST', `/bookings/${b2.id}/confirm`, { token: driver.token });
    assert.equal(res.body.status, 'confirmed');
    assert.equal(res.body.driver_fee, 300);
    assert.equal(res.body.commission_discount_pct, 25);
    assert.equal(res.body.passenger_fee, 200);
    assert.equal(await balance(driver), 700);
    assert.equal(await balance(p1), 0);

    // p2's free confirmation: no passenger fee, but the driver has none left (10% of 1000).
    const r3 = (await call('POST', '/rides', { token: driver.token, body: rideBody({ price_per_seat: 1000, student_discount_pct: 0 }) })).body[0];
    const b3 = (await call('POST', `/rides/${r3.id}/bookings`, { token: p2.token, body: { seats: 1 } })).body;
    const c3 = (await call('POST', `/bookings/${b3.id}/confirm`, { token: driver.token })).body;
    assert.equal(c3.passenger_fee, 0);
    assert.equal(c3.driver_fee, 100);

    // Passenger short at accept time: p2 asks for two rides with enough for one fee (Rs 50 each).
    await topUp(p2, 100);
    db.prepare('UPDATE users SET wallet_balance = 50 WHERE id = ?').run(p2.user.id);
    const r4 = (await call('POST', '/rides', { token: driver.token, body: rideBody({ price_per_seat: 1000, student_discount_pct: 0 }) })).body[0];
    const r5 = (await call('POST', '/rides', { token: driver.token, body: rideBody({ price_per_seat: 1000, student_discount_pct: 0 }) })).body[0];
    const b4 = (await call('POST', `/rides/${r4.id}/bookings`, { token: p2.token, body: {} })).body;
    const b5 = (await call('POST', `/rides/${r5.id}/bookings`, { token: p2.token, body: {} })).body;
    assert.equal((await call('POST', `/bookings/${b4.id}/confirm`, { token: driver.token })).body.passenger_fee, 50);
    res = await call('POST', `/bookings/${b5.id}/confirm`, { token: driver.token });
    assert.equal(res.status, 402);
    assert.match(res.body.error, /passenger's wallet balance is too low/);
    assert.equal(res.body.code, 'other_party_balance', 'the driver is not sent to top up their own wallet');
    assert.match((await call('GET', '/notifications', { token: p2.token })).body[0].title, /Top up to confirm/);
    assert.equal((await call('GET', `/rides/${r5.id}`, { token: driver.token })).body.bookings[0].status, 'pending', 'nothing changed');

    const revenue = (await call('GET', '/admin/stats', { token: admin.token })).body;
    assert.equal(revenue.revenue, 300 + 200 + 100 + 100 + 50, 'every commission and fee charged so far');
    const ledger = (await call('GET', '/me/wallet', { token: driver.token })).body.transactions;
    assert.equal(ledger[0].type, 'commission');
  } finally {
    setSettings(db, { driver_commission_pct: 0, passenger_commission_pct: 0, free_confirmations: 3 });
  }
});

test('instant booking stays pending when the driver cannot pay the commission', async () => {
  setSettings(db, { driver_commission_pct: 10, free_confirmations: 0 });
  try {
    const driver = await onboard({ driver: true });
    const p = await onboard();
    const ride = (await call('POST', '/rides', { token: driver.token, body: rideBody({ instant_book: true }) })).body[0];
    const b = (await call('POST', `/rides/${ride.id}/bookings`, { token: p.token, body: {} })).body;
    assert.equal(b.status, 'pending');
    assert.match((await call('GET', '/notifications', { token: driver.token })).body[0].body, /Top up your wallet/);
  } finally {
    setSettings(db, { driver_commission_pct: 0, free_confirmations: 3 });
  }
});

test('cancellations cost reliability (double when late) and refund the other side', async () => {
  setSettings(db, { driver_commission_pct: 10, passenger_commission_pct: 10, free_confirmations: 0 });
  try {
    const driver = await onboard({ driver: true });
    const p = await onboard();
    await topUp(driver, 1000);
    await topUp(p, 1000);

    // Passenger cancels a confirmed booking two days out: -10, driver refunded.
    const far = (await call('POST', '/rides', { token: driver.token, body: rideBody({ departure_at: inHours(48), price_per_seat: 1000, student_discount_pct: 0, instant_book: true }) })).body[0];
    const b = (await call('POST', `/rides/${far.id}/bookings`, { token: p.token, body: {} })).body;
    assert.equal(b.status, 'confirmed');
    assert.equal(await balance(driver), 900);
    await call('POST', `/bookings/${b.id}/cancel`, { token: p.token });
    assert.equal(await balance(driver), 1000, 'driver commission refunded');
    assert.equal(await balance(p), 900, 'passenger fee kept');
    assert.equal((await me(p)).reliability, 90);

    // Driver cancels a booked ride 5 hours before departure: -30 (late), passenger refunded.
    const soon = (await call('POST', '/rides', { token: driver.token, body: rideBody({ departure_at: inHours(5), price_per_seat: 1000, student_discount_pct: 0, instant_book: true }) })).body[0];
    await call('POST', `/rides/${soon.id}/bookings`, { token: p.token, body: {} });
    assert.equal(await balance(p), 800);
    await call('POST', `/rides/${soon.id}/cancel`, { token: driver.token });
    assert.equal(await balance(p), 900, 'passenger fee refunded');
    assert.equal((await me(driver)).reliability, 70);

    // Cancelling a ride nobody booked costs nothing.
    const empty = (await call('POST', '/rides', { token: driver.token, body: rideBody() })).body[0];
    await call('POST', `/rides/${empty.id}/cancel`, { token: driver.token });
    assert.equal((await me(driver)).reliability, 70);
  } finally {
    setSettings(db, { driver_commission_pct: 0, passenger_commission_pct: 0, free_confirmations: 3 });
  }
});

test('low reliability: paying to post rides and confirm bookings; completed trips earn points back', async () => {
  const driver = await onboard({ driver: true });
  const p = await onboard();
  db.prepare('UPDATE users SET reliability = 60 WHERE id = ?').run(driver.user.id);

  let res = await call('POST', '/rides', { token: driver.token, body: rideBody({ departures: [inHours(30), inHours(54)] }) });
  assert.equal(res.status, 402);
  assert.match(res.body.error, /You need Rs 200/);
  await topUp(driver, 300);
  res = await call('POST', '/rides', { token: driver.token, body: rideBody({ departures: [inHours(30), inHours(54)] }) });
  assert.equal(res.status, 201);
  assert.equal(await balance(driver), 100);

  // Confirming adds the low-reliability fee even during free confirmations.
  const ride = res.body[0];
  const b = (await call('POST', `/rides/${ride.id}/bookings`, { token: p.token, body: {} })).body;
  const c = (await call('POST', `/bookings/${b.id}/confirm`, { token: driver.token })).body;
  assert.equal(c.driver_fee, 100);
  assert.equal(c.passenger_fee, 0);

  db.prepare('UPDATE rides SET departure_at = ? WHERE id = ?').run(inHours(-1), ride.id);
  await call('POST', `/rides/${ride.id}/complete`, { token: driver.token });
  assert.equal((await me(driver)).reliability, 62);
  assert.equal((await me(p)).reliability, 100, 'capped at 100');
});

test('admin booking mode overrides the driver’s choice', async () => {
  const driver = await onboard({ driver: true });
  const p = await onboard();
  const instantRide = (await call('POST', '/rides', { token: driver.token, body: rideBody({ instant_book: true }) })).body[0];
  const manualRide = (await call('POST', '/rides', { token: driver.token, body: rideBody({ instant_book: false }) })).body[0];

  await call('PUT', '/admin/settings', { token: admin.token, body: { booking_mode: 'manual' } });
  assert.equal((await call('GET', `/rides/${instantRide.id}`)).body.instant_book, false);
  assert.equal((await call('POST', `/rides/${instantRide.id}/bookings`, { token: p.token, body: {} })).body.status, 'pending');

  await call('PUT', '/admin/settings', { token: admin.token, body: { booking_mode: 'instant' } });
  assert.equal((await call('POST', `/rides/${manualRide.id}/bookings`, { token: p.token, body: {} })).body.status, 'confirmed');
  await call('PUT', '/admin/settings', { token: admin.token, body: { booking_mode: 'driver_choice' } });
});

test('admin settings are validated and admin-only', async () => {
  const u = await onboard();
  assert.equal((await call('PUT', '/admin/settings', { token: u.token, body: { driver_commission_pct: 1 } })).status, 403);
  assert.equal((await call('PUT', '/admin/settings', { token: admin.token, body: { driver_commission_pct: 80 } })).status, 400);
  assert.equal((await call('PUT', '/admin/settings', { token: admin.token, body: { booking_mode: 'sometimes' } })).status, 400);
  assert.equal((await call('PUT', '/admin/settings', { token: admin.token, body: { nonsense: 1 } })).status, 400);
  const ok = await call('PUT', '/admin/settings', { token: admin.token, body: { topup_accounts: 'JazzCash 0300 1234567' } });
  assert.equal(ok.body.values.topup_accounts, 'JazzCash 0300 1234567');
  assert.equal((await call('GET', '/settings')).body.topup_accounts, 'JazzCash 0300 1234567');

  const adj = await call('POST', `/admin/users/${u.user.id}/wallet`, { token: admin.token, body: { amount: 250, note: 'Launch bonus' } });
  assert.equal(adj.body.wallet_balance, 250);
  assert.equal((await call('POST', `/admin/users/${u.user.id}/reliability`, { token: admin.token, body: { reliability: 40 } })).body.reliability, 40);
});

test('security: login lockout and headers', async () => {
  const u = await register({ email: 'locked@test.pk' });
  for (let i = 0; i < 8; i++) {
    assert.equal((await call('POST', '/auth/login', { body: { email: 'locked@test.pk', password: 'wrong-password' } })).status, 401);
  }
  const locked = await call('POST', '/auth/login', { body: { email: 'locked@test.pk', password: 'secret123' } });
  assert.equal(locked.status, 429, 'even the right password is refused while locked');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.ok(u.token);

  const page = await call('GET', '/health');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
});

test('admin can set a temporary password', async () => {
  const u = await register({ email: 'locked-out@test.pk' });
  assert.equal((await call('POST', `/admin/users/${u.user.id}/temp-password`, { token: u.token })).status, 403);
  const res = await call('POST', `/admin/users/${u.user.id}/temp-password`, { token: admin.token });
  assert.equal(res.status, 200);
  assert.ok(res.body.password.length >= 8);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'locked-out@test.pk', password: res.body.password } })).status, 200);
});

test('forgot password by email (Brevo)', async () => {
  const u = await register({ email: 'mailer@test.pk' });
  assert.equal((await call('GET', '/auth/reset/options')).body.email, false);
  assert.equal((await call('POST', '/auth/reset/send', { body: { login: 'mailer@test.pk' } })).body.code, 'reset_unavailable');

  const http = require('node:http');
  let sent = null;
  const brevo = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { sent = { key: req.headers['api-key'], ...JSON.parse(body) }; res.writeHead(201); res.end('{}'); });
  }).listen(0);
  await new Promise((r) => brevo.once('listening', r));
  Object.assign(process.env, { BREVO_API_KEY: 'test-key', EMAIL_FROM: 'abcrides@test.pk', EMAIL_API_URL: `http://127.0.0.1:${brevo.address().port}/` });
  try {
    assert.equal((await call('GET', '/auth/reset/options')).body.email, true);
    assert.equal((await call('POST', '/auth/reset/send', { body: { login: 'nobody@test.pk' } })).status, 200);
    assert.equal(sent, null, 'no email for unknown addresses');
    assert.equal((await call('POST', '/auth/reset/send', { body: { login: 'Mailer@Test.pk' } })).status, 200);
    assert.equal(sent.key, 'test-key');
    assert.deepEqual(sent.to, [{ email: 'mailer@test.pk' }]);
    const code = sent.textContent.match(/\d{6}/)[0];
    assert.equal((await call('POST', '/auth/reset/confirm', { body: { login: 'mailer@test.pk', code, new_password: 'emailreset1' } })).status, 204);
    assert.equal((await call('GET', '/me', { token: u.token })).status, 401);
    assert.equal((await call('POST', '/auth/login', { body: { email: 'mailer@test.pk', password: 'emailreset1' } })).status, 200);
  } finally {
    for (const k of ['BREVO_API_KEY', 'EMAIL_FROM', 'EMAIL_API_URL']) delete process.env[k];
    brevo.close();
  }
});
