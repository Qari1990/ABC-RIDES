// Cars: checking what drivers enter against the catalog, and the fare factor
// each car gets from its class and air conditioning (Admin → Settings). The
// same rules are shown to everyone on the "How fares work" page.
const { bad, str, int } = require('./errors');
const { CARS, CAR_CLASSES, BODY_TYPES, CAR_FEATURES, classFor } = require('./cars-data');

const PLATE_RE = /^(?=.*\d)[A-Z0-9][A-Z0-9 -]{2,11}$/i;

const catalogCar = (make, model) => CARS.find(([mk, md]) => mk.toLowerCase() === String(make || '').toLowerCase()
  && md.toLowerCase() === String(model || '').toLowerCase());

/**
 * Checks a car from a form: { make, model, year, color, plate, seats, ac,
 * features, body_type, engine_cc }. Cars from the catalog take its body
 * type, engine and class; others ("Other") need body type and engine size.
 */
function validateVehicle(v = {}) {
  const year = new Date().getFullYear();
  const make = str(v.make, 'Car make', { required: true, max: 30 });
  const model = str(v.model, 'Car model', { required: true, max: 40 });
  const known = catalogCar(make, model);
  const body = known ? known[2] : str(v.body_type, 'Body type', { required: true, max: 12 }).toLowerCase();
  if (!BODY_TYPES.includes(body)) throw bad(`Body type must be one of: ${BODY_TYPES.join(', ')}`);
  const engine = known ? known[3] : int(v.engine_cc, 'Engine size (cc)', { min: 600, max: 6000 });
  const maxSeats = known ? known[4] : 8;
  const seats = int(v.seats, 'Passenger seats', { min: 1, max: maxSeats, fallback: maxSeats });
  const plate = str(v.plate, 'Number plate', { required: true, max: 12 }).toUpperCase();
  if (!PLATE_RE.test(plate)) throw bad('Number plate looks invalid, e.g. LEA-1234');
  const features = (Array.isArray(v.features) ? v.features : []).filter((f) => CAR_FEATURES[f]);
  return {
    make: known ? known[0] : make,
    model: known ? known[1] : model,
    year: int(v.year, 'Car year', { min: 1980, max: year + 1 }),
    color: str(v.color, 'Car colour', { required: true, max: 20 }),
    plate,
    seats,
    body_type: body,
    engine_cc: engine,
    car_class: known ? known[5] : classFor(body, engine),
    ac: v.ac === false || v.ac === 0 || v.ac === '0' ? 0 : 1,
    features: [...new Set(features)],
  };
}

/** Fare multiplier for a car: class factor × (no AC factor if there is no AC). */
function carFactor(settings, car) {
  if (!car) return 1;
  const cls = settings[`fare_factor_${car.car_class}`] ?? 100;
  const ac = car.ac === 0 ? settings.no_ac_fare_factor : 100;
  return Math.round(cls * ac) / 10000;
}

/** Per-km fare range for a car: suggested, lowest and highest allowed. */
function fareRange(settings, car, { isPrivate = false } = {}) {
  const f = carFactor(settings, car);
  const r = (n) => Math.round(n * f * 10) / 10;
  return isPrivate
    ? { factor: f, suggested: r(settings.private_per_km), min: r(settings.private_min_per_km), max: r(settings.private_max_per_km) }
    : { factor: f, suggested: r(settings.fare_per_km), min: r(settings.fare_min_per_km), max: r(settings.fare_max_per_km) };
}

const describeVehicle = (v) => (v ? `${v.make} ${v.model}${v.year ? ` ${v.year}` : ''} (${v.color})` : null);

/** The car rows stored with a vehicle, as the API shows them. */
function shapeVehicle(v) {
  if (!v) return null;
  return {
    make: v.make, model: v.model, year: v.year, color: v.color, plate: v.plate, seats: v.seats,
    body_type: v.body_type, engine_cc: v.engine_cc, car_class: v.car_class || 'standard',
    class_label: (CAR_CLASSES[v.car_class] || CAR_CLASSES.standard).label,
    ac: v.ac === 0 ? 0 : 1,
    features: typeof v.features === 'string' ? JSON.parse(v.features || '[]') : (v.features || []),
  };
}

/** Fills in body type, engine and class for cars saved before the catalog existed. */
function backfillVehicles(db) {
  for (const v of db.prepare('SELECT * FROM vehicles WHERE car_class IS NULL').all()) {
    const known = catalogCar(v.make, v.model);
    db.prepare('UPDATE vehicles SET body_type = ?, engine_cc = ?, car_class = ?, ac = COALESCE(ac, 1) WHERE user_id = ?')
      .run(known ? known[2] : 'sedan', known ? known[3] : 1300, known ? known[5] : 'standard', v.user_id);
  }
}

function catalog(settings) {
  return {
    cars: CARS.map(([make, model, body_type, engine_cc, seats, car_class]) => ({ make, model, body_type, engine_cc, seats, car_class })),
    classes: Object.entries(CAR_CLASSES).map(([id, c]) => ({ id, ...c, factor: (settings[`fare_factor_${id}`] ?? 100) / 100 })),
    no_ac_factor: settings.no_ac_fare_factor / 100,
    body_types: BODY_TYPES,
    features: CAR_FEATURES,
  };
}

module.exports = { validateVehicle, carFactor, fareRange, describeVehicle, shapeVehicle, backfillVehicles, catalog, PLATE_RE };
