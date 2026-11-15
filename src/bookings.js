// Core booking logic. Every function returns { status, body, headers? } so the
// same code serves both the API routes and the web page's routes.
const crypto = require('node:crypto');
const { pool, tx } = require('./db');

const RATE_LIMIT = 5;            // attempts
const RATE_WINDOW_SECONDS = 60;  // per email, sliding window
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ok = (status, body, headers) => ({ status, body, headers });
const fail = (status, error, headers) => ({ status, body: { error }, headers });

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Stable JSON so {"a":1,"b":2} and {"b":2,"a":1} count as the same body. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
const hashBody = (body) => crypto.createHash('sha256').update(canonical(body)).digest('hex');

// ---------------------------------------------------------------- slots

async function resetSlots(body) {
  if (!isPlainObject(body) || !Array.isArray(body.slots)) {
    return fail(400, 'slots must be an array');
  }
  const seen = new Set();
  const rows = [];
  for (const [i, s] of body.slots.entries()) {
    if (!isPlainObject(s)) return fail(400, `slots[${i}] must be an object`);
    for (const f of ['id', 'provider', 'start', 'end']) {
      if (typeof s[f] !== 'string' || s[f].trim() === '') return fail(400, `slots[${i}].${f} is required`);
    }
    const start = Date.parse(s.start);
    const end = Date.parse(s.end);
    if (Number.isNaN(start) || Number.isNaN(end)) return fail(400, `slots[${i}] has an invalid date`);
    if (seen.has(s.id)) return fail(400, `duplicate slot id ${s.id}`);
    seen.add(s.id);
    rows.push([s.id, s.provider, s.start, s.end, new Date(start).toISOString(), new Date(end).toISOString()]);
  }

  await tx(async (c) => {
    // Wipes bookings, stored idempotent responses and rate-limit history too:
    // they all refer to the old slots.
    await c.query('TRUNCATE bookings, slots, idempotency_keys, booking_attempts');
    if (rows.length) {
      const cols = [0, 1, 2, 3, 4, 5].map((j) => rows.map((r) => r[j]));
      await c.query(
        `INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[])`,
        cols,
      );
    }
  });
  return ok(200, { ok: true, slots: rows.length });
}

async function listSlots(query) {
  const provider = typeof query.provider === 'string' ? query.provider : null;
  const { rows } = await pool.query(
    `SELECT s.id, s.provider, s.start_raw, s.end_raw,
            NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s
      WHERE $1::text IS NULL OR s.provider = $1
      ORDER BY s.start_at, s.id`,
    [provider],
  );
  return ok(200, {
    slots: rows.map((r) => ({ id: r.id, provider: r.provider, start: r.start_raw, end: r.end_raw, available: r.available })),
  });
}

// ---------------------------------------------------------------- create booking

/**
 * Level 5: sliding-window limit per email. Runs inside the booking transaction
 * with a per-email advisory lock, so simultaneous requests are counted one at a time.
 * Returns null if allowed (and records the attempt), or the number of seconds to wait.
 */
async function checkRateLimit(c, email) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rate:${email}`]);
  await c.query(
    `DELETE FROM booking_attempts WHERE email = $1 AND at <= clock_timestamp() - make_interval(secs => $2)`,
    [email, RATE_WINDOW_SECONDS],
  );
  const { rows } = await c.query(
    `SELECT count(*)::int AS n,
            ceil(extract(epoch FROM min(at) + make_interval(secs => $2) - clock_timestamp()))::int AS wait
       FROM booking_attempts WHERE email = $1`,
    [email, RATE_WINDOW_SECONDS],
  );
  if (rows[0].n >= RATE_LIMIT) return Math.max(1, rows[0].wait);
  await c.query('INSERT INTO booking_attempts (email) VALUES ($1)', [email]);
  return null;
}

/** Levels 2-3: validate, then insert. Assumes it runs inside a transaction. */
async function bookSlot(c, body) {
  if (!isPlainObject(body)) return fail(400, 'body must be a JSON object');
  for (const f of ['slot_id', 'name', 'email']) {
    if (typeof body[f] !== 'string' || body[f].trim() === '') return fail(400, `${f} is required`);
  }
  const slotId = body.slot_id.trim();
  const name = body.name.trim();
  const email = body.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return fail(400, 'email is invalid');

  const slot = await c.query('SELECT start_at <= now() AS started FROM slots WHERE id = $1', [slotId]);
  if (slot.rowCount === 0) return fail(404, 'slot not found');
  if (slot.rows[0].started) return fail(400, 'slot has already started');

  // The partial unique index is the real guard against double booking. If two
  // requests race, Postgres makes the second wait for the first, then rejects it.
  await c.query('SAVEPOINT book');
  try {
    const { rows } = await c.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed') RETURNING *`,
      [crypto.randomUUID(), slotId, name, email],
    );
    await c.query('RELEASE SAVEPOINT book');
    return ok(201, toBooking(rows[0]));
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT book');
    if (err.code === '23505') return fail(409, 'slot already booked');
    if (err.code === '23503') return fail(404, 'slot not found'); // slot removed by a concurrent reset
    throw err;
  }
}

