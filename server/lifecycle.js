// What happens to rides, bookings, requests and offers as time passes, so
// nothing is left hanging when people forget to tap a button:
// - a ride nobody booked expires half an hour after its departure time;
// - a ride with confirmed passengers completes by itself some hours after its
//   arrival time (Admin → Settings), and everyone is asked to review;
// - booking requests the driver never answered lapse at departure;
// - passenger requests close when their time window ends, with their offers.
const { transaction } = require('./db');
const { getSettings } = require('./settings');
const { notify, route, when } = require('./notify');
const { adjustReliability } = require('./wallet');

const DEFAULT_TRIP_MINUTES = 4 * 60;

function confirmedPassengers(db, rideId) {
  return db.prepare(`SELECT u.id, u.name FROM bookings b JOIN users u ON u.id = b.passenger_id
    WHERE b.ride_id = ? AND b.status = 'confirmed'`).all(rideId);
}

/** Completes a ride: reliability rewards, and a review request to everyone on it. */
function completeRide(db, ride, { auto = false } = {}) {
  const settings = getSettings(db);
  const driver = db.prepare('SELECT id, name FROM users WHERE id = ?').get(ride.driver_id);
  transaction(db, () => {
    db.prepare(`UPDATE rides SET status = 'completed', ended_reason = ? WHERE id = ?`).run(auto ? 'auto_completed' : 'completed', ride.id);
    // Requests nobody answered before departure lapse.
    db.prepare(`UPDATE bookings SET status = 'rejected' WHERE ride_id = ? AND status = 'pending'`).run(ride.id);
    const passengers = confirmedPassengers(db, ride.id);
    // Sharing the car with more passengers earns the driver extra points.
    const seatsFilled = db.prepare(`SELECT COALESCE(SUM(seats), 0) n FROM bookings WHERE ride_id = ? AND status = 'confirmed'`).get(ride.id).n;
    if (passengers.length) {
      adjustReliability(db, ride.driver_id, settings.reward_completed + settings.share_bonus_points * Math.max(0, seatsFilled - 1));
      notify(db, ride.driver_id, 'Trip completed: rate your passengers',
        `${route(ride)}. Your reviews keep ABC Rides safe and update their reliability.`, `/ride/${ride.id}`);
    }
    for (const p of passengers) {
      adjustReliability(db, p.id, settings.reward_completed);
      notify(db, p.id, 'How was your trip?', `Rate ${driver.name} for ${route(ride)}`, `/ride/${ride.id}`);
    }
  });
}

/** One pass of the clock. Safe to run as often as you like. */
function runLifecycle(db, now = new Date()) {
  const settings = getSettings(db);
  const iso = now.toISOString();
  const counts = { expired: 0, completed: 0, lapsed: 0, closed: 0 };

  for (const ride of db.prepare(`SELECT * FROM rides WHERE status = 'scheduled' AND departure_at < ?`).all(iso)) {
    const departed = new Date(ride.departure_at);
    const hasPassengers = confirmedPassengers(db, ride.id).length > 0;
    if (!hasPassengers && now - departed > 30 * 60000) {
      transaction(db, () => {
        db.prepare(`UPDATE rides SET status = 'cancelled', ended_reason = 'expired' WHERE id = ?`).run(ride.id);
        for (const b of db.prepare(`SELECT * FROM bookings WHERE ride_id = ? AND status = 'pending'`).all(ride.id)) {
          db.prepare(`UPDATE bookings SET status = 'rejected' WHERE id = ?`).run(b.id);
          notify(db, b.passenger_id, 'Your booking request lapsed', `${route(ride)} on ${when(ride.departure_at)}: the driver didn’t answer in time.`, '/');
        }
        notify(db, ride.driver_id, 'Your ride expired', `${route(ride)} on ${when(ride.departure_at)} had no confirmed passengers.`, `/ride/${ride.id}`);
      });
      counts.expired += 1;
      continue;
    }
    // Booking requests the driver never answered lapse once the car has left.
    for (const b of db.prepare(`SELECT * FROM bookings WHERE ride_id = ? AND status = 'pending'`).all(ride.id)) {
      db.prepare(`UPDATE bookings SET status = 'rejected' WHERE id = ?`).run(b.id);
      notify(db, b.passenger_id, 'Your booking request lapsed', `${route(ride)}: the driver didn’t answer before leaving.`, '/');
      counts.lapsed += 1;
    }
    const arrival = departed.getTime() + (ride.duration_minutes || DEFAULT_TRIP_MINUTES) * 60000;
    if (hasPassengers && now.getTime() > arrival + settings.auto_complete_hours * 36e5) {
      completeRide(db, ride, { auto: true });
      counts.completed += 1;
    }
  }

  // Passenger requests whose window has passed, and offers that can no longer be taken.
  for (const r of db.prepare(`SELECT * FROM ride_requests WHERE status = 'open' AND latest_at < ?`).all(iso)) {
    db.prepare(`UPDATE ride_requests SET status = 'closed' WHERE id = ?`).run(r.id);
    counts.closed += 1;
  }
  db.prepare(`UPDATE request_offers SET status = 'expired' WHERE status = 'pending'
    AND (departure_at < ? OR request_id IN (SELECT id FROM ride_requests WHERE status != 'open'))`).run(iso);
  // Live locations are only kept while a trip is on; tracking links a day longer.
  db.prepare(`DELETE FROM ride_locations WHERE ride_id IN (SELECT id FROM rides WHERE status != 'scheduled')`).run();
  db.prepare(`DELETE FROM track_links WHERE ride_id IN (SELECT id FROM rides WHERE status != 'scheduled' AND departure_at < ?)`)
    .run(new Date(now.getTime() - 2 * 864e5).toISOString());
  return counts;
}

/** Runs the lifecycle now and then every few minutes. */
function startLifecycle(db, everyMs = 5 * 60000) {
  const tick = () => {
    try {
      runLifecycle(db);
    } catch (err) {
      console.error(`Lifecycle run failed: ${err.message}`);
    }
  };
  tick();
  setInterval(tick, everyMs).unref();
}

module.exports = { runLifecycle, startLifecycle, completeRide };
