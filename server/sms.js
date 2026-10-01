// Sends SMS through any HTTP gateway (most Pakistani SMS providers offer one).
// Set SMS_GATEWAY_URL to the provider's send URL with {to} and {message}
// placeholders, for example:
//   https://api.example-sms.pk/send?key=SECRET&to={to}&text={message}
// Without it the app runs in "development mode": codes are shown on screen
// instead of being sent, which is fine for testing but not for real users.
const smsConfigured = () => !!process.env.SMS_GATEWAY_URL;

async function sendSms(to, message) {
  const url = process.env.SMS_GATEWAY_URL
    .replace('{to}', encodeURIComponent(to))
    .replace('{message}', encodeURIComponent(message));
  const res = await fetch(url, { method: process.env.SMS_GATEWAY_METHOD || 'GET' });
  if (!res.ok) throw new Error(`SMS gateway answered ${res.status}`);
}

// "0300 1234567", "+92-300-1234567" and "923001234567" all become "923001234567".
function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('0092')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = `92${digits.slice(1)}`;
  return digits;
}

module.exports = { smsConfigured, sendSms, normalizePhone };