class Abort extends Error {
  constructor(result) { super('abort'); this.result = result; }
}

/** POST /bookings: idempotency (level 4) -> rate limit (level 5) -> validate and book (levels 1-3). */
async function createBooking(body, idempotencyKey) {
  const key = typeof idempotencyKey === 'string' && idempotencyKey !== '' ? idempotencyKey : null;
  const hash = hashBody(body);
  const email = isPlainObject(body) && typeof body.email === 'string' && body.email.trim() !== ''
    ? body.email.trim().toLowerCase()
    : null;

  try {
    return await tx(async (c) => {
      if (key) {
        // Claim the key. If another request holding the same key is still in
        // flight, Postgres blocks here until it commits, then we replay its answer.
        const claim = await c.query(
          `INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)
           ON CONFLICT (key) DO NOTHING RETURNING key`,
          [key, hash],
        );
        if (claim.rowCount === 0) {
          const { rows } = await c.query(
            'SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1',
            [key],
          );
          const prev = rows[0];
          if (prev.request_hash !== hash) {
            throw new Abort(fail(422, 'Idempotency-Key was already used with a different request body'));
          }
          throw new Abort(ok(prev.status_code, prev.response, { 'Idempotent-Replayed': 'true' }));
        }
      }

      if (email) {
        const wait = await checkRateLimit(c, email);
        if (wait !== null) {
          // Rolls back, so the claimed key is released and a later retry can succeed.
          throw new Abort(fail(429, `too many booking attempts for this email, retry in ${wait}s`, { 'Retry-After': String(wait) }));
        }
      }

      const result = await bookSlot(c, body);
      if (key) {
        await c.query(
          'UPDATE idempotency_keys SET status_code = $2, response = $3 WHERE key = $1',
          [key, result.status, JSON.stringify(result.body)],
        );
      }
      return result;
    });
  } catch (err) {
    if (err instanceof Abort) return err.result;
    throw err;
  }
}

// ---------------------------------------------------------------- read / cancel

async function getBooking(id) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
  if (!rows.length) return fail(404, 'booking not found');
  return ok(200, toBooking(rows[0]));
}

async function cancelBooking(id) {
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) return fail(404, 'booking not found');
    if (rows[0].status === 'cancelled') return fail(409, 'booking already cancelled');
    const upd = await c.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1 RETURNING *`, [id]);
    return ok(200, toBooking(upd.rows[0]));
  });
}

const encodeCursor = (seq) => Buffer.from(String(seq)).toString('base64url');
function decodeCursor(cursor) {
  const s = Buffer.from(cursor, 'base64url').toString('utf8');
  return /^\d{1,18}$/.test(s) && encodeCursor(s) === cursor ? s : null;
}

async function listBookings(query) {
  const { email, limit, cursor } = query;
  if (typeof email !== 'string' || email.trim() === '') return fail(400, 'email is required');

  let n = 10;
  if (limit !== undefined) {
    if (typeof limit !== 'string' || !/^\d+$/.test(limit) || +limit < 1 || +limit > 50) {
      return fail(400, 'limit must be an integer from 1 to 50');
    }
    n = +limit;
  }

  let after = '0';
  if (cursor !== undefined && cursor !== '') {
    after = typeof cursor === 'string' ? decodeCursor(cursor) : null;
    if (after === null) return fail(400, 'cursor is invalid');
  }

  // Keyset pagination on a monotonic sequence: stable even while new bookings arrive.
  const { rows } = await pool.query(
    'SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3',
    [email.trim().toLowerCase(), after, n + 1],
  );
  const page = rows.slice(0, n);
  const hasMore = rows.length > n;
  return ok(200, {
    bookings: page.map(toBooking),
    next_cursor: hasMore ? encodeCursor(page[page.length - 1].seq) : null,
  });
}

module.exports = { resetSlots, listSlots, createBooking, getBooking, cancelBooking, listBookings, RATE_LIMIT };
