const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, inHours } = require('./helpers');
const { setSettings } = require('../server/settings');

let db, call, register, close;
before(async () => { ({ db, call, register, close } = await startServer()); });
after(() => close());

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN89+7dfwAJYwPZVXzQ4QAAAABJRU5ErkJggg==';
const giveCar = (u, car) => db.prepare(`INSERT INTO vehicles (user_id, make, model, year, color, plate, seats, body_type, engine_cc, car_class, ac, features)
  VALUES (?, ?, ?, 2020, 'White', ?, ?, ?, ?, ?, ?, '[]')`).run(u.user.id, car.make, car.model, car.plate, car.seats, car.body, car.cc, car.cls, car.ac ?? 1);
const stopsBody = async (extra = {}) => {
  const [lhr] = (await call('GET', '/places?city=Lahore')).body;
  const [isb] = (await call('GET', '/places?city=Islamabad')).body;
  return { stops: [lhr.id, isb.id], departure_at: inHours(30), seats_total: 3, ...extra };
};

test('the car catalog and fare classes are public', async () => {
  const cat = (await call('GET', '/cars')).body;
  assert.ok(cat.cars.find((c) => c.make === 'Honda' && c.model === 'Civic' && c.car_class === 'premium'));
  assert.deepEqual(cat.classes.map((c) => c.id), ['economy', 'standard', 'premium', 'suv', 'van']);
  assert.equal(cat.classes.find((c) => c.id === 'suv').factor, 1.3);
  assert.equal(cat.no_ac_factor, 0.85);
});

test('fares scale with the car class and AC; a temporary car for one ride', async () => {
  setSettings(db, { enforce_fare_limits: true });
  const suvDriver = await register();
  giveCar(suvDriver, { make: 'KIA', model: 'Sportage', plate: 'LEB-111', seats: 4, body: 'suv', cc: 2000, cls: 'suv' });
  // SUV: Rs 8/km × 1.3 = 10.4 suggested; 14 > 11 × 1.3 = 14.3? no: max is 14.3, so 14 is fine but 15 is not.
  const ok = await call('POST', '/rides', { token: suvDriver.token, body: await stopsBody({ fare_per_km: 14 }) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body[0].car.class_label, 'SUV');
  assert.equal(ok.body[0].car.plate, undefined, 'plate hidden in listings');
  assert.equal((await call('POST', '/rides', { token: suvDriver.token, body: await stopsBody({ fare_per_km: 15 }) })).status, 400);
  const def = (await call('POST', '/rides', { token: suvDriver.token, body: await stopsBody() })).body[0];
  assert.equal(def.fare_per_km, 10.4, 'suggested fare for an SUV');

  // An economy car without AC: 8 × 0.9 × 0.85 = 6.1 suggested, at most 11 × 0.765 = 8.4.
  const temp = { make: 'Suzuki', model: 'Mehran', year: 2012, color: 'Blue', plate: 'LXZ-4321', seats: 3, ac: false };
  assert.equal((await call('POST', '/rides', { token: suvDriver.token, body: await stopsBody({ temp_vehicle: temp, seats_total: 3 }) })).status, 400, 'declaration needed');
  const tempRide = (await call('POST', '/rides', { token: suvDriver.token, body: await stopsBody({ temp_vehicle: temp, temp_vehicle_declaration: true, seats_total: 3 }) })).body[0];
  assert.equal(tempRide.fare_per_km, 6.1);
  assert.equal(tempRide.car.temporary, true);
  assert.equal(tempRide.car.class_label, 'Economy');
  assert.equal(tempRide.car.ac, 0);
  assert.match(tempRide.vehicle, /Suzuki Mehran 2012/);
  assert.equal((await call('POST', '/rides', { token: suvDriver.token, body: await stopsBody({ temp_vehicle: temp, temp_vehicle_declaration: true, seats_total: 4 }) })).status, 400, 'a Mehran has 3 seats');
  // The registered car is unchanged.
  assert.equal((await call('GET', '/me', { token: suvDriver.token })).body.vehicle.model, 'Sportage');
  setSettings(db, { enforce_fare_limits: false });
});

test('changing the registered car needs admin approval; small updates apply at once', async () => {
  const driver = await register();
  db.prepare(`UPDATE users SET driver_status = 'approved' WHERE id = ?`).run(driver.user.id);
  giveCar(driver, { make: 'Honda', model: 'City', plate: 'LEA-777', seats: 4, body: 'sedan', cc: 1300, cls: 'standard' });
  const admin = await register();
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(admin.user.id);

  const tweak = await call('POST', '/me/vehicle', { token: driver.token, body: { vehicle: { make: 'Honda', model: 'City', year: 2020, color: 'Black', plate: 'LEA-777', seats: 4, ac: true, features: ['music', 'bogus'] } } });
  assert.equal(tweak.body.vehicle.color, 'Black');
  assert.deepEqual(tweak.body.vehicle.features, ['music']);
  assert.equal(tweak.body.vehicle_change, null);

  const newCar = { make: 'Toyota', model: 'Corolla', year: 2022, color: 'Grey', plate: 'LEC-2468', seats: 4 };
  assert.equal((await call('POST', '/me/vehicle', { token: driver.token, body: { vehicle: newCar, reason: 'Sold my City', driver_declaration: true } })).status, 400, 'photos needed');
  const asked = await call('POST', '/me/vehicle', { token: driver.token, body: { vehicle: newCar, reason: 'Sold my City', driver_declaration: true, vehicle_photo: PNG, registration_photo: PNG } });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.vehicle.model, 'City', 'old car still in use');
  assert.equal(asked.body.vehicle_change.model, 'Corolla');

  const list = (await call('GET', '/admin/vehicle-changes', { token: admin.token })).body;
  assert.equal(list[0].proposed.plate, 'LEC-2468');
  assert.equal(list[0].documents.length, 2);
  assert.equal((await call('POST', `/admin/vehicle-changes/${driver.user.id}/approve`, { token: admin.token })).status, 204);
  const me = (await call('GET', '/me', { token: driver.token })).body;
  assert.equal(me.vehicle.model, 'Corolla');
  assert.equal(me.vehicle.car_class, 'standard');
  assert.equal(me.vehicle_change, null);
});

