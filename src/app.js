const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const svc = require('./bookings');

const API_KEY = process.env.API_KEY;
if (!API_KEY) throw new Error('API_KEY is not set');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
const json = express.json({ limit: '1mb' });

// Let browsers call the API directly too (they still need the key).
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Idempotency-Key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Expose-Headers', 'Retry-After');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const send = (res) => (r) => {
  if (r.headers) res.set(r.headers);
  res.status(r.status).json(r.body);
};
const wrap = (fn) => (req, res, next) => fn(req).then(send(res), next);

// ------------------------------------------------- public: health + web page
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.redirect(302, '/app/'));
app.use('/app', express.static(path.join(__dirname, '..', 'public')));

// The web page talks to these. They run the exact same booking logic
// (validation, double-booking guard, idempotency, rate limit) but never expose
// /reset or listing by email, so the API key stays on the server.
const ui = express.Router();
ui.use(json);
ui.get('/slots', wrap((req) => svc.listSlots(req.query)));
ui.post('/bookings', wrap((req) => svc.createBooking(req.body, req.get('Idempotency-Key'))));
ui.get('/bookings/:id', wrap((req) => svc.getBooking(req.params.id)));
ui.delete('/bookings/:id', wrap((req) => svc.cancelBooking(req.params.id)));
app.use('/ui', ui);

// ------------------------------------------------- the API (level 2: key required)
function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
app.use((req, res, next) => {
  const key = req.get('X-API-Key');
  if (!key || !timingSafeEqual(key, API_KEY)) {
    return res.status(401).json({ error: 'missing or invalid API key' });
  }
  next();
});
app.use(json); // parsed only after the key check, so a bad key is always 401

app.post('/reset', wrap((req) => svc.resetSlots(req.body)));
app.get('/slots', wrap((req) => svc.listSlots(req.query)));
app.post('/bookings', wrap((req) => svc.createBooking(req.body, req.get('Idempotency-Key'))));
app.get('/bookings', wrap((req) => svc.listBookings(req.query)));
app.get('/bookings/:id', wrap((req) => svc.getBooking(req.params.id)));
app.delete('/bookings/:id', wrap((req) => svc.cancelBooking(req.params.id)));

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'body must be valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'body too large' });
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

module.exports = app;
