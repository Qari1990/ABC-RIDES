const { HttpError } = require('./errors');

// Onboarding requirements the admin can switch on or off (see settings.js).
// Errors carry a code so the app can send the user to the right setup step.
function blocked(code, message) {
  const err = new HttpError(403, message);
  err.code = code;
  return err;
}

function requirePhone(settings, user) {
  if (settings.require_phone_verification && !user.phone_verified) {
    throw blocked('phone_unverified', 'Please verify your phone number first.');
  }
}

function requireBookingIdentity(settings, user) {
  requirePhone(settings, user);
  if (settings.require_id_for_booking && user.verification_status !== 'verified') {
    throw blocked('id_required', 'Please verify your identity (CNIC) before booking.');
  }
}

function requireDriver(settings, user) {
  requirePhone(settings, user);
  if (settings.require_driver_approval && user.driver_status !== 'approved') {
    throw blocked('driver_required', user.driver_status === 'pending'
      ? 'Your driver application is under review. You can post rides once it is approved.'
      : 'Please complete driver registration (CNIC, licence and vehicle) before posting rides.');
  }
}

function isVerifiedStudent(settings, user) {
  if (!user || user.traveler_type !== 'student') return false;
  return !settings.student_price_requires_verification || user.student_status === 'verified';
}

// Whether a ride confirms bookings instantly, given the admin's booking mode.
function instantBooking(settings, ride) {
  if (settings.booking_mode === 'instant') return true;
  if (settings.booking_mode === 'manual') return false;
  return !!ride.instant_book;
}

module.exports = { requirePhone, requireBookingIdentity, requireDriver, isVerifiedStudent, instantBooking };
