const { HttpError } = require('./errors');

// Map background tiles. OpenStreetMap's own servers are fine for testing and
// small apps; for heavy use point MAP_TILE_URL at a tile provider (MapTiler,
// Stadia, Thunderforest...) with your key.
const MAP_TILE_URL = process.env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const MAP_ATTRIBUTION = process.env.MAP_ATTRIBUTION || '© OpenStreetMap contributors';

// The tile host for the content security policy ({s} subdomains become *).
function tileOrigin() {
  try {
    const u = new URL(MAP_TILE_URL.replace(/\{s\}\./, 'x.').replace(/\{[a-z]+\}/gi, '0'));
    return `${u.protocol}//${/\{s\}\./.test(MAP_TILE_URL) ? `*.${u.host.split('.').slice(1).join('.')}` : u.host}`;
  } catch {
    return '';
  }
}

// Browser hardening for the web app and API.
function securityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: ${tileOrigin()}`.trim(), "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
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

module.exports = {
  mapConfig: () => ({ tile_url: MAP_TILE_URL, attribution: MAP_ATTRIBUTION }), securityHeaders, rateLimiter };
