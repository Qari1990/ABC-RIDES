// Sends email through Brevo's free plan (300 emails a day, no domain needed:
// verify the sender address once in Brevo). Set:
//   BREVO_API_KEY  the API key from Brevo → SMTP & API → API keys
//   EMAIL_FROM     the verified sender address, e.g. abcrides.pk@gmail.com
// Render's free plan blocks SMTP ports, so this uses Brevo's HTTPS API.
// EMAIL_API_URL overrides the endpoint (used by the tests).
const emailConfigured = () => Boolean(process.env.BREVO_API_KEY && process.env.EMAIL_FROM);

async function sendEmail(to, subject, text) {
  const res = await fetch(process.env.EMAIL_API_URL || 'https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: process.env.EMAIL_FROM, name: process.env.EMAIL_FROM_NAME || 'ABC Rides' },
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
  });
  if (!res.ok) throw new Error(`Email service answered ${res.status}`);
}

module.exports = { emailConfigured, sendEmail };
