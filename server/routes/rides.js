const express = require('express');
const { requireUser } = require('../auth');
const { transaction } = require('../db');
const { HttpError, bad, str, int, isoDate } = require('../errors');
const { notify, route, when } = require('../notify');
const { publicUser } = require('./users');
const { estimateRoute, cityRoadKm, placeKm, minutesFor } = require('../geo');
const {
  roundFare, stopsOf, hasStops, segmentKm, segmentFare, findSegment, checkSegment, homeCharge,
} = require('../fares');
const { getSettings } = require('../settings');
const { requireBookingIdentity, requireDriver, isVerifiedStudent, instantBooking } = require('../policy');
const {
  applyTxn, confirmBooking, confirmationFee, shareDiscount, postingFee, adjustReliability, cancelPenalty, insufficient,
} = require('../wallet');

const MAX_DEPARTURES = 30;
const PAYMENT_METHODS = ['cash', 'jazzcash', 'easypaisa', 'bank_transfer'];
const HELD = `status IN ('pending', 'confirmed')`;

const RIDE_COLUMNS = `
  r.*,
  r.seats_total - COALESCE((SELECT SUM(b.seats) FROM bookings b WHERE b.ride_id = r.id AND b.${HELD}), 0) AS seats_left`;

const studentFare = (fare, ride) => Math.round(fare * (100 - ride.student_discount_pct) / 100);
const studentPrice = (ride) => studentFare(ride.price_per_seat, ride);

// Per-seat price for this user between two stops (whole route by default).
function priceFor(settings, ride, user, segment) {
  const fare = segment ? segmentFare(ride, segment.board, segment.alight) : ride.price_per_seat;
  return isVerifiedStudent(settings, user) ? studentFare(fare, ride) : fare;
}

// Home pickup/drop details are stored as JSON.
function shapeBooking(b) {
  return {
    ...b,
    home_pickup: b.home_pickup ? JSON.parse(b.home_pickup) : null,
    home_drop: b.home_drop ? JSON.parse(b.home_drop) : null,
  };
}

// "Kalma Chowk, Lahore": stop names alone (e.g. "City centre") do not say which city.
const stopLabel = (stop) => (stop.name.toLowerCase().includes(String(stop.city).toLowerCase()) ? stop.name : `${stop.name}, ${stop.city}`);

function describeSegment(ride, seg) {
  const stops = stopsOf(ride);
  const fare = segmentFare(ride, seg.board, seg.alight);
  return {
    board: seg.board, alight: seg.alight, from: stopLabel(stops[seg.board]), to: stopLabel(stops[seg.alight]),
    km: segmentKm(ride, seg.board, seg.alight), fare,
    student_fare: studentFare(fare, ride),
  };
}

function paymentMethods(value) {
  const list = Array.isArray(value) ? value : ['cash'];
  const bad_ = list.filter((m) => !PAYMENT_METHODS.includes(m));
  if (!list.length || bad_.length) throw bad(`Payment methods must be from: ${PAYMENT_METHODS.join(', ')}`);
  return [...new Set(list)].join(',');
}

// Payment account details are private; callers add them back for the driver
// and confirmed passengers.
function shapeRide(db, ride, settings = getSettings(db)) {
  const driver = db.prepare('SELECT * FROM users WHERE id = ?').get(ride.driver_id);
  const { payment_details: _hidden, ...rest } = ride;
  const vehicle = db.prepare('SELECT make, model, year, color, seats FROM vehicles WHERE user_id = ?').get(ride.driver_id);
  return {
    ...rest,
    payment_methods: ride.payment_methods.split(','),
    arrival_at: ride.duration_minutes
      ? new Date(new Date(ride.departure_at).getTime() + ride.duration_minutes * 60000).toISOString()
      : null,
    stops: stopsOf(ride).map(({ place_id: placeId, city, name, km, lat, lon }) => ({ place_id: placeId, city, name, km, lat, lon })),
    home_pickup: !!ride.home_pickup,
    home_drop: !!ride.home_drop,
    women_only: !!ride.women_only,
    instant_book: instantBooking(settings, ride),
    student_price: studentPrice(ride),
    driver: { ...publicUser(db, driver), vehicle: vehicle || null },
  };
}

