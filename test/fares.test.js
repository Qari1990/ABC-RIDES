const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, inHours } = require('./helpers');
const { setSettings } = require('../server/settings');
const { cityRoadKm, CITIES } = require('../server/geo');

let db, call, register, close;
let admin, driver;

before(async () => {
  process.env.ADMIN_EMAILS = 'admin@fares.pk';
  ({ db, call, register, close } = await startServer({
    settings: {
      require_email_verification: false,
      service_cities: '',
      fees_enabled: true,
      require_driver_approval: false,
      student_price_requires_verification: false,
      driver_commission_pct: 10,
      passenger_commission_pct: 0,
      free_confirmations: 0,
    },
  }));
  admin = await register({ email: 'admin@fares.pk' });
  driver = await register();
  db.prepare('UPDATE users SET wallet_balance = 100000 WHERE id = ?').run(driver.user.id);
});

after(() => close());

const place = (city, name) => db.prepare('SELECT * FROM places WHERE city = ? AND name = ?').get(city, name);
const KALMA = () => place('Lahore', 'Kalma Chowk');
const GUJRANWALA = () => place('Gujranwala', 'City centre (Sheranwala Bagh)');
const SADDAR = () => place('Rawalpindi', 'Saddar');

async function postRide(body) {
  return call('POST', '/rides', {
    token: driver.token,
    body: { departure_at: inHours(30), seats_total: 4, student_discount_pct: 0, ...body },
  });
}

test('popular places and route plans with suggested stops', async () => {
  const lahore = (await call('GET', '/places?city=lahore')).body;
  assert.ok(lahore.length >= 5);
  assert.ok(lahore.every((p) => p.city === 'Lahore'));
  assert.ok(lahore.some((p) => p.name === 'Thokar Niaz Baig'));

  const plan = (await call('GET', `/route-plan?stops=${KALMA().id},${SADDAR().id}`)).body;
  assert.equal(plan.stops[0].km, 0);
  assert.ok(plan.distance_km > 330 && plan.distance_km < 420, `got ${plan.distance_km}`);
  assert.ok(plan.duration_minutes >= 240);
  const suggested = plan.suggested_stops.map((p) => p.city);
  assert.ok(suggested.includes('Gujranwala'), suggested.join());
  assert.ok(!suggested.includes('Peshawar'), 'nothing beyond the destination');
  assert.equal((await call('GET', '/route-plan?stops=99999,1')).status, 404);
});

test('admins can add, correct and hide places', async () => {
  const user = await register();
  const body = { city: 'lahore', name: 'Daewoo Terminal', lat: 31.4993, lon: 74.3279 };
  assert.equal((await call('POST', '/admin/places', { token: user.token, body })).status, 403);
  assert.equal((await call('POST', '/admin/places', { token: admin.token, body: { ...body, lat: 51.5 } })).status, 400, 'outside Pakistan');
  assert.equal((await call('POST', '/admin/places', { token: admin.token, body: { ...body, city: 'Atlantis' } })).status, 400);
  const created = await call('POST', '/admin/places', { token: admin.token, body });
  assert.equal(created.status, 201);
  assert.equal(created.body.city, 'Lahore');
  const fixed = await call('PATCH', `/admin/places/${created.body.id}`, { token: admin.token, body: { lat: 31.5001 } });
  assert.equal(fixed.body.lat, 31.5001);
  await call('DELETE', `/admin/places/${created.body.id}`, { token: admin.token });
  assert.ok(!(await call('GET', '/places?city=Lahore')).body.some((p) => p.name === 'Daewoo Terminal'));
});

