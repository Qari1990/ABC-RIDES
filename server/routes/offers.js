const express = require('express');
const { requireUser } = require('../auth');
const { transaction } = require('../db');
const { HttpError, bad, str, int, isoDate } = require('../errors');
const { publicUser } = require('./users');
const { getSettings } = require('../settings');
const { requireDriver } = require('../policy');
const { placeKm, cityRoadKm, minutesFor } = require('../geo');
const { roundFare, homeCharge } = require('../fares');
const { confirmBooking, confirmationFee } = require('../wallet');
const { notify, when } = require('../notify');
const { fareRange, shapeVehicle, describeVehicle } = require('../cars');

// Drivers answer a passenger's ride request with an offer (time, price per
// seat, seats in the car) instead of posting a ride and hoping it matches.
// When the passenger accepts, the ride and a confirmed booking are created in
// one go, both sides pay their fee, and each sees the other's contact details.
// Spare seats (if the driver shares them) are then open to other passengers.

const place = (db, id) => (id ? db.prepare('SELECT id, city, name, lat, lon FROM places WHERE id = ?').get(id) || null : null);

/** Road distance of a request (between its points, else between the cities), or null. */
function requestKm(db, r, fromPlace = place(db, r.from_place_id), toPlace = place(db, r.to_place_id)) {
  if (fromPlace && toPlace) return placeKm(db, fromPlace, toPlace);
  return cityRoadKm(db, r.from_city, r.to_city) || null;
}

/** Fare facts for a request: distance, the passenger's price per km, the suggested fair price. */
function fareInfo(db, settings, r) {
  const km = requestKm(db, r);
  if (!km) return null;
  return {
    km,
    // A standard car with AC; drivers' cars scale it (see "How fares work").
    suggested_price: roundFare(km * (r.private ? settings.private_per_km : settings.fare_per_km)),
    per_km: r.private ? settings.private_per_km : settings.fare_per_km,
    offered_per_km: r.max_price ? Math.round((r.max_price / km) * 10) / 10 : null,
  };
}

function shapeOffer(db, settings, o, viewer, request) {
  const driver = db.prepare('SELECT * FROM users WHERE id = ?').get(o.driver_id);
  const vehicle = db.prepare('SELECT make, model, color, year FROM vehicles WHERE user_id = ?').get(o.driver_id);
  const km = requestKm(db, request, place(db, o.from_place_id) || undefined, place(db, o.to_place_id) || undefined);
  const out = {
    id: o.id, request_id: o.request_id, status: o.status, departure_at: o.departure_at, price_per_seat: o.price_per_seat,
    seats_total: o.seats_total, share_remaining: !!o.share_remaining, home_pickup: !!o.home_pickup, home_drop: !!o.home_drop,
    home_radius_km: o.home_radius_km, note: o.note, ride_id: o.ride_id, created_at: o.created_at,
    from_place: place(db, o.from_place_id), to_place: place(db, o.to_place_id),
    km, per_km: km ? Math.round((o.price_per_seat / km) * 10) / 10 : null,
    driver: publicUser(db, driver),
    vehicle: vehicle ? `${vehicle.make} ${vehicle.model} ${vehicle.year} (${vehicle.color})` : null,
  };
  // The passenger sees what accepting will cost them up front.
  if (viewer && viewer.id === request.passenger_id && o.status === 'pending') {
    const fare = request.private ? o.price_per_seat : o.price_per_seat * request.seats;
    const fee = confirmationFee(db, settings, viewer, fare, 'passenger');
    out.passenger_fee = fee.total;
    out.fare_total = fare;
  }
  return out;
}

/** Offers on a request, as the viewer may see them: all for the passenger, their own for a driver. */
function offersFor(db, settings, request, viewer) {
  if (!viewer) return { offers_count: 0, offers: [] };
  const rows = db.prepare('SELECT * FROM request_offers WHERE request_id = ? ORDER BY id DESC').all(request.id);
  const pendingCount = rows.filter((o) => o.status === 'pending').length;
  if (viewer.id === request.passenger_id) {
    return { offers_count: pendingCount, offers: rows.filter((o) => o.status !== 'withdrawn').map((o) => shapeOffer(db, settings, o, viewer, request)) };
  }
  const mine = rows.find((o) => o.driver_id === viewer.id && o.status !== 'withdrawn');
  return { offers_count: pendingCount, my_offer: mine ? shapeOffer(db, settings, mine, viewer, request) : null };
}

