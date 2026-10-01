const express = require('express');
const path = require('node:path');
const { loadUser } = require('./auth');
const cities = require('./cities');
const usersRouter = require('./routes/users');
const ridesRouter = require('./routes/rides');

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use(loadUser(db));
  api.get('/health', (_req, res) => res.json({ ok: true }));
  api.get('/cities', (_req, res) => res.json(cities));
  api.use(usersRouter(db));
  api.use(ridesRouter(db));
  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  return app;
}

module.exports = { createApp };
