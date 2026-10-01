const { HttpError } = require('./errors');

// Wallet ledger, booking fees and reliability points.
//
// Posting a ride is free. When a booking is confirmed, the driver pays a
// commission and the passenger a booking fee, both a percentage of the fare,
// after each user's first few free confirmations. Users whose reliability has
// dropped below the admin's threshold also pay a flat fee to post a ride or
// confirm a booking. Cancelling a confirmed trip costs reliability points and
// refunds the other side's fee.

// Adds amount (negative to charge) to a wallet and records it.
function applyTxn(db, userId, amount, type, { bookingId = null, rideId = null, note = null } = {}) {
  if (!amount) return null;
  const { wallet_balance: balance } = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(userId);
  const after = balance + amount;
  db.prepare('UPDATE users SET wallet_balance = ? WHERE id = ?').run(after, userId);
  db.prepare(`INSERT INTO wallet_transactions (user_id, amount, type, booking_id, ride_id, note, balance_after)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, amount, type, bookingId, rideId, note, after);
  return after;
}

function confirmationsUsed(db, userId) {
  return db.prepare(`
    SELECT COUNT(*) n FROM bookings b JOIN rides r ON r.id = b.ride_id
    WHERE b.confirmed_at IS NOT NULL AND (b.passenger_id = ? OR r.driver_id = ?)`).get(userId, userId).n;
}

function freeConfirmationsLeft(db, settings, userId) {
  return Math.max(0, settings.free_confirmations - confirmationsUsed(db, userId));
}

const lowReliability = (settings, user) => user.reliability < settings.reliability_threshold;

// Drivers who fill their car pay less commission: the booking that brings the
// ride to 2 passengers gets one discount, to 3 or more a bigger one.
function shareDiscount(db, settings, rideId, seats, excludeBookingId = 0) {
  const prior = db.prepare(`SELECT COALESCE(SUM(seats), 0) n FROM bookings
    WHERE ride_id = ? AND status = 'confirmed' AND id != ?`).get(rideId, excludeBookingId).n;
  const after = prior + seats;
  if (after >= 3) return settings.share_discount_3_pct;
  if (after >= 2) return settings.share_discount_2_pct;
  return 0;
}

// What a user pays when a booking with this fare is confirmed. The fare is
// the seat price only: home pickup/drop charges go to the driver untouched.
function confirmationFee(db, settings, user, fare, role, { discountPct = 0 } = {}) {
  const pct = role === 'driver' ? settings.driver_commission_pct : settings.passenger_commission_pct;
  const free = freeConfirmationsLeft(db, settings, user.id) > 0;
  const commission = free ? 0 : Math.ceil((fare * pct * (100 - discountPct)) / 10000);
  const penalty = lowReliability(settings, user) ? settings.low_reliability_fee : 0;
  return { total: commission + penalty, commission, penalty, free, pct, discountPct };
}

// Fee to post one ride: free unless the driver's reliability is low.
function postingFee(settings, user) {
  return lowReliability(settings, user) ? settings.low_reliability_fee : 0;
}

function insufficient(who, needed, balance) {
  const err = new HttpError(402, who === 'you'
    ? `Your wallet balance (Rs ${balance}) is too low. You need Rs ${needed}. Please top up your wallet.`
    : `The ${who}'s wallet balance is too low to confirm this booking. They have been asked to top up.`);
  // insufficient_balance means "top up your own wallet"; the app sends the user there.
  err.code = who === 'you' ? 'insufficient_balance' : 'other_party_balance';
  err.who = who;
  return err;
}

function describe(fee, label) {
  const parts = [];
  if (fee.commission) parts.push(`${fee.pct}% ${label}${fee.discountPct ? ` (${fee.discountPct}% sharing discount)` : ''}`);
  if (fee.penalty) parts.push('low-reliability fee');
  return parts.join(' + ');
}

// Charges both sides and marks the booking confirmed. Call inside a transaction.
// actor is 'driver' or 'passenger': whoever triggered the confirmation, so the
// error message speaks to them.
function confirmBooking(db, settings, booking, ride, actor) {
  const users = db.prepare('SELECT * FROM users WHERE id IN (?, ?)').all(ride.driver_id, booking.passenger_id);
  const driver = users.find((u) => u.id === ride.driver_id);
  const passenger = users.find((u) => u.id === booking.passenger_id);
  const fare = booking.price_per_seat * booking.seats;
  const discountPct = shareDiscount(db, settings, ride.id, booking.seats, booking.id);
  const dFee = confirmationFee(db, settings, driver, fare, 'driver', { discountPct });
  const pFee = confirmationFee(db, settings, passenger, fare, 'passenger');
  const shortOf = (role, user, fee) => {
    const err = insufficient(actor === role ? 'you' : role, fee.total, user.wallet_balance);
    err.who = role; // who is short, whichever way the message is worded
    return err;
  };
  if (passenger.wallet_balance < pFee.total) throw shortOf('passenger', passenger, pFee);
  if (driver.wallet_balance < dFee.total) throw shortOf('driver', driver, dFee);
  const ref = { bookingId: booking.id, rideId: ride.id };
  if (dFee.total) applyTxn(db, driver.id, -dFee.total, 'commission', { ...ref, note: `${describe(dFee, 'commission')} on Rs ${fare}` });
  if (pFee.total) applyTxn(db, passenger.id, -pFee.total, 'fee', { ...ref, note: `${describe(pFee, 'booking fee')} on Rs ${fare}` });
  db.prepare(`UPDATE bookings SET status = 'confirmed', confirmed_at = ?, driver_fee = ?, passenger_fee = ?,
    commission_discount_pct = ? WHERE id = ?`).run(new Date().toISOString(), dFee.total, pFee.total, discountPct, booking.id);
  return { driverFee: dFee, passengerFee: pFee };
}

function adjustReliability(db, userId, delta) {
  db.prepare('UPDATE users SET reliability = MAX(0, MIN(100, reliability + ?)) WHERE id = ?').run(delta, userId);
}

// Points lost for cancelling; doubled close to departure.
function cancelPenalty(settings, ride, base) {
  const hoursLeft = (new Date(ride.departure_at) - Date.now()) / 36e5;
  return hoursLeft < settings.late_cancel_hours ? base * 2 : base;
}

module.exports = {
  applyTxn, confirmBooking, confirmationFee, shareDiscount, postingFee, freeConfirmationsLeft, adjustReliability, cancelPenalty,
  insufficient, lowReliability,
};