test('fares must stay within the per-km limits', async () => {
  const stops = [KALMA().id, SADDAR().id];
  let res = await postRide({ stops, fare_per_km: 3 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /between Rs 6 and Rs 11/);
  res = await postRide({ stops, fare_per_km: 20 });
  assert.match(res.body.error, /between Rs 6 and Rs 11/);

  // Without stops, the price per seat is checked against the city-to-city distance.
  res = await postRide({ from_city: 'Lahore', to_city: 'Islamabad', price_per_seat: 1000 });
  assert.match(res.body.error, /between Rs 2250 and Rs 4130/);
  assert.equal((await postRide({ from_city: 'Lahore', to_city: 'Islamabad', price_per_seat: 3000 })).status, 201);

  // Unknown places and routes inside one city are refused.
  assert.equal((await postRide({ stops: [KALMA().id, 99999] })).status, 400);
  assert.equal((await postRide({ stops: [KALMA().id, place('Lahore', 'Thokar Niaz Baig').id] })).status, 400);
});

test('rides with stops: per-km fares for each part of the route, found from any stop', async () => {
  const res = await postRide({ stops: [KALMA().id, GUJRANWALA().id, SADDAR().id], fare_per_km: 8 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const ride = res.body[0];
  assert.equal(ride.from_city, 'Lahore');
  assert.equal(ride.to_city, 'Rawalpindi');
  assert.equal(ride.fare_per_km, 8);
  const [a, b, c] = ride.stops;
  assert.equal(a.km, 0);
  assert.ok(b.km > 50 && b.km < 100, `Gujranwala at ${b.km} km`);
  assert.equal(ride.price_per_seat, Math.round((c.km * 8) / 10) * 10);
  assert.ok(ride.duration_minutes >= 180, 'travel time estimated from the stops (drivers can adjust it)');

  // Someone in Gujranwala finds the Lahore ride and pays only for their part.
  const found = (await call('GET', '/rides?from=Gujranwala&to=Rawalpindi')).body.find((r) => r.id === ride.id);
  assert.ok(found, 'found from an intermediate stop');
  assert.deepEqual([found.segment.board, found.segment.alight], [1, 2]);
  assert.equal(found.segment.km, c.km - b.km);
  assert.equal(found.your_price, Math.round(((c.km - b.km) * 8) / 10) * 10);
  assert.ok(found.your_price < ride.price_per_seat);
  assert.ok((await call('GET', '/rides?from=Lahore&to=Gujranwala')).body.some((r) => r.id === ride.id));
  assert.ok(!(await call('GET', '/rides?from=Rawalpindi&to=Lahore')).body.some((r) => r.id === ride.id), 'not backwards');

  // Booking that part of the route.
  const p = await register();
  assert.equal((await call('POST', `/rides/${ride.id}/bookings`, { token: p.token, body: { board_stop: 2, alight_stop: 1 } })).status, 400);
  const bk = await call('POST', `/rides/${ride.id}/bookings`, { token: p.token, body: { board_stop: 1, alight_stop: 2 } });
  assert.equal(bk.status, 201);
  assert.equal(bk.body.price_per_seat, found.your_price);
  assert.equal(bk.body.segment_km, c.km - b.km);
  const mine = (await call('GET', '/me/bookings', { token: p.token })).body[0];
  assert.equal(mine.board_name, `${GUJRANWALA().name}, Gujranwala`);
  assert.equal(mine.alight_name, 'Saddar, Rawalpindi');
  const detail = (await call('GET', `/rides/${ride.id}?board=1&alight=2`, { token: p.token })).body;
  assert.equal(detail.segment.fare, found.your_price);
});

test('home pickup: charged by distance within the driver’s radius, commission-free for the driver', async () => {
  const k = KALMA();
  const noHome = (await postRide({ stops: [k.id, SADDAR().id], fare_per_km: 8 })).body[0];
  const ride = (await postRide({ stops: [k.id, SADDAR().id], fare_per_km: 8, home_pickup: true, home_drop: true, home_radius_km: 5 })).body[0];
  assert.equal(ride.home_pickup, true);
  assert.equal(ride.home_radius_km, 5);
  assert.equal((await postRide({ stops: [k.id, SADDAR().id], fare_per_km: 8, home_pickup: true, home_radius_km: 50 })).status, 400, 'radius capped by admin');

  const p = await register();
  const near = { lat: k.lat + 0.015, lon: k.lon, address: 'House 12, Street 4, Gulberg III' };
  assert.match((await call('POST', `/rides/${noHome.id}/bookings`, { token: p.token, body: { home_pickup: near } })).body.error, /does not offer home pickup/);
  assert.match((await call('POST', `/rides/${ride.id}/bookings`, { token: p.token, body: { home_pickup: { ...near, lat: k.lat + 0.2 } } })).body.error, /up to 5 km/);
  assert.match((await call('POST', `/rides/${ride.id}/bookings`, { token: p.token, body: { home_pickup: { ...near, address: '' } } })).body.error, /address/);

  const bk = (await call('POST', `/rides/${ride.id}/bookings`, { token: p.token, body: { home_pickup: near } })).body;
  assert.equal(bk.home_pickup.address, near.address);
  assert.ok(bk.home_pickup.km > 1.5 && bk.home_pickup.km < 3, `got ${bk.home_pickup.km} km`);
  assert.equal(bk.home_charge, 150, 'minimum charge for a short distance');
  const driverView = (await call('GET', `/rides/${ride.id}`, { token: driver.token })).body;
  assert.equal(driverView.bookings[0].home_pickup.address, near.address);

  // Commission is 10% of the seat fare only, not of the home charge.
  const confirmed = (await call('POST', `/bookings/${bk.id}/confirm`, { token: driver.token })).body;
  assert.equal(confirmed.driver_fee, Math.ceil(ride.price_per_seat / 10));

  setSettings(db, { home_pickup_per_km: 100 });
  const p2 = await register();
  const far = { lat: k.lat + 0.03, lon: k.lon, address: 'Model Town' };
  const bk2 = (await call('POST', `/rides/${ride.id}/bookings`, { token: p2.token, body: { home_drop: { ...far, lat: SADDAR().lat + 0.02, lon: SADDAR().lon } } })).body;
  assert.ok(bk2.home_charge > 150 && bk2.home_charge % 10 === 0, `per-km charge above the minimum, got ${bk2.home_charge}`);
  setSettings(db, { home_pickup_per_km: 50 });
});

test('sharing benefits: less commission as the car fills, bonus points when completed', async () => {
  const ride = (await postRide({ stops: [KALMA().id, SADDAR().id], fare_per_km: 8 })).body[0];
  const fare = ride.price_per_seat;
  const fees = [];
  for (let i = 0; i < 3; i++) {
    const p = await register();
    const bk = (await call('POST', `/rides/${ride.id}/bookings`, { token: p.token, body: {} })).body;
    fees.push((await call('POST', `/bookings/${bk.id}/confirm`, { token: driver.token })).body);
  }
  assert.deepEqual(fees.map((f) => f.commission_discount_pct), [0, 25, 50]);
  assert.deepEqual(fees.map((f) => f.driver_fee), [Math.ceil(fare * 0.1), Math.ceil(fare * 0.075), Math.ceil(fare * 0.05)]);

  db.prepare('UPDATE users SET reliability = 80 WHERE id = ?').run(driver.user.id);
  db.prepare('UPDATE rides SET departure_at = ? WHERE id = ?').run(inHours(-1), ride.id);
  await call('POST', `/rides/${ride.id}/complete`, { token: driver.token });
  const me = (await call('GET', '/me', { token: driver.token })).body;
  assert.equal(me.reliability, 80 + 2 + 2, 'base reward + 1 point for each extra passenger');
});

test('ride requests match rides that pass through on the way', async () => {
  const p = await register();
  const day = new Date(Date.now() + 2 * 864e5);
  const reqBody = { from_city: 'Gujranwala', to_city: 'Rawalpindi', earliest_at: new Date(day - 864e5).toISOString(), latest_at: new Date(+day + 864e5).toISOString() };
  assert.equal((await call('POST', '/ride-requests', { token: p.token, body: reqBody })).status, 201);
  const ride = (await postRide({ stops: [KALMA().id, GUJRANWALA().id, SADDAR().id], fare_per_km: 8, departure_at: day.toISOString() })).body[0];
  const note = (await call('GET', '/notifications', { token: p.token })).body[0];
  assert.match(note.title, /matches your request: Gujranwala → Rawalpindi/);
  assert.equal(note.link, `/ride/${ride.id}?from=Gujranwala&to=Rawalpindi`);
});

test('admin can load real road distances from a map routing service', async () => {
  // A stand-in for OSRM's table service: every pair is 123.4 km.
  const osrm = http.createServer((req, res) => {
    assert.match(req.url, /^\/table\/v1\/driving\//);
    const n = CITIES.length;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 'Ok', distances: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : 123400))) }));
  }).listen(0);
  await new Promise((r) => osrm.once('listening', r));
  process.env.ROUTING_URL = `http://127.0.0.1:${osrm.address().port}`;
  try {
    assert.equal(cityRoadKm(db, 'Lahore', 'Islamabad'), 375, 'built-in estimate before');
    const res = await call('POST', '/admin/distances/refresh', { token: admin.token });
    assert.equal(res.body.updated, (CITIES.length * (CITIES.length - 1)) / 2);
    assert.equal(cityRoadKm(db, 'Lahore', 'Islamabad'), 123);
    assert.equal((await call('GET', '/route-estimate?from=Lahore&to=Islamabad')).body.distance_km, 123);
  } finally {
    delete process.env.ROUTING_URL;
    osrm.close();
    db.prepare('DELETE FROM route_distances').run();
  }
  process.env.ROUTING_URL = 'http://127.0.0.1:1';
  assert.equal((await call('POST', '/admin/distances/refresh', { token: admin.token })).status, 502);
  delete process.env.ROUTING_URL;
});

test('road shapes for maps come from the routing service once, then from the cache', async () => {
  const http = require('node:http');
  let calls = 0;
  const osrm = http.createServer((req, res) => {
    calls += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 'Ok', routes: [{ geometry: { coordinates: [[74.24, 31.47], [74.0, 32.0], [73.08, 33.66]] } }] }));
  }).listen(0);
  await new Promise((r) => osrm.once('listening', r));
  process.env.ROUTING_URL = `http://127.0.0.1:${osrm.address().port}`;
  const srv = await startServer();
  try {
    const q = '/route-shape?points=' + encodeURIComponent('31.4705,74.2407;33.664,73.082');
    const first = await srv.call('GET', q);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.legs[0][1], [32, 74]);
    await srv.call('GET', q);
    assert.equal(calls, 1, 'second request served from the cache');
    assert.equal((await srv.call('GET', '/route-shape?points=1,2')).status, 400);
  } finally {
    delete process.env.ROUTING_URL;
    srv.close();
    osrm.close();
  }
});