test('private rides: the whole car for one ID-verified group', async () => {
  const driver = await register();
  giveCar(driver, { make: 'Toyota', model: 'Corolla', plate: 'LED-999', seats: 4, body: 'sedan', cc: 1600, cls: 'standard' });
  const ride = (await call('POST', '/rides', { token: driver.token, body: await stopsBody({ private: true, seats_total: 4, instant_book: true }) })).body[0];
  assert.equal(ride.private, true);
  assert.equal(ride.seats_total, 1);
  assert.equal(ride.car_seats, 4);
  assert.equal(ride.fare_per_km, 18, 'private fare per km for a standard car');
  assert.ok(ride.price_per_seat > 6000, 'price is for the whole car');

  const family = await register({ traveler_type: 'traveler' });
  const noId = await call('POST', `/rides/${ride.id}/bookings`, { token: family.token, body: { seats: 1, party_size: 3 } });
  assert.equal(noId.status, 403);
  assert.equal(noId.body.code, 'id_required');
  db.prepare(`UPDATE users SET verification_status = 'verified' WHERE id = ?`).run(family.user.id);
  assert.equal((await call('POST', `/rides/${ride.id}/bookings`, { token: family.token, body: { seats: 1, party_size: 5 } })).status, 400, 'more people than seats');
  const booked = await call('POST', `/rides/${ride.id}/bookings`, { token: family.token, body: { seats: 1, party_size: 3 } });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  assert.equal(booked.body.price_per_seat, ride.price_per_seat);
  assert.equal(booked.body.party_size, 3);
  const after = (await call('GET', `/rides/${ride.id}`)).body;
  assert.equal(after.seats_left, 0, 'nobody else can join');
  // Private rides only match the whole route in search.
  assert.equal((await call('GET', '/rides?from=Lahore&to=Islamabad')).body.some((r) => r.id === ride.id), false, 'full now');
  assert.equal((await call('POST', '/rides', { token: driver.token, body: { ...(await stopsBody({ private: true })), stops: [...(await stopsBody()).stops.slice(0, 1), (await call('GET', '/places?city=Gujranwala')).body[0].id, (await stopsBody()).stops[1]] } })).status, 400, 'no stops on a private ride');
});
