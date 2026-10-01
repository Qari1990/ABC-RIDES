const { bad } = require('./errors');
const { haversineKm, ROAD_FACTOR } = require('./geo');

// Fares are a rate per km per seat. A ride lists its stops with the distance
// from the start, so a passenger joining part of the way pays for the
// kilometres they travel.

const roundFare = (n) => Math.max(10, Math.round(n / 10) * 10);

// Stops of a ride: [{place_id, city, name, lat, lon, km}]. Rides posted before
// stops existed get two stops without coordinates.
function stopsOf(ride) {
  if (ride.stops) return JSON.parse(ride.stops);
  return [{ city: ride.from_city, name: ride.pickup_point || ride.from_city, km: 0 },
    { city: ride.to_city, name: ride.dropoff_point || ride.to_city, km: null }];
}

const hasStops = (ride) => !!ride.stops;

function segmentKm(ride, board, alight) {
  const stops = stopsOf(ride);
  return hasStops(ride) ? stops[alight].km - stops[board].km : null;
}

// Fare per seat for travelling from stop `board` to stop `alight`.
function segmentFare(ride, board, alight) {
  const stops = stopsOf(ride);
  if (!hasStops(ride) || (board === 0 && alight === stops.length - 1)) return ride.price_per_seat;
  return roundFare(segmentKm(ride, board, alight) * ride.fare_per_km);
}

const sameCity = (a, b) => String(a || '').toLowerCase() === String(b || '').trim().toLowerCase();

// Where a passenger going fromCity → toCity would board and get off, or null
// if the ride does not go that way. Missing cities mean the ride's ends.
function findSegment(ride, fromCity, toCity) {
  const stops = stopsOf(ride);
  const board = fromCity ? stops.findIndex((s) => sameCity(s.city, fromCity)) : 0;
  if (board < 0) return null;
  let alight = stops.length - 1;
  if (toCity) {
    alight = stops.findIndex((s, i) => i > board && sameCity(s.city, toCity));
    if (alight < 0) return null;
  }
  return board < alight ? { board, alight } : null;
}

function checkSegment(ride, board, alight) {
  const n = stopsOf(ride).length;
  if (!Number.isInteger(board) || !Number.isInteger(alight) || board < 0 || alight >= n || board >= alight) {
    throw bad('Choose where you get on and off, in the order the ride goes');
  }
}

// Extra charge for picking up from (or dropping at) a passenger's home near a stop.
function homeCharge(settings, ride, stop, point, label) {
  if (!point) return null;
  const lat = Number(point.lat);
  const lon = Number(point.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw bad(`${label}: please share the location`);
  if (stop.lat == null) throw bad(`${label} is not available on this ride`);
  const address = String(point.address || '').trim().slice(0, 200);
  if (!address) throw bad(`${label}: please add the address or a landmark`);
  const km = Math.round(haversineKm([stop.lat, stop.lon], [lat, lon]) * ROAD_FACTOR * 10) / 10;
  if (km > ride.home_radius_km) throw bad(`${label}: your location is ${km} km from ${stop.name}; this driver goes up to ${ride.home_radius_km} km`);
  const charge = Math.max(settings.home_pickup_min, roundFare(km * settings.home_pickup_per_km));
  return { address, lat, lon, km, charge };
}

module.exports = { roundFare, stopsOf, hasStops, segmentKm, segmentFare, findSegment, checkSegment, homeCharge };
