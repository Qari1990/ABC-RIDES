const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, inHours } = require('./helpers');
const { runLifecycle } = require('../server/lifecycle');

let db, call, register, close;
before(async () => { ({ db, call, register, close } = await startServer()); });
after(() => close());

async function tripWithPassenger({ departInHours = 1 } = {}) {
  const driver = await register({ name: 'Kamran Driver' });
  db.prepare(`INSERT INTO vehicles (user_id, make, model, year, color, plate, seats, body_type, engine_cc, car_class, ac, features)
    VALUES (?, 'Honda', 'City', 2020, 'White', 'LEG-404', 4, 'sedan', 1300, 'standard', 1, '[]')`).run(driver.user.id);
  const [lhr] = (await call('GET', '/places?city=Lahore')).body;
  const [fsd] = (await call('GET', '/places?city=Faisalabad')).body;
  const ride = (await call('POST', '/rides', { token: driver.token, body: { stops: [lhr.id, fsd.id], departure_at: inHours(departInHours), seats_total: 3, instant_book: true } })).body[0];
  const passenger = await register({ name: 'Hina Passenger' });
  const booked = await call('POST', `/rides/${ride.id}/bookings`, { token: passenger.token, body: { seats: 1 } });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  if (booked.body.status !== 'confirmed') {
    assert.equal((await call('POST', `/bookings/${booked.body.id}/confirm`, { token: driver.token })).status, 200);
  }
  return { driver, passenger, ride, lhr };
}

test('live location: only people on the trip share and see it; family follows a link', async () => {
  const { driver, passenger, ride, lhr } = await tripWithPassenger();
  const stranger = await register();
  const here = { lat: lhr.lat + 0.01, lon: lhr.lon + 0.01, accuracy: 12 };

  assert.equal((await call('POST', `/rides/${ride.id}/location`, { token: stranger.token, body: here })).status, 403);
  assert.equal((await call('GET', `/rides/${ride.id}/live`, { token: stranger.token })).status, 403);
  assert.match((await call('POST', `/rides/${ride.id}/location`, { token: driver.token, body: { lat: 51.5, lon: -0.1 } })).body.error, /outside Pakistan/);

  assert.equal((await call('POST', `/rides/${ride.id}/location`, { token: driver.token, body: here })).status, 200);
  const inbox = (await call('GET', '/notifications', { token: passenger.token })).body;
  assert.ok(inbox.some((n) => /sharing the car’s live location/.test(n.title)), 'passenger is told once');
  await call('POST', `/rides/${ride.id}/location`, { token: driver.token, body: here });
  assert.equal((await call('GET', '/notifications', { token: passenger.token })).body.filter((n) => /live location/.test(n.title)).length, 1);

  const live = (await call('GET', `/rides/${ride.id}/live`, { token: passenger.token })).body.locations;
  assert.equal(live.length, 1);
  assert.equal(live[0].role, 'driver');
  assert.equal(live[0].name, 'Kamran', 'first name only');

  // A link for family, the same each time, readable without logging in.
  const link = (await call('POST', `/rides/${ride.id}/track-link`, { token: passenger.token })).body;
  assert.equal((await call('POST', `/rides/${ride.id}/track-link`, { token: passenger.token })).body.token, link.token);
  assert.equal((await call('POST', `/rides/${ride.id}/track-link`, { token: stranger.token })).status, 403);
  const view = await call('GET', `/track/${link.token}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.shared_by, 'Hina');
  assert.equal(view.body.plate, 'LEG-404');
  assert.equal(view.body.locations[0].role, 'driver');
  assert.equal(JSON.stringify(view.body).includes('0300 0000000'), false, 'no phone numbers');
  assert.equal((await call('GET', '/track/not-a-real-token')).status, 404);

  // Stop sharing.
  assert.equal((await call('DELETE', `/rides/${ride.id}/location`, { token: driver.token })).status, 204);
  assert.equal((await call('GET', `/rides/${ride.id}/live`, { token: passenger.token })).body.locations.length, 0);

  // When the trip ends, locations are deleted and the link stops.
  await call('POST', `/rides/${ride.id}/location`, { token: passenger.token, body: here });
  db.prepare(`UPDATE rides SET status = 'cancelled' WHERE id = ?`).run(ride.id);
  runLifecycle(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ride_locations WHERE ride_id = ?').get(ride.id).n, 0);
  assert.equal((await call('GET', `/track/${link.token}`)).status, 410);
  assert.match((await call('POST', `/rides/${ride.id}/location`, { token: driver.token, body: here })).body.error, /ended/);
});

test('live location opens 2 hours before departure', async () => {
  const { driver, ride, lhr } = await tripWithPassenger({ departInHours: 30 });
  const res = await call('POST', `/rides/${ride.id}/location`, { token: driver.token, body: { lat: lhr.lat, lon: lhr.lon } });
  assert.match(res.body.error, /2 hours before departure/);
});
