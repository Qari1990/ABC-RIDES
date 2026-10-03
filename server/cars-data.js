// Cars common on Pakistani roads, for driver registration. Engine sizes and
// seat counts are the usual versions; drivers pick the closest match or
// "Other" and enter their own details.
//
// [make, model, body type, engine cc, passenger seats, class]
// Classes decide the fare factor (see CAR_CLASSES and Admin → Settings).
const CARS = [
  ['Suzuki', 'Mehran', 'hatchback', 800, 3, 'economy'],
  ['Suzuki', 'Alto', 'hatchback', 660, 3, 'economy'],
  ['Suzuki', 'Wagon R', 'hatchback', 1000, 4, 'economy'],
  ['Suzuki', 'Cultus', 'hatchback', 1000, 4, 'economy'],
  ['Suzuki', 'Swift', 'hatchback', 1200, 4, 'standard'],
  ['Suzuki', 'Ciaz', 'sedan', 1400, 4, 'standard'],
  ['Suzuki', 'Bolan (Carry)', 'van', 800, 6, 'van'],
  ['Suzuki', 'Every', 'van', 660, 5, 'van'],
  ['Suzuki', 'APV', 'van', 1500, 6, 'van'],
  ['Suzuki', 'Vitara', 'suv', 1600, 4, 'suv'],
  ['Daihatsu', 'Mira', 'hatchback', 660, 3, 'economy'],
  ['Daihatsu', 'Cuore', 'hatchback', 850, 3, 'economy'],
  ['Toyota', 'Vitz', 'hatchback', 1000, 4, 'economy'],
  ['Toyota', 'Passo', 'hatchback', 1000, 4, 'economy'],
  ['Toyota', 'Yaris', 'sedan', 1300, 4, 'standard'],
  ['Toyota', 'Corolla', 'sedan', 1600, 4, 'standard'],
  ['Toyota', 'Corolla Altis Grande', 'sedan', 1800, 4, 'premium'],
  ['Toyota', 'Corolla Cross', 'suv', 1800, 4, 'suv'],
  ['Toyota', 'Aqua / Prius (hybrid)', 'hatchback', 1500, 4, 'standard'],
  ['Toyota', 'Camry', 'sedan', 2500, 4, 'premium'],
  ['Toyota', 'Fortuner', 'suv', 2700, 6, 'suv'],
  ['Toyota', 'Hilux', 'pickup', 2800, 4, 'suv'],
  ['Toyota', 'Prado', 'suv', 2700, 6, 'suv'],
  ['Toyota', 'Land Cruiser', 'suv', 4500, 7, 'suv'],
  ['Toyota', 'Hiace', 'van', 2700, 8, 'van'],
  ['Honda', 'City', 'sedan', 1300, 4, 'standard'],
  ['Honda', 'Civic', 'sedan', 1500, 4, 'premium'],
  ['Honda', 'BR-V', 'mpv', 1500, 6, 'van'],
  ['Honda', 'HR-V', 'suv', 1500, 4, 'suv'],
  ['Honda', 'Accord', 'sedan', 1500, 4, 'premium'],
  ['Honda', 'N-WGN / N-One', 'hatchback', 660, 3, 'economy'],
  ['Hyundai', 'Elantra', 'sedan', 1600, 4, 'premium'],
  ['Hyundai', 'Sonata', 'sedan', 2000, 4, 'premium'],
  ['Hyundai', 'Tucson', 'suv', 2000, 4, 'suv'],
  ['Hyundai', 'Santa Fe', 'suv', 2400, 6, 'suv'],
  ['Hyundai', 'Staria', 'van', 3500, 7, 'van'],
  ['KIA', 'Picanto', 'hatchback', 1000, 4, 'economy'],
  ['KIA', 'Stonic', 'suv', 1400, 4, 'suv'],
  ['KIA', 'Sportage', 'suv', 2000, 4, 'suv'],
  ['KIA', 'Sorento', 'suv', 2400, 6, 'suv'],
  ['KIA', 'Carnival', 'van', 3500, 7, 'van'],
  ['Changan', 'Alsvin', 'sedan', 1500, 4, 'standard'],
  ['Changan', 'Oshan X7', 'suv', 1500, 6, 'suv'],
  ['Changan', 'Karvaan', 'van', 1000, 6, 'van'],
  ['MG', 'MG 3', 'hatchback', 1500, 4, 'standard'],
  ['MG', 'ZS', 'suv', 1500, 4, 'suv'],
  ['MG', 'HS', 'suv', 1500, 4, 'suv'],
  ['Haval', 'Jolion', 'suv', 1500, 4, 'suv'],
  ['Haval', 'H6', 'suv', 1500, 4, 'suv'],
  ['Proton', 'Saga', 'sedan', 1300, 4, 'standard'],
  ['Proton', 'X70', 'suv', 1800, 4, 'suv'],
  ['Peugeot', '2008', 'suv', 1600, 4, 'suv'],
  ['Nissan', 'Dayz', 'hatchback', 660, 3, 'economy'],
  ['Nissan', 'Sunny', 'sedan', 1300, 4, 'standard'],
  ['DFSK', 'Glory 580', 'suv', 1800, 6, 'suv'],
  ['United', 'Bravo', 'hatchback', 800, 3, 'economy'],
  ['Prince', 'Pearl', 'hatchback', 800, 3, 'economy'],
];

// Fare factors are admin settings (fare_factor_<class>); these are labels and examples.
const CAR_CLASSES = {
  economy: { label: 'Economy', examples: 'Mehran, Alto, Cultus, Wagon R, Vitz', body: 'small hatchback, up to 1000 cc' },
  standard: { label: 'Standard', examples: 'City, Corolla, Yaris, Swift, Alsvin', body: 'sedan or hatchback, 1000–1600 cc' },
  premium: { label: 'Premium', examples: 'Civic, Elantra, Altis Grande, Sonata', body: 'large or premium sedan' },
  suv: { label: 'SUV', examples: 'Sportage, Tucson, Fortuner, H6, Corolla Cross', body: 'SUV or crossover' },
  van: { label: 'Van / MPV', examples: 'BR-V, APV, Bolan, Hiace, Carnival', body: '6–8 seat van or MPV' },
};

const BODY_TYPES = ['hatchback', 'sedan', 'suv', 'mpv', 'van', 'pickup'];

// Extras drivers can tick; shown to passengers.
const CAR_FEATURES = {
  heater: 'Heater',
  music: 'Music / USB',
  charging: 'Phone charging',
  big_boot: 'Large boot (2+ suitcases)',
  roof_rack: 'Roof rack',
  child_seat: 'Child seat',
  no_smoking: 'No smoking',
  pets_ok: 'Pets allowed',
  wifi: 'Wi-Fi',
};

/** The class of a car that isn't in the list, from its body type and engine. */
function classFor(body, cc) {
  if (body === 'suv' || body === 'pickup') return 'suv';
  if (body === 'van' || body === 'mpv') return 'van';
  if (body === 'hatchback' && cc <= 1000) return 'economy';
  if (cc > 1600) return 'premium';
  return 'standard';
}

module.exports = { CARS, CAR_CLASSES, BODY_TYPES, CAR_FEATURES, classFor };
