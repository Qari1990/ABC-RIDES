const express = require('express');
const path = require('node:path');
const { loadUser } = require('./auth');
const { CITIES, estimateRoute } = require('./geo');
const usersRouter = require('./routes/users');
const ridesRouter = require('./routes/rides');
const requestsRouter = require('./routes/requests');
const { offersRouter } = require('./routes/offers');
const messagesRouter = require('./routes/messages');
const adminRouter = require('./routes/admin');
const onboardingRouter = require('./routes/onboarding');
const walletRouter = require('./routes/wallet');
const placesRouter = require('./routes/places');
const trackingRouter = require('./routes/tracking');
const { securityHeaders, rateLimiter } = require('./security');
const { logError } = require('./errorlog');
const { catalog } = require('./cars');
const { getSettings } = require('./settings');

// Photo uploads parse their own, larger bodies.
const LARGE_BODY_PATHS = new Set(['/api/me/verification', '/api/me/driver']);

function createApp(db, { uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads') } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Behind Render's (or any) proxy, use the client's address for rate limits.
  app.set('trust proxy', 1);
  app.use(securityHeaders);
  const json = express.json({ limit: '100kb' });
  // Document uploads parse their own (larger) body.
  app.use((req, res, next) => (LARGE_BODY_PATHS.has(req.path) ? next() : json(req, res, next)));

  const api = express.Router();
  api.use(loadUser(db));
  api.get('/health', (_req, res) => res.json({ ok: true }));
  // Errors from the app on users' phones (see reportError in app.js).
  const errorLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 30, message: 'Too many error reports' });
  api.post('/client-errors', (req, res) => {
    errorLimit.check(req.ip);
    const b = req.body || {};
    logError(db, { source: 'app', message: b.message, detail: b.stack, url: b.url, userId: req.user && req.user.id, userAgent: req.get('user-agent') });
    res.status(204).end();
  });
  api.get('/cities', (_req, res) => res.json(CITIES));
  api.get('/cars', (_req, res) => res.json(catalog(getSettings(db))));
  api.get('/route-estimate', (req, res) => res.json(estimateRoute(db, req.query.from, req.query.to)));
  api.use(usersRouter(db));
  api.use(onboardingRouter(db, { uploadDir }));
  api.use(walletRouter(db));
  api.use(placesRouter(db));
  api.use(ridesRouter(db));
  api.use(requestsRouter(db));
  api.use(offersRouter(db));
  api.use(messagesRouter(db));
  api.use(trackingRouter(db));
  api.use('/admin', adminRouter(db, { uploadDir }));
  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  app.use(express.static(path.join(__dirname, '..', 'public')));
  // Map library (Leaflet), served from our own domain.
  app.use('/vendor/leaflet', express.static(path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist'), { maxAge: '7d' }));

  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large' });
    const status = err.status || 500;
    if (status >= 500 && !err.expected) {
      console.error(err);
      logError(db, { source: 'server', message: err.message, detail: err.stack, url: `${req.method} ${req.originalUrl}`, userId: req.user && req.user.id, userAgent: req.get('user-agent') });
    }
    if (err.retryAfter) res.set('retry-after', String(err.retryAfter));
    res.status(status).json({ error: status >= 500 && !err.expected ? 'Something went wrong' : err.message, ...(err.code && (status < 500 || err.expected) ? { code: err.code } : {}) });
  });

  return app;
}

module.exports = { createApp };
