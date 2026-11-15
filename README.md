# Clinic Booking API

An appointment booking API for a clinic, plus a web page that uses it. Built to the
[Koya assessment spec](https://koyaacademy.com/assessment-api), levels 1–5.

- **Stack:** Node 22, Express 5, PostgreSQL (Neon). No ORM, just SQL in one file.
- **Web page:** served by the same app at `/app/`.
- **Tests:** `test/api.test.js` covers every level end to end and runs against local or deployed URLs.

## Endpoints

Every API request needs `X-API-Key`. Errors are always `{"error": "..."}`.

| Method | Path | Level | Notes |
|---|---|---|---|
| POST | `/reset` | 1 | Replaces all slots and deletes all bookings |
| GET | `/slots?provider=` | 1 | Earliest first, with `available` |
| POST | `/bookings` | 1–5 | 201 / 400 / 404 / 409 / 422 / 429 |
| GET | `/bookings/{id}` | 1 | 404 if unknown |
| DELETE | `/bookings/{id}` | 3 | Cancels; 409 if already cancelled |
| GET | `/bookings?email=&limit=&cursor=` | 4 | Oldest first, cursor pagination |

## How each level is met

**Level 1.** Slots and bookings are stored in Postgres, so they survive restarts and redeploys.
Slot `start`/`end` are echoed back exactly as sent. A parsed copy is kept for sorting and time checks.

**Level 2.** The key check runs before body parsing, so a bad key is always 401, even with a
broken body. The key is compared in constant time. `name` and `email` are trimmed, and `email`
is stored lower-case. Checks run in the spec's order: missing or invalid fields (400), unknown
slot (404), slot already started (400).

**Level 3. No double booking.** A *partial unique index*,
`UNIQUE (slot_id) WHERE status = 'confirmed'`, makes double booking impossible at the
database level. If two requests race, Postgres makes the second one wait for the first
transaction, then rejects it with a unique violation, which we return as 409. Cancelled
bookings fall outside the index, so cancelling frees the slot. The test fires 40 bookings
at one slot at the same moment: exactly one 201 and 39 409s.

**Level 4. Idempotency.** In the same transaction as the booking, the request *claims* the
key (`INSERT … ON CONFLICT DO NOTHING`) with a hash of the body, then stores the response
it sent. If the same key arrives while the first request is still in flight, Postgres blocks
it until the first one commits, and it then replays the stored status and body. Same key with
a different body gives 422. Error responses (404, 409, …) are replayed too, except 429: a
rate-limited attempt rolls back so a later retry can go through.
**Pagination** is keyset-based on a monotonic `seq` column (the cursor is an opaque base64 string),
so pages don't skip or repeat rows while new bookings come in. `limit` must be an integer from
1 to 50, otherwise 400.

**Level 5. Rate limit.** A sliding 60-second window per (lower-cased) email, stored in Postgres
so it works across multiple instances and restarts. A per-email advisory lock serialises the
count, so 8 simultaneous attempts let exactly 5 through. Failed attempts count. The 429
response carries `Retry-After`, the whole seconds until the oldest attempt leaves the window.
Replays of an idempotent request don't count as new attempts, because they can't create anything.

## Two key decisions

1. **Put correctness in the database, not in app code.** Double booking, idempotency races
   and rate-limit counting are all enforced by Postgres (unique index, primary-key conflict,
   advisory lock) rather than by in-memory locks or check-then-insert code. That keeps the
   guarantees true when the host runs several instances, restarts mid-request, or the
   requests arrive at the same millisecond.
2. **Keep the API key off the browser.** The web page calls `/ui/*` routes on the same server.
   They run the *same* booking functions (validation, 409, idempotency, rate limit) but expose
   only list, book, view and cancel-by-id, with no `/reset` and no listing by email. Embedding the key
   in public JavaScript would have made it worthless. The page also sends an `Idempotency-Key` per
   attempt, so a double-click or flaky network can't book twice.

## Run locally

```bash
npm install
export DATABASE_URL=postgres://postgres@localhost/clinic API_KEY=dev-key
npm start                          # creates tables on boot
API_KEY=dev-key npm run seed       # load a week of demo slots
BASE_URL=http://localhost:3000 API_KEY=dev-key npm test
```

Open http://localhost:3000/app/.

## Deploy (free: Render + Neon)

1. **Neon:** create a project and copy the connection string (`postgresql://…?sslmode=require`).
2. **Render:** *New → Blueprint*, pick this repo. When asked, paste the Neon string as `DATABASE_URL`.
   Render generates `API_KEY`; copy it from the service's *Environment* tab.
3. Seed: `BASE_URL=https://<app>.onrender.com API_KEY=<key> npm run seed`
4. Check: `BASE_URL=https://<app>.onrender.com API_KEY=<key> npm test` (this calls `/reset`, so re-seed after).

Render's free plan sleeps after 15 idle minutes, and the first request then takes up to about a minute.
To keep it awake, point a free uptime monitor (e.g. UptimeRobot or cron-job.org) at `/healthz` every 10 minutes.

## What I'd do next

- Per-API-key and per-IP limits on top of the per-email limit, since a spammer can rotate emails.
- A "my bookings" view on the web page behind an emailed magic link. Listing by email is
  API-only for now because email alone isn't proof of identity.
- Expire stored idempotency keys after 24h with a scheduled cleanup.
- OpenAPI-driven contract tests in CI and structured request logging.
