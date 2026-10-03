// Pakistani mobile numbers. "0300 1234567", "+92-300-1234567" and
// "923001234567" are all the same number.
const { bad } = require('./errors');

function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('0092')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = `92${digits.slice(1)}`;
  return digits;
}

// 92 + 3xx + 7 digits: 11 digits when written 03xx xxxxxxx.
const isMobile = (phone) => /^923\d{9}$/.test(normalizePhone(phone));

/** Checks a mobile number and returns it as "0300 1234567". */
function validMobile(phone, label = 'Mobile number') {
  const raw = String(phone || '').trim();
  if (!/^[+\d][\d\s-]*$/.test(raw) || !isMobile(raw)) {
    throw bad(`${label} must be a Pakistani mobile number with 11 digits, e.g. 0300 1234567`);
  }
  const d = normalizePhone(raw);
  return `0${d.slice(2, 5)} ${d.slice(5)}`;
}

// CNIC: 13 digits, written 12345-1234567-1. The first digit is the province
// (1–7), and the last digit is odd for men and even for women.
function validCnic(cnic, gender) {
  const raw = String(cnic || '').trim();
  if (!/^\d{5}-?\d{7}-?\d$/.test(raw)) throw bad('CNIC number must have 13 digits, e.g. 35202-1234567-1');
  const digits = raw.replace(/-/g, '');
  if (!/^[1-7]/.test(digits)) throw bad('CNIC number looks invalid: it starts with 1 to 7 (your province)');
  if (/^(\d)\1+$/.test(digits.slice(5, 12))) throw bad('CNIC number looks invalid. Please type it exactly as on your card.');
  const last = Number(digits[12]);
  if ((gender === 'male' && last % 2 === 0) || (gender === 'female' && last % 2 === 1)) {
    throw bad(`The last digit of a CNIC is ${gender === 'male' ? 'odd for men' : 'even for women'}. Please check the number, or your gender in Profile.`);
  }
  return digits;
}

module.exports = { normalizePhone, isMobile, validMobile, validCnic };
