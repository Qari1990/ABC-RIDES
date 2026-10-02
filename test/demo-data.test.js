const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { seedDemo, removeDemoData } = require('../server/seed');

test('going live removes demo accounts and their rides, keeps real users', async () => {
  const { db, call, register, close } = await startServer();
  try {
    seedDemo(db);
    const real = await register({ email: 'real@test.pk', traveler_type: 'traveler' });
    // A real tester booked a demo ride and paid a fee from their wallet.
    const demoRide = db.prepare(`SELECT id FROM rides LIMIT 1`).get();
    const booking = await call('POST', `/rides/${demoRide.id}/bookings`, { token: real.token, body: { seats: 1 } });
    assert.equal(booking.status, 201, JSON.stringify(booking.body));
    db.prepare(`INSERT INTO wallet_transactions (user_id, amount, type, booking_id, ride_id, balance_after) VALUES (?, -50, 'fee', ?, ?, -50)`)
      .run(real.user.id, booking.body.id, demoRide.id);

    assert.equal(removeDemoData(db), 5);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM users WHERE email LIKE '%@example.com'`).get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rides').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bookings').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ride_requests').get().n, 0);
    const txn = db.prepare('SELECT * FROM wallet_transactions WHERE user_id = ?').get(real.user.id);
    assert.equal(txn.amount, -50, 'real wallet history kept');
    assert.equal(txn.booking_id, null);
    assert.equal((await call('GET', '/me', { token: real.token })).status, 200, 'real user still signed in');
    assert.equal(removeDemoData(db), 0, 'safe to run again');
  } finally {
    close();
  }
});
