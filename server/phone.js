// Phone numbers in one shape, so "0300 1234567", "+92-300-1234567" and
// "923001234567" are recognised as the same number.
function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('0092')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = `92${digits.slice(1)}`;
  return digits;
}

module.exports = { normalizePhone };
