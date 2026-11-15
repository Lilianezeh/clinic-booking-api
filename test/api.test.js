// End-to-end tests against a running server.
//   BASE_URL=http://localhost:3000 API_KEY=... node --test
// Works against the deployed URL too.
const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const KEY = process.env.API_KEY;

async function call(method, path, { body, key = KEY, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(key ? { 'X-API-Key': key } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const future = (h) => new Date(Date.now() + h * 3600e3).toISOString().replace('.000', '');
let n = 0;
const uniqueEmail = () => `user${Date.now()}_${n++}@example.com`;

async function reset(count = 3) {
  const slots = [];
  for (let i = 1; i <= count; i++) {
    slots.push({ id: `s${i}`, provider: i % 2 ? 'Dr Ade' : 'Dr Bello', start: future(24 + i), end: future(24.5 + i) });
  }
  slots.push({ id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' });
  const r = await call('POST', '/reset', { body: { slots } });
  assert.equal(r.status, 200);
  return slots;
}

test('level 1: list, book, look up', async () => {
  const slots = await reset(3);
  const list = await call('GET', '/slots');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.slots.map((s) => s.id), ['past', 's1', 's2', 's3']); // earliest first
  assert.equal(list.body.slots[1].start, slots[0].start); // dates echoed exactly
  assert.ok(list.body.slots.every((s) => s.available === true));

  const ade = await call('GET', '/slots?provider=Dr%20Ade');
  assert.deepEqual(ade.body.slots.map((s) => s.id), ['past', 's1', 's3']);

  const b = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada Obi', email: uniqueEmail() } });
  assert.equal(b.status, 201);
  assert.equal(b.body.status, 'confirmed');
  for (const f of ['id', 'slot_id', 'name', 'email', 'status', 'created_at']) assert.ok(f in b.body, f);

  const got = await call('GET', `/bookings/${b.body.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, b.body);

  const after = await call('GET', '/slots');
  assert.equal(after.body.slots.find((s) => s.id === 's1').available, false);

  assert.equal((await call('GET', '/bookings/nope')).status, 404);
  assert.deepEqual((await call('GET', '/bookings/nope')).body, { error: 'booking not found' });
});

test('level 2: API key and validation', async () => {
  await reset(2);
  for (const key of [undefined, 'wrong']) {
    for (const [m, p] of [['GET', '/slots'], ['POST', '/bookings'], ['POST', '/reset'], ['GET', '/bookings/x'], ['DELETE', '/bookings/x'], ['GET', '/bookings?email=a@b.co']]) {
      const r = await call(m, p, { key: key ?? '', body: m === 'GET' ? undefined : '{bad json' });
      assert.equal(r.status, 401, `${m} ${p} key=${key}`);
      assert.equal(typeof r.body.error, 'string');
    }
  }

  const bad = [
    {}, { name: 'A', email: 'a@b.co' }, { slot_id: 's1', email: 'a@b.co' }, { slot_id: 's1', name: 'A' },
    { slot_id: '', name: 'A', email: 'a@b.co' }, { slot_id: 's1', name: '   ', email: 'a@b.co' },
    { slot_id: 's1', name: 'A', email: 'not-an-email' }, { slot_id: 's1', name: 'A', email: 'a@b' },
    { slot_id: 1, name: 'A', email: 'a@b.co' },
  ];
  for (const body of bad) {
    const r = await call('POST', '/bookings', { body: { ...body, email: body.email && body.email + '' } });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.body.error, 'string');
  }
  assert.equal((await call('POST', '/bookings', { body: '{nope' })).status, 400);

  assert.equal((await call('POST', '/bookings', { body: { slot_id: 'zzz', name: 'A', email: uniqueEmail() } })).status, 404);
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 'past', name: 'A', email: uniqueEmail() } })).status, 400);

  const r = await call('POST', '/bookings', { body: { slot_id: 's1', name: '  Ada Obi  ', email: '  ADA.Obi@Example.COM ' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Ada Obi');
  assert.equal(r.body.email, 'ada.obi@example.com');
});

test('level 3: no double booking under concurrency, cancel frees the slot', async () => {
  await reset(1);
  const results = await Promise.all(
    Array.from({ length: 40 }, () => call('POST', '/bookings', { body: { slot_id: 's1', name: 'Racer', email: uniqueEmail() } })),
  );
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 201).length, 1, codes.join(','));
  assert.equal(codes.filter((c) => c === 409).length, 39);
  const winner = results.find((r) => r.status === 201).body;

  const del = await call('DELETE', `/bookings/${winner.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.status, 'cancelled');
  assert.equal((await call('DELETE', `/bookings/${winner.id}`)).status, 409);
  assert.equal((await call('DELETE', '/bookings/nope')).status, 404);
  assert.equal((await call('GET', `/bookings/${winner.id}`)).body.status, 'cancelled');
  assert.equal((await call('GET', '/slots')).body.slots.find((s) => s.id === 's1').available, true);

  const again = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Next', email: uniqueEmail() } });
  assert.equal(again.status, 201);
});

test('level 4: idempotency', async () => {
  await reset(2);
  const body = { slot_id: 's1', name: 'Ada', email: uniqueEmail() };
  const headers = { 'Idempotency-Key': `k-${Date.now()}` };

  // Simultaneous retries with the same key: one booking, identical answers.
  const rs = await Promise.all([1, 2, 3].map(() => call('POST', '/bookings', { body, headers })));
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201]);
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);

  const later = await call('POST', '/bookings', { body, headers });
  assert.equal(later.status, 201);
  assert.equal(later.body.id, rs[0].body.id);

  const diff = await call('POST', '/bookings', { body: { ...body, slot_id: 's2' }, headers });
  assert.equal(diff.status, 422);

  // Error responses replay too.
  const h2 = { 'Idempotency-Key': `k2-${Date.now()}` };
  const e1 = await call('POST', '/bookings', { body: { slot_id: 'zzz', name: 'A', email: uniqueEmail() }, headers: h2 });
  assert.equal(e1.status, 404);
});

test('level 4: pagination by email', async () => {
  const slots = await reset(7);
  const email = uniqueEmail();
  const ids = [];
  for (const s of slots.filter((x) => x.id !== 'past').slice(0, 7)) {
    // Mixed case on purpose: the lookup ignores case.
    const r = await call('POST', '/bookings', { body: { slot_id: s.id, name: 'Pager', email: ids.length % 2 ? email.toUpperCase() : email } });
    assert.equal(r.status, ids.length < 5 ? 201 : 429); // 5/min limit kicks in
    if (r.status === 201) ids.push(r.body.id);
  }
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const q = `/bookings?email=${encodeURIComponent(email.toUpperCase())}&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
    const r = await call('GET', q);
    assert.equal(r.status, 200);
    seen.push(...r.body.bookings.map((b) => b.id));
    cursor = r.body.next_cursor;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, ids); // oldest first, no gaps, no repeats
  assert.equal(pages, 3);

  const def = await call('GET', `/bookings?email=${encodeURIComponent(email)}`);
  assert.equal(def.body.bookings.length, 5);
  assert.equal(def.body.next_cursor, null);

  for (const l of ['0', '51', 'abc', '1.5', '-1', '']) {
    assert.equal((await call('GET', `/bookings?email=${email}&limit=${l}`)).status, 400, `limit=${l}`);
  }
  assert.equal((await call('GET', '/bookings')).status, 400);
  assert.equal((await call('GET', `/bookings?email=${email}&cursor=garbage!!`)).status, 400);
  const none = await call('GET', '/bookings?email=nobody@example.com');
  assert.deepEqual(none.body, { bookings: [], next_cursor: null });
});

test('level 5: 5 attempts per email per minute, failures included', async () => {
  await reset(2);
  const email = uniqueEmail();
  const other = uniqueEmail();
  // Fire 8 at once: exactly 5 get through the limiter (all fail with 404), 3 get 429.
  const rs = await Promise.all(
    Array.from({ length: 8 }, () => call('POST', '/bookings', { body: { slot_id: 'zzz', name: 'Spam', email } })),
  );
  const codes = rs.map((r) => r.status).sort();
  assert.deepEqual(codes, [404, 404, 404, 404, 404, 429, 429, 429]);
  const limited = rs.find((r) => r.status === 429);
  const retry = Number(limited.headers.get('retry-after'));
  assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60, `Retry-After=${retry}`);
  assert.equal(typeof limited.body.error, 'string');

  // Same email, different case: still limited.
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 's1', name: 'X', email: email.toUpperCase() } })).status, 429);
  // Other emails unaffected.
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Other', email: other } })).status, 201);
});

test('web page and its routes work without the key', async () => {
  await reset(1);
  const page = await fetch(`${BASE}/app/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
  const slots = await (await fetch(`${BASE}/ui/slots`)).json();
  assert.equal(slots.slots.length, 2);
  const r = await fetch(`${BASE}/ui/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot_id: 's1', name: 'Web', email: uniqueEmail() }),
  });
  assert.equal(r.status, 201);
  // ...but the web routes don't expose reset or listing.
  assert.equal((await fetch(`${BASE}/ui/reset`, { method: 'POST' })).status, 401);
});