function offersRouter(db) {
  const router = express.Router();
  const getRequest = (id) => {
    const r = db.prepare('SELECT * FROM ride_requests WHERE id = ?').get(Number(id));
    if (!r) throw new HttpError(404, 'Ride request not found');
    return r;
  };
  const getOffer = (id) => {
    const o = db.prepare('SELECT * FROM request_offers WHERE id = ?').get(Number(id));
    if (!o) throw new HttpError(404, 'Offer not found');
    return o;
  };
  const isOpen = (r) => r.status === 'open' && r.latest_at > new Date().toISOString();
  const pointIn = (id, city, fallback) => {
    if (id === undefined || id === null || id === '') return fallback || null;
    const p = db.prepare('SELECT * FROM places WHERE id = ? AND active = 1').get(Number(id));
    if (!p || p.city.toLowerCase() !== city.toLowerCase()) throw bad(`Choose a point in ${city}`);
    return p.id;
  };

  // A driver makes (or updates) their offer.
  router.post('/ride-requests/:id/offers', requireUser, (req, res) => {
    const settings = getSettings(db);
    requireDriver(settings, req.user);
    const r = getRequest(req.params.id);
    if (r.passenger_id === req.user.id) throw bad('This is your own request');
    if (!isOpen(r)) throw bad('This request is no longer open');
    const b = req.body || {};

    const departure = isoDate(b.departure_at, 'Departure time');
    if (departure <= new Date()) throw bad('Departure time must be in the future');
    // A little slack around the passenger's window (they still have to accept).
    const slack = 3 * 36e5;
    if (departure < new Date(new Date(r.earliest_at).getTime() - slack) || departure > new Date(new Date(r.latest_at).getTime() + slack)) {
      throw bad(`Leave between ${when(r.earliest_at)} and ${when(r.latest_at)}, when the passenger can travel`);
    }
    const fromPlace = pointIn(b.from_place_id, r.from_city, r.from_place_id);
    const toPlace = pointIn(b.to_place_id, r.to_city, r.to_place_id);
    const km = requestKm(db, r, place(db, fromPlace) || undefined, place(db, toPlace) || undefined);

    const price = int(b.price_per_seat, r.private ? 'Price for the car' : 'Price per seat', { min: 0, max: 100000 });
    const vehicle = db.prepare('SELECT * FROM vehicles WHERE user_id = ?').get(req.user.id);
    const range = fareRange(settings, vehicle ? shapeVehicle(vehicle) : null, { isPrivate: !!r.private });
    const what = r.private ? 'the price for the car' : 'the price per seat';
    if (settings.enforce_fare_limits && km) {
      // Never above the fair maximum for this car; below the minimum only if the passenger asked for that price.
      if (price > km * range.max) throw bad(`For about ${km} km in your car, ${what} can be at most Rs ${roundFare(km * range.max)}`);
      if (price < km * range.min && !(r.max_price && price <= r.max_price)) {
        throw bad(`For about ${km} km in your car, ${what} must be at least Rs ${roundFare(km * range.min)}`);
      }
    }
    if (r.private && vehicle && vehicle.seats < r.seats) throw bad(`They are ${r.seats} people; your car has ${vehicle.seats} passenger seats`);
    // A private trip is never shared.
    const share = r.private ? false : (b.share_remaining === undefined ? true : !!b.share_remaining);
    const seatsTotal = r.private ? (vehicle ? vehicle.seats : r.seats)
      : share ? int(b.seats_total, 'Seats in your car', { min: r.seats, max: 8, fallback: Math.max(r.seats, vehicle ? vehicle.seats : r.seats) }) : r.seats;
    if (vehicle && seatsTotal > vehicle.seats) throw bad(`Your car has ${vehicle.seats} passenger seat(s)`);
    const homePickup = b.home_pickup ? 1 : 0;
    const homeDrop = b.home_drop ? 1 : 0;
    if ((homePickup && !fromPlace) || (homeDrop && !toPlace)) throw bad('Home pickup/drop needs a pickup and drop-off point');
    const homeRadius = homePickup || homeDrop
      ? int(b.home_radius_km, 'Home pickup radius', { min: 1, max: settings.home_max_radius_km, fallback: Math.min(5, settings.home_max_radius_km) })
      : 0;
    const note = str(b.note, 'Note', { max: 300 });

    const fields = [departure.toISOString(), price, seatsTotal, share ? 1 : 0, fromPlace, toPlace, homePickup, homeDrop, homeRadius, note];
    const existing = db.prepare(`SELECT id FROM request_offers WHERE request_id = ? AND driver_id = ? AND status = 'pending'`).get(r.id, req.user.id);
    let id;
    if (existing) {
      db.prepare(`UPDATE request_offers SET departure_at = ?, price_per_seat = ?, seats_total = ?, share_remaining = ?, from_place_id = ?,
        to_place_id = ?, home_pickup = ?, home_drop = ?, home_radius_km = ?, note = ? WHERE id = ?`).run(...fields, existing.id);
      id = existing.id;
    } else {
      id = Number(db.prepare(`INSERT INTO request_offers (departure_at, price_per_seat, seats_total, share_remaining, from_place_id,
        to_place_id, home_pickup, home_drop, home_radius_km, note, request_id, driver_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...fields, r.id, req.user.id).lastInsertRowid);
    }
    notify(db, r.passenger_id,
      `${existing ? 'Updated offer' : 'New offer'} from ${req.user.name}: Rs ${price}${r.private ? ' for the car' : '/seat'}`,
      `${r.from_city} → ${r.to_city}, ${when(departure.toISOString())}${km ? ` · Rs ${(price / km).toFixed(1)}/km` : ''}. Accept it to book.`,
      '/trips?tab=requests');
    res.status(existing ? 200 : 201).json(shapeOffer(db, settings, getOffer(id), req.user, r));
  });

  // The passenger accepts: ride + confirmed booking, fees charged, contacts shared.
  router.post('/offers/:id/accept', requireUser, (req, res) => {
    const settings = getSettings(db);
    const o = getOffer(req.params.id);
    const r = getRequest(o.request_id);
    if (r.passenger_id !== req.user.id) throw new HttpError(403, 'This offer is not for you');
    if (o.status !== 'pending') throw bad(`This offer is ${o.status}`);
    if (!isOpen(r)) throw bad('This request is closed');
    if (o.departure_at <= new Date().toISOString()) throw bad('This offer has expired');
    const driver = db.prepare('SELECT * FROM users WHERE id = ?').get(o.driver_id);
    if (!driver || driver.suspended) throw bad('This driver is no longer available');

    const rideId = transaction(db, () => {
      const from = place(db, o.from_place_id);
      const to = place(db, o.to_place_id);
      const km = requestKm(db, r, from || undefined, to || undefined);
      const stops = from && to ? [
        { place_id: from.id, city: from.city, name: from.name, lat: from.lat, lon: from.lon, km: 0 },
        { place_id: to.id, city: to.city, name: to.name, lat: to.lat, lon: to.lon, km },
      ] : null;
      const vehicleRow = db.prepare('SELECT * FROM vehicles WHERE user_id = ?').get(driver.id);
      const vehicle = vehicleRow ? shapeVehicle(vehicleRow) : null;
      // Payment details as on the driver's latest ride.
      const last = db.prepare('SELECT payment_methods, payment_details FROM rides WHERE driver_id = ? ORDER BY id DESC LIMIT 1').get(driver.id);
      const ride = Number(db.prepare(`
        INSERT INTO rides (driver_id, from_city, to_city, pickup_point, dropoff_point, departure_at, seats_total, price_per_seat,
          vehicle, notes, payment_methods, payment_details, duration_minutes, stops, fare_per_km, home_pickup, home_drop, home_radius_km,
          car_class, car_ac, car_features, private, car_seats)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        driver.id, r.from_city, r.to_city, from ? from.name : null, to ? to.name : null, o.departure_at,
        r.private ? 1 : o.seats_total, o.price_per_seat,
        describeVehicle(vehicle), o.note,
        last ? last.payment_methods : 'cash', last ? last.payment_details : null,
        km ? minutesFor(km) : null, stops ? JSON.stringify(stops) : null, km ? Math.round((o.price_per_seat / km) * 10) / 10 : null,
        o.home_pickup, o.home_drop, o.home_radius_km,
        vehicle ? vehicle.car_class : null, vehicle && vehicle.ac === 0 ? 0 : 1, vehicle ? JSON.stringify(vehicle.features) : null,
        r.private ? 1 : 0, o.seats_total,
      ).lastInsertRowid);
      const rideRow = db.prepare('SELECT * FROM rides WHERE id = ?').get(ride);

      // Home pickup/drop the passenger asked for, if this driver offers it.
      const home = (want, offered, stop, label) => {
        if (!want || !offered || !stop) return null;
        const h = JSON.parse(want);
        return homeCharge(settings, rideRow, stop, { ...h, address: h.address || 'Location shared on the map' }, label);
      };
      const pickupHome = home(r.home_pickup, o.home_pickup, stops && stops[0], 'Home pickup');
      const dropHome = home(r.home_drop, o.home_drop, stops && stops[1], 'Home drop-off');
      const homeTotal = (pickupHome?.charge || 0) + (dropHome?.charge || 0);
      const bookingId = Number(db.prepare(`
        INSERT INTO bookings (ride_id, passenger_id, seats, price_per_seat, status, message, board_stop, alight_stop, segment_km,
          home_pickup, home_drop, home_charge, party_size)
        VALUES (?, ?, ?, ?, 'pending', ?, 0, 1, ?, ?, ?, ?, ?)`).run(
        ride, req.user.id, r.private ? 1 : r.seats, o.price_per_seat, r.notes, km,
        pickupHome ? JSON.stringify(pickupHome) : null, dropHome ? JSON.stringify(dropHome) : null, homeTotal, r.private ? r.seats : null,
      ).lastInsertRowid);
      // Fees for both sides now; throws (and undoes everything) if a wallet is short.
      confirmBooking(db, settings, db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId), rideRow, 'passenger');

      db.prepare(`UPDATE request_offers SET status = 'accepted', ride_id = ? WHERE id = ?`).run(ride, o.id);
      db.prepare(`UPDATE ride_requests SET status = 'closed' WHERE id = ?`).run(r.id);
      for (const other of db.prepare(`SELECT * FROM request_offers WHERE request_id = ? AND status = 'pending'`).all(r.id)) {
        db.prepare(`UPDATE request_offers SET status = 'expired' WHERE id = ?`).run(other.id);
        notify(db, other.driver_id, `${req.user.name} chose another driver`, `${r.from_city} → ${r.to_city}. Thanks for your offer.`, '/requests');
      }
      notify(db, driver.id, `${req.user.name} accepted your offer 🎉`,
        `${r.seats} seat(s), ${r.from_city} → ${r.to_city}, ${when(o.departure_at)}. Their phone number is now on the ride page.`
          + (o.seats_total > r.seats ? ` ${o.seats_total - r.seats} seat(s) are open to other passengers.` : ''), `/ride/${ride}`);
      return ride;
    });
    res.json({ ride_id: rideId });
  });

  router.post('/offers/:id/decline', requireUser, (req, res) => {
    const o = getOffer(req.params.id);
    const r = getRequest(o.request_id);
    if (r.passenger_id !== req.user.id) throw new HttpError(403, 'This offer is not for you');
    if (o.status !== 'pending') throw bad(`This offer is ${o.status}`);
    db.prepare(`UPDATE request_offers SET status = 'declined' WHERE id = ?`).run(o.id);
    notify(db, o.driver_id, `${req.user.name} declined your offer`, `${r.from_city} → ${r.to_city}`, '/requests');
    res.status(204).end();
  });

  router.post('/offers/:id/withdraw', requireUser, (req, res) => {
    const o = getOffer(req.params.id);
    if (o.driver_id !== req.user.id) throw new HttpError(403, 'This is not your offer');
    if (o.status !== 'pending') throw bad(`This offer is ${o.status}`);
    const r = getRequest(o.request_id);
    db.prepare(`UPDATE request_offers SET status = 'withdrawn' WHERE id = ?`).run(o.id);
    notify(db, r.passenger_id, `${req.user.name} withdrew their offer`, `${r.from_city} → ${r.to_city}`, '/trips?tab=requests');
    res.status(204).end();
  });

  return router;
}

module.exports = { offersRouter, offersFor, fareInfo };
