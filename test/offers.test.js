const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, inHours } = require('./helpers');
const { setSettings } = require('../server/settings');

let db, call, register, close;
before(async () => { ({ db, call, register, close } = await startServer()); });
after(() => close());

const balance = (u) => db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(u.user.id).wallet_balance;

test('driver offers on a request; passenger accepts: ride + confirmed booking, fees, contacts, spare seats', async () => {
  setSettings(db, { driver_commission_pct: 10, passenger_commission_pct: 5, free_confirmations: 0 });
  const passenger = await register({ name: 'Hina Passenger', phone: '+92 300 1110001' });
  const driverA = await register({ name: 'Asad Driver', phone: '+92 300 2220002' });
  const driverB = await register({ name: 'Bilal Driver' });
  for (const u of [passenger, driverA, driverB]) db.prepare('UPDATE users SET wallet_balance = 1000 WHERE id = ?').run(u.user.id);
  const [lhr] = (await call('GET', '/places?city=Lahore')).body;
  const [isb] = (await call('GET', '/places?city=Islamabad')).body;
  const req = (await call('POST', '/ride-requests', {
    token: passenger.token,
    body: { from_city: 'Lahore', to_city: 'Islamabad', earliest_at: inHours(20), latest_at: inHours(30), seats: 1, max_price: 1500, from_place_id: lhr.id, to_place_id: isb.id },
  })).body;
  assert.ok(req.fare.km > 300, 'distance known');
  assert.equal(req.fare.offered_per_km, Math.round((1500 / req.fare.km) * 10) / 10);

  // Outside the passenger's time window: refused.
  assert.equal((await call('POST', `/ride-requests/${req.id}/offers`, { token: driverA.token, body: { departure_at: inHours(60), price_per_seat: 1500 } })).status, 400);
  // The passenger's own price is allowed even below the usual per-km minimum.
  const offerA = await call('POST', `/ride-requests/${req.id}/offers`, {
    token: driverA.token, body: { departure_at: inHours(24), price_per_seat: 1500, seats_total: 3, share_remaining: true, note: 'AC car' },
  });
  assert.equal(offerA.status, 201, JSON.stringify(offerA.body));
  const offerB = (await call('POST', `/ride-requests/${req.id}/offers`, { token: driverB.token, body: { departure_at: inHours(25), price_per_seat: 1600 } })).body;
  assert.match(db.prepare('SELECT title FROM notifications WHERE user_id = ? ORDER BY id DESC').get(passenger.user.id).title, /New offer from Bilal Driver: Rs 1600/);

  // The passenger sees both offers with the fee; a driver sees only their own.
  const mine = (await call('GET', '/me/ride-requests', { token: passenger.token })).body.find((r) => r.id === req.id);
  assert.equal(mine.offers.length, 2);
  assert.equal(mine.offers.find((o) => o.id === offerA.body.id).passenger_fee, 75, '5% of 1500');
  const asB = (await call('GET', `/ride-requests/${req.id}`, { token: driverB.token })).body;
  assert.equal(asB.my_offer.id, offerB.id);
  assert.equal(asB.offers, undefined);

  // Only the passenger can accept.
  assert.equal((await call('POST', `/offers/${offerA.body.id}/accept`, { token: driverB.token })).status, 403);
  const accepted = await call('POST', `/offers/${offerA.body.id}/accept`, { token: passenger.token });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(balance(passenger), 1000 - 75, 'booking fee taken on acceptance');
  assert.equal(balance(driverA), 1000 - 150, 'commission taken on acceptance');

  const ride = (await call('GET', `/rides/${accepted.body.ride_id}`, { token: passenger.token })).body;
  assert.equal(ride.my_booking.status, 'confirmed');
  assert.equal(ride.driver.phone, '+92 300 2220002', 'passenger sees the driver phone');
  assert.equal(ride.seats_left, 2, 'two spare seats for other passengers');
  const asDriver = (await call('GET', `/rides/${accepted.body.ride_id}`, { token: driverA.token })).body;
  assert.equal(asDriver.bookings[0].passenger_phone, '+92 300 1110001', 'driver sees the passenger phone');
  const search = (await call('GET', '/rides?from=Lahore&to=Islamabad')).body;
  assert.ok(search.some((r) => r.id === accepted.body.ride_id), 'spare seats are searchable');

  // Request closed, the other offer expired and its driver told.
  assert.equal(db.prepare('SELECT status FROM ride_requests WHERE id = ?').get(req.id).status, 'closed');
  assert.equal(db.prepare('SELECT status FROM request_offers WHERE id = ?').get(offerB.id).status, 'expired');
  assert.match(db.prepare('SELECT title FROM notifications WHERE user_id = ? ORDER BY id DESC').get(driverB.user.id).title, /chose another driver/);
  assert.equal((await call('POST', `/offers/${offerB.id}/accept`, { token: passenger.token })).status, 400);
});

test('accepting needs enough wallet balance; decline and withdraw', async () => {
  setSettings(db, { driver_commission_pct: 10, passenger_commission_pct: 5, free_confirmations: 0 });
  const passenger = await register();
  const driver = await register();
  db.prepare('UPDATE users SET wallet_balance = 0 WHERE id = ?').run(passenger.user.id);
  db.prepare('UPDATE users SET wallet_balance = 1000 WHERE id = ?').run(driver.user.id);
  const req = (await call('POST', '/ride-requests', { token: passenger.token, body: { from_city: 'Lahore', to_city: 'Faisalabad', earliest_at: inHours(20), latest_at: inHours(30) } })).body;
  const offer = (await call('POST', `/ride-requests/${req.id}/offers`, { token: driver.token, body: { departure_at: inHours(22), price_per_seat: 1500 } })).body;
  const poor = await call('POST', `/offers/${offer.id}/accept`, { token: passenger.token });
  assert.equal(poor.status, 402);
  assert.equal(poor.body.code, 'insufficient_balance');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rides WHERE driver_id = ?').get(driver.user.id).n, 0, 'nothing created');
  assert.equal(db.prepare('SELECT status FROM request_offers WHERE id = ?').get(offer.id).status, 'pending');

  assert.equal((await call('POST', `/offers/${offer.id}/decline`, { token: passenger.token })).status, 204);
  assert.equal((await call('POST', `/offers/${offer.id}/withdraw`, { token: driver.token })).status, 400, 'already declined');
  const again = (await call('POST', `/ride-requests/${req.id}/offers`, { token: driver.token, body: { departure_at: inHours(23), price_per_seat: 1400 } })).body;
  assert.equal((await call('POST', `/offers/${again.id}/withdraw`, { token: driver.token })).status, 204);
  assert.match(db.prepare('SELECT title FROM notifications WHERE user_id = ? ORDER BY id DESC').get(passenger.user.id).title, /withdrew/);
});
