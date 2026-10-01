const { HttpError } = require('./errors');

// Browser hardening for the web app and API.
function securityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()',
  });
  next();
}

// Fixed-window counter kept in memory: enough to slow down password guessing
// and sign-up spam on a single server.
function rateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  timer.unref();
  return {
    // Throws 429 once a key has been hit max times in the window.
    check(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (entry && entry.reset > now && entry.count >= max) {
        const err = new HttpError(429, message);
        err.retryAfter = Math.ceil((entry.reset - now) / 1000);
        throw err;
      }
    },
    hit(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.reset <= now) hits.set(key, { count: 1, reset: now + windowMs });
      else entry.count += 1;
    },
    clear(key) { hits.delete(key); },
  };
}

module.exports = { securityHeaders, rateLimiter };