function participants(db, ride) {
  const passengers = db.prepare(`
    SELECT u.id, u.name FROM bookings b JOIN users u ON u.id = b.passenger_id
    WHERE b.ride_id = ? AND b.status = 'confirmed'`).all(ride.id);
  return { driverId: ride.driver_id, passengers };
}

module.exports = function ridesRouter(db) {
  const router = express.Router();

  const getRide = (id) => {
    const ride = db.prepare(`SELECT ${RIDE_COLUMNS} FROM rides r WHERE r.id = ?`).get(Number(id));
    if (!ride) throw new HttpError(404, 'Ride not found');
    return ride;
  };

  const getBooking = (id) => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(id));
    if (!booking) throw new HttpError(404, 'Booking not found');
    return booking;
  };

  // The route of a new ride: stops chosen from popular places (preferred), or
  // just two city names with a price. Either way the fare per km must stay
  // within the admin's limits, so it is fair to passengers and drivers.
  function resolveRoute(settings, b) {
    const limits = settings.enforce_fare_limits
      ? { min: settings.fare_min_per_km, max: settings.fare_max_per_km } : { min: 1, max: 1000 };
    if (Array.isArray(b.stops) && b.stops.length) {
      if (b.stops.length < 2 || b.stops.length > 10) throw bad('A ride needs between 2 and 10 stops');
      if (new Set(b.stops.map(Number)).size !== b.stops.length) throw bad('Each stop can appear only once');
      const places = b.stops.map((id) => {
        const p = db.prepare('SELECT id, city, name, lat, lon FROM places WHERE id = ? AND active = 1').get(Number(id));
        if (!p) throw bad('Unknown pickup or drop-off point');
        return p;
      });
      const first = places[0];
      const last = places[places.length - 1];
      if (first.city === last.city) throw bad('The first and last stops must be in different cities');
      let km = 0;
      const stops = places.map((p, i) => {
        if (i) km += placeKm(db, places[i - 1], p);
        return { place_id: p.id, city: p.city, name: p.name, lat: p.lat, lon: p.lon, km };
      });
      const farePerKm = int(b.fare_per_km, `Fare per km`, { min: limits.min, max: limits.max, fallback: settings.fare_per_km });
      return { from: first.city, to: last.city, stops, km, farePerKm, pricePerSeat: roundFare(km * farePerKm) };
    }
    const from = str(b.from_city, 'From city', { required: true, max: 60 });
    const to = str(b.to_city, 'To city', { required: true, max: 60 });
    if (from.toLowerCase() === to.toLowerCase()) throw bad('From and To cities must be different');
    const pricePerSeat = int(b.price_per_seat, 'Price per seat', { min: 0, max: 100000 });
    const km = cityRoadKm(db, from, to);
    if (km && (pricePerSeat < km * limits.min || pricePerSeat > km * limits.max)) {
      throw bad(`For about ${km} km, the price per seat must be between Rs ${roundFare(km * limits.min)} and Rs ${roundFare(km * limits.max)} (Rs ${limits.min}–${limits.max} per km)`);
    }
    return { from, to, stops: null, km, farePerKm: km ? Math.round(pricePerSeat / km) : null, pricePerSeat };
  }

  // ---- Search & browse ------------------------------------------------------

  router.get('/rides', (req, res) => {
    const q = req.query;
    const now = new Date().toISOString();
    const after = q.after ? isoDate(q.after, 'after').toISOString() : now;
    const where = [`r.status = 'scheduled'`, 'r.departure_at > ?'];
    const params = [after > now ? after : now];
    if (q.before) { where.push('r.departure_at < ?'); params.push(isoDate(q.before, 'before').toISOString()); }
    if (q.women_only === 'true') where.push('r.women_only = 1');
    const seats = int(q.seats, 'seats', { min: 1, max: 8, fallback: 1 });

    // Rides match when they pass through both cities in order, not only when
    // they start and end there; the passenger pays for their part of the route.
    const candidates = db.prepare(`
      SELECT * FROM (SELECT ${RIDE_COLUMNS} FROM rides r WHERE ${where.join(' AND ')})
      WHERE seats_left >= ? ORDER BY departure_at LIMIT 1000`).all(...params, seats);
    const settings = getSettings(db);
    const out = [];
    for (const r of candidates) {
      const seg = findSegment(r, q.from, q.to);
      if (!seg) continue;
      out.push({ ...shapeRide(db, r, settings), segment: describeSegment(r, seg), your_price: priceFor(settings, r, req.user, seg) });
      if (out.length === 100) break;
    }
    res.json(out);
  });

  router.get('/rides/:id', (req, res) => {
    const ride = getRide(req.params.id);
    const me = req.user;
    const settings = getSettings(db);
    // The part of the route the viewer is interested in: ?board=&alight= (stop numbers) or ?from=&to= (cities).
    let seg = null;
    if (req.query.board !== undefined || req.query.alight !== undefined) {
      seg = { board: Number(req.query.board ?? 0), alight: Number(req.query.alight ?? stopsOf(ride).length - 1) };
      checkSegment(ride, seg.board, seg.alight);
    } else if (req.query.from || req.query.to) {
      seg = findSegment(ride, req.query.from, req.query.to);
    }
    seg = seg || { board: 0, alight: stopsOf(ride).length - 1 };
    const out = { ...shapeRide(db, ride, settings), segment: describeSegment(ride, seg), your_price: priceFor(settings, ride, me, seg) };
    const plate = () => db.prepare('SELECT plate FROM vehicles WHERE user_id = ?').get(ride.driver_id)?.plate || null;
    const { passengers } = participants(db, ride);
    out.passengers = passengers.map((p) => ({ id: p.id, name: p.name }));

    if (me && me.id === ride.driver_id) {
      out.payment_details = ride.payment_details;
      out.vehicle_plate = plate();
      out.bookings = db.prepare(`
        SELECT b.*, u.name passenger_name, u.traveler_type passenger_type, u.reliability passenger_reliability,
               CASE WHEN b.status = 'confirmed' THEN u.phone END AS passenger_phone
        FROM bookings b JOIN users u ON u.id = b.passenger_id
        WHERE b.ride_id = ? ORDER BY b.created_at`).all(ride.id).map(shapeBooking);
      // What accepting each pending request would cost the driver.
      for (const bk of out.bookings) {
        if (bk.status !== 'pending') continue;
        const discountPct = shareDiscount(db, settings, ride.id, bk.seats, bk.id);
        bk.driver_fee_preview = confirmationFee(db, settings, me, bk.price_per_seat * bk.seats, 'driver', { discountPct }).total;
        bk.sharing_discount_pct = discountPct;
      }
    } else if (me) {
      const mine = db.prepare(`
        SELECT * FROM bookings WHERE ride_id = ? AND passenger_id = ?
        ORDER BY created_at DESC LIMIT 1`).get(ride.id, me.id);
      out.my_booking = mine ? shapeBooking(mine) : null;
      if (mine && mine.status === 'confirmed') {
        out.driver.phone = db.prepare('SELECT phone FROM users WHERE id = ?').get(ride.driver_id).phone;
        out.payment_details = ride.payment_details;
        out.vehicle_plate = plate();
      }
      // Booking fee per seat for this user, so the app can show the total before booking.
      const fee = confirmationFee(db, settings, me, out.your_price, 'passenger');
      out.booking_fee = { pct: fee.pct, free: fee.free, low_reliability_fee: fee.penalty, per_seat_fare: out.your_price };
    }

    if (me && ride.status === 'completed') {
      const ids = [ride.driver_id, ...passengers.map((p) => p.id)];
      if (ids.includes(me.id)) {
        const candidates = me.id === ride.driver_id
          ? passengers
          : [{ id: ride.driver_id, name: out.driver.name }];
        const done = new Set(db.prepare('SELECT reviewee_id FROM reviews WHERE ride_id = ? AND reviewer_id = ?')
          .all(ride.id, me.id).map((r) => r.reviewee_id));
        out.can_review = candidates.filter((c) => !done.has(c.id));
      }
    }
    res.json(out);
  });

  // ---- Driver: offer & manage rides ----------------------------------------

  router.post('/rides', requireUser, (req, res) => {
    const settings = getSettings(db);
    requireDriver(settings, req.user);
    const b = req.body || {};
    const { from, to, stops, km, farePerKm, pricePerSeat } = resolveRoute(settings, b);
    const homePickup = b.home_pickup ? 1 : 0;
    const homeDrop = b.home_drop ? 1 : 0;
    if ((homePickup || homeDrop) && !stops) throw bad('Home pickup/drop needs pickup and drop-off points chosen from the list');
    const homeRadius = homePickup || homeDrop
      ? int(b.home_radius_km, 'Home pickup radius', { min: 1, max: settings.home_max_radius_km, fallback: Math.min(5, settings.home_max_radius_km) })
      : 0;

    // A single ride, or several for commuters (e.g. every Mon & Fri for a month).
    const raw = Array.isArray(b.departures) ? b.departures : [b.departure_at];
    if (!raw.length || raw.length > MAX_DEPARTURES) throw bad(`Provide between 1 and ${MAX_DEPARTURES} departure times`);
    const departures = [...new Set(raw.map((d) => isoDate(d, 'Departure time').toISOString()))].sort();
    if (departures[0] <= new Date().toISOString()) throw bad('Departure time must be in the future');

    if (b.women_only && req.user.gender !== 'female') {
      throw bad('Only women drivers can offer women-only rides. Set your gender in your profile.');
    }
    const vehicle = db.prepare('SELECT * FROM vehicles WHERE user_id = ?').get(req.user.id);
    const seatsTotal = int(b.seats_total, 'Seats', { min: 1, max: 8 });
    if (vehicle && seatsTotal > vehicle.seats) throw bad(`Your ${vehicle.make} ${vehicle.model} has ${vehicle.seats} passenger seat(s)`);
    // Posting is free, except for drivers whose reliability is below the threshold.
    const fee = postingFee(settings, req.user);
    if (fee * departures.length > req.user.wallet_balance) {
      throw insufficient('you', fee * departures.length, req.user.wallet_balance);
    }

    const fields = [
      req.user.id, from, to,
      stops ? stops[0].name : str(b.pickup_point, 'Pickup point', { max: 120 }),
      stops ? stops[stops.length - 1].name : str(b.dropoff_point, 'Drop-off point', { max: 120 }),
      seatsTotal,
      pricePerSeat,
      int(b.student_discount_pct, 'Student discount', { min: 0, max: 100, fallback: 0 }),
      b.women_only ? 1 : 0,
      b.instant_book ? 1 : 0,
      str(b.vehicle, 'Vehicle', { max: 80 }) || (vehicle ? `${vehicle.make} ${vehicle.model} (${vehicle.color})` : null),
      str(b.notes, 'Notes', { max: 500 }),
      paymentMethods(b.payment_methods),
      str(b.payment_details, 'Payment details', { max: 200 }),
      // Drivers may give their own travel time; otherwise estimate it from the cities.
      int(b.duration_minutes, 'Travel time', {
        min: 15, max: 48 * 60, fallback: km ? minutesFor(km) : estimateRoute(db, from, to)?.duration_minutes ?? null,
      }),
      stops ? JSON.stringify(stops) : null,
      farePerKm,
      homePickup, homeDrop, homeRadius,
    ];
    const insert = db.prepare(`
      INSERT INTO rides (driver_id, from_city, to_city, pickup_point, dropoff_point, seats_total,
        price_per_seat, student_discount_pct, women_only, instant_book, vehicle, notes,
        payment_methods, payment_details, duration_minutes, stops, fare_per_km, home_pickup, home_drop, home_radius_km,
        departure_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const openRequests = db.prepare(`
      SELECT * FROM ride_requests WHERE status = 'open' AND earliest_at <= ? AND latest_at >= ? AND passenger_id != ?`);
    const ids = transaction(db, () => departures.map((d) => {
      const id = Number(insert.run(...fields, d).lastInsertRowid);
      if (fee) applyTxn(db, req.user.id, -fee, 'fee', { rideId: id, note: 'Low-reliability posting fee' });
      // Tell passengers whose request this ride covers, including part of the route.
      const ride = getRide(id);
      for (const m of openRequests.all(d, d, req.user.id)) {
        if (!findSegment(ride, m.from_city, m.to_city)) continue;
        notify(db, m.passenger_id, `A ride matches your request: ${m.from_city} → ${m.to_city}`,
          `${req.user.name} is driving on ${when(d)}`, `/ride/${id}?from=${encodeURIComponent(m.from_city)}&to=${encodeURIComponent(m.to_city)}`);
      }
      return id;
    }));
    res.status(201).json(ids.map((id) => shapeRide(db, getRide(id), settings)));
  });

  // Drivers may update the details passengers rely on, but not the route,
  // time, seats or price once people have booked against them.
  router.patch('/rides/:id', requireUser, (req, res) => {
    const ride = getRide(req.params.id);
    if (ride.driver_id !== req.user.id) throw new HttpError(403, 'Only the driver can edit this ride');
    if (ride.status !== 'scheduled') throw bad(`This ride is ${ride.status}`);
    const b = req.body || {};
    const fields = {
      pickup_point: () => str(b.pickup_point, 'Pickup point', { max: 120 }),
      dropoff_point: () => str(b.dropoff_point, 'Drop-off point', { max: 120 }),
      vehicle: () => str(b.vehicle, 'Vehicle', { max: 80 }),
      notes: () => str(b.notes, 'Notes', { max: 500 }),
      payment_methods: () => paymentMethods(b.payment_methods),
      payment_details: () => str(b.payment_details, 'Payment details', { max: 200 }),
      instant_book: () => (b.instant_book ? 1 : 0),
      duration_minutes: () => int(b.duration_minutes, 'Travel time', { min: 15, max: 48 * 60, fallback: null }),
    };
    const updates = Object.keys(fields).filter((k) => k in b).map((k) => [k, fields[k]()]);
    if (!updates.length) throw bad('Nothing to update');
    db.prepare(`UPDATE rides SET ${updates.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...updates.map(([, v]) => v), ride.id);
    for (const p of participants(db, ride).passengers) {
      notify(db, p.id, 'Ride details updated', `${route(ride)} on ${when(ride.departure_at)}`, `/ride/${ride.id}`);
    }
    res.json(shapeRide(db, getRide(ride.id)));
  });

  router.post('/rides/:id/cancel', requireUser, (req, res) => {
    const ride = getRide(req.params.id);
    if (ride.driver_id !== req.user.id) throw new HttpError(403, 'Only the driver can cancel this ride');
    if (ride.status !== 'scheduled') throw bad(`This ride is already ${ride.status}`);
    const settings = getSettings(db);
    transaction(db, () => {
      const affected = db.prepare(`SELECT * FROM bookings WHERE ride_id = ? AND ${HELD}`).all(ride.id);
      db.prepare(`UPDATE rides SET status = 'cancelled' WHERE id = ?`).run(ride.id);
      db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE ride_id = ? AND ${HELD}`).run(ride.id);
      // Passengers get their fee back; the driver loses reliability for letting confirmed passengers down.
      const confirmed = affected.filter((a) => a.status === 'confirmed');
      for (const a of confirmed) {
        applyTxn(db, a.passenger_id, a.passenger_fee, 'refund', { bookingId: a.id, rideId: ride.id, note: 'Driver cancelled the ride' });
      }
      if (confirmed.length) adjustReliability(db, ride.driver_id, -cancelPenalty(settings, ride, settings.penalty_driver_cancel));
      for (const a of affected) {
        notify(db, a.passenger_id, 'Ride cancelled by the driver',
          `${route(ride)} on ${when(ride.departure_at)}. Search for another ride.`, `/search?from=${encodeURIComponent(ride.from_city)}&to=${encodeURIComponent(ride.to_city)}`);
      }
    });
    res.json(shapeRide(db, getRide(ride.id)));
  });

  router.post('/rides/:id/complete', requireUser, (req, res) => {
    const ride = getRide(req.params.id);
    if (ride.driver_id !== req.user.id) throw new HttpError(403, 'Only the driver can complete this ride');
    if (ride.status !== 'scheduled') throw bad(`This ride is already ${ride.status}`);
    if (ride.departure_at > new Date().toISOString()) throw bad('You can mark a ride completed only after it departs');
    transaction(db, () => {
      db.prepare(`UPDATE rides SET status = 'completed' WHERE id = ?`).run(ride.id);
      // Requests nobody answered before departure lapse.
      db.prepare(`UPDATE bookings SET status = 'rejected' WHERE ride_id = ? AND status = 'pending'`).run(ride.id);
      const { reward_completed: reward, share_bonus_points: bonus } = getSettings(db);
      const { passengers } = participants(db, ride);
      // Sharing the car with more passengers earns the driver extra points.
      const seatsFilled = db.prepare(`SELECT COALESCE(SUM(seats), 0) n FROM bookings WHERE ride_id = ? AND status = 'confirmed'`).get(ride.id).n;
      if (passengers.length) adjustReliability(db, ride.driver_id, reward + bonus * Math.max(0, seatsFilled - 1));
      for (const p of passengers) {
        adjustReliability(db, p.id, reward);
        notify(db, p.id, 'How was your trip?', `Rate ${req.user.name} for ${route(ride)}`, `/ride/${ride.id}`);
      }
    });
    res.json(shapeRide(db, getRide(ride.id)));
  });

  router.get('/me/rides', requireUser, (req, res) => {
    const rides = db.prepare(`
      SELECT ${RIDE_COLUMNS},
        (SELECT COUNT(*) FROM bookings b WHERE b.ride_id = r.id AND b.status = 'pending') AS pending_requests
      FROM rides r WHERE r.driver_id = ? ORDER BY r.departure_at DESC LIMIT 200`).all(req.user.id);
    const settings = getSettings(db);
    res.json(rides.map((r) => shapeRide(db, r, settings)));
  });

  // ---- Passenger: book seats -----------------------------------------------

  router.post('/rides/:id/bookings', requireUser, (req, res) => {
    const b = req.body || {};
    const seats = int(b.seats, 'Seats', { min: 1, max: 8, fallback: 1 });
    const message = str(b.message, 'Message', { max: 300 });

    const settings = getSettings(db);
    requireBookingIdentity(settings, req.user);
    let driverShort = null;
    const booking = transaction(db, () => {
      const ride = getRide(req.params.id);
      if (ride.driver_id === req.user.id) throw bad('You cannot book your own ride');
      if (ride.status !== 'scheduled' || ride.departure_at <= new Date().toISOString()) {
        throw bad('This ride is no longer open for booking');
      }
      if (ride.women_only && req.user.gender !== 'female') throw new HttpError(403, 'This ride is for women only');
      const existing = db.prepare(`SELECT 1 FROM bookings WHERE ride_id = ? AND passenger_id = ? AND ${HELD}`)
        .get(ride.id, req.user.id);
      if (existing) throw new HttpError(409, 'You already have a booking on this ride');
      if (seats > ride.seats_left) throw new HttpError(409, `Only ${ride.seats_left} seat(s) left`);

      // Which part of the route, and optional home pickup/drop near those stops.
      const stops = stopsOf(ride);
      const seg = {
        board: int(b.board_stop, 'Pickup stop', { min: 0, max: stops.length - 1, fallback: 0 }),
        alight: int(b.alight_stop, 'Drop-off stop', { min: 0, max: stops.length - 1, fallback: stops.length - 1 }),
      };
      checkSegment(ride, seg.board, seg.alight);
      if (b.home_pickup && !ride.home_pickup) throw bad('This driver does not offer home pickup');
      if (b.home_drop && !ride.home_drop) throw bad('This driver does not offer home drop-off');
      const pickupHome = homeCharge(settings, ride, stops[seg.board], b.home_pickup, 'Home pickup');
      const dropHome = homeCharge(settings, ride, stops[seg.alight], b.home_drop, 'Home drop-off');
      const homeTotal = (pickupHome?.charge || 0) + (dropHome?.charge || 0);

      const price = priceFor(settings, ride, req.user, seg);
      // Check up front that the passenger can pay the fee charged on confirmation.
      const fee = confirmationFee(db, settings, req.user, price * seats, 'passenger');
      if (req.user.wallet_balance < fee.total) throw insufficient('you', fee.total, req.user.wallet_balance);

      const { lastInsertRowid } = db.prepare(`
        INSERT INTO bookings (ride_id, passenger_id, seats, price_per_seat, status, message,
          board_stop, alight_stop, segment_km, home_pickup, home_drop, home_charge)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`).run(
        ride.id, req.user.id, seats, price, message, seg.board, seg.alight, segmentKm(ride, seg.board, seg.alight),
        pickupHome ? JSON.stringify(pickupHome) : null, dropHome ? JSON.stringify(dropHome) : null, homeTotal,
      );
      let status = 'pending';
      if (instantBooking(settings, ride)) {
        try {
          confirmBooking(db, settings, getBooking(lastInsertRowid), ride, 'passenger');
          status = 'confirmed';
        } catch (err) {
          // The passenger was checked above, so the driver is short: leave the request pending for them.
          if (err.who !== 'driver') throw err;
          driverShort = ride;
        }
      }
      notify(db, ride.driver_id,
        status === 'confirmed' ? `New booking: ${req.user.name}` : `New booking request from ${req.user.name}`,
        `${seats} seat(s), ${stopLabel(stops[seg.board])} → ${stopLabel(stops[seg.alight])}, ${when(ride.departure_at)}`
          + (homeTotal ? ` · home ${pickupHome ? 'pickup' : ''}${pickupHome && dropHome ? ' & ' : ''}${dropHome ? 'drop' : ''} +Rs ${homeTotal}` : '')
          + (driverShort ? '. Top up your wallet to accept it.' : ''), `/ride/${ride.id}`);
      return getBooking(lastInsertRowid);
    });
    res.status(201).json(shapeBooking(booking));
  });

  router.get('/me/bookings', requireUser, (req, res) => {
    const rows = db.prepare(`
      SELECT b.*, r.from_city, r.to_city, r.departure_at, r.pickup_point, r.stops, r.status AS ride_status,
             u.id AS driver_id, u.name AS driver_name,
             CASE WHEN b.status = 'confirmed' THEN u.phone END AS driver_phone
      FROM bookings b JOIN rides r ON r.id = b.ride_id JOIN users u ON u.id = r.driver_id
      WHERE b.passenger_id = ? ORDER BY r.departure_at DESC LIMIT 200`).all(req.user.id);
    res.json(rows.map(({ stops: _s, ...row }) => {
      const stops = stopsOf({ ...row, stops: _s, dropoff_point: null });
      return {
        ...shapeBooking(row),
        board_name: stopLabel(stops[row.board_stop ?? 0]), alight_name: stopLabel(stops[row.alight_stop ?? stops.length - 1]),
      };
    }));
  });

  const driverAction = (to) => (req, res) => {
    const settings = getSettings(db);
    let booking;
    let ride;
    try {
      const updated = transaction(db, () => {
        booking = getBooking(req.params.id);
        ride = getRide(booking.ride_id);
        if (ride.driver_id !== req.user.id) throw new HttpError(403, 'Only the driver can do this');
        if (booking.status !== 'pending') throw bad(`This booking is already ${booking.status}`);
        if (ride.status !== 'scheduled') throw bad(`This ride is ${ride.status}`);
        if (to === 'confirmed') confirmBooking(db, settings, booking, ride, 'driver');
        else db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(to, booking.id);
        notify(db, booking.passenger_id,
          to === 'confirmed' ? 'Booking confirmed 🎉' : 'Booking request declined',
          `${route(ride)} on ${when(ride.departure_at)}`, `/ride/${ride.id}`);
        return getBooking(booking.id);
      });
      res.json(updated);
    } catch (err) {
      // The passenger's balance fell short since they asked; tell them (outside the rolled-back transaction).
      if (err.who === 'passenger') {
        notify(db, booking.passenger_id, 'Top up to confirm your booking',
          `${req.user.name} wants to accept your request for ${route(ride)}, but your wallet balance is too low.`, '/wallet');
      }
      throw err;
    }
  };

  // Pending bookings already hold their seats, so confirming cannot overbook.
  router.post('/bookings/:id/confirm', requireUser, driverAction('confirmed'));
  router.post('/bookings/:id/reject', requireUser, driverAction('rejected'));

  router.post('/bookings/:id/cancel', requireUser, (req, res) => {
    const updated = transaction(db, () => {
      const booking = getBooking(req.params.id);
      if (booking.passenger_id !== req.user.id) throw new HttpError(403, 'This is not your booking');
      if (!['pending', 'confirmed'].includes(booking.status)) throw bad(`This booking is already ${booking.status}`);
      const ride = getRide(booking.ride_id);
      if (ride.status !== 'scheduled') throw bad(`This ride is ${ride.status}`);
      db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(booking.id);
      // Cancelling a confirmed booking refunds the driver's commission and costs the passenger reliability.
      if (booking.status === 'confirmed') {
        const settings = getSettings(db);
        applyTxn(db, ride.driver_id, booking.driver_fee, 'refund', { bookingId: booking.id, rideId: ride.id, note: 'Passenger cancelled' });
        adjustReliability(db, req.user.id, -cancelPenalty(settings, ride, settings.penalty_passenger_cancel));
      }
      notify(db, ride.driver_id, `${req.user.name} cancelled their booking`,
        `${booking.seats} seat(s) freed on ${route(ride)}, ${when(ride.departure_at)}`, `/ride/${ride.id}`);
      return getBooking(booking.id);
    });
    res.json(updated);
  });

  // ---- Reviews -------------------------------------------------------------

  router.post('/rides/:id/reviews', requireUser, (req, res) => {
    const b = req.body || {};
    const ride = getRide(req.params.id);
    if (ride.status !== 'completed') throw bad('You can review only after the ride is completed');
    const revieweeId = int(b.reviewee_id, 'Reviewee', { min: 1 });
    const rating = int(b.rating, 'Rating', { min: 1, max: 5 });
    const comment = str(b.comment, 'Comment', { max: 500 });

    const { driverId, passengers } = participants(db, ride);
    const passengerIds = passengers.map((p) => p.id);
    const me = req.user.id;
    const allowed = (me === driverId && passengerIds.includes(revieweeId))
      || (passengerIds.includes(me) && revieweeId === driverId);
    if (!allowed) throw new HttpError(403, 'You can only review people you travelled with on this ride');
    if (db.prepare('SELECT 1 FROM reviews WHERE ride_id = ? AND reviewer_id = ? AND reviewee_id = ?').get(ride.id, me, revieweeId)) {
      throw new HttpError(409, 'You already reviewed this person for this ride');
    }
    db.prepare('INSERT INTO reviews (ride_id, reviewer_id, reviewee_id, rating, comment) VALUES (?, ?, ?, ?, ?)')
      .run(ride.id, me, revieweeId, rating, comment);
    res.status(201).json({ ok: true });
  });

  return router;
};
