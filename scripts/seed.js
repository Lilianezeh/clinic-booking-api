// Loads a week of demo slots through POST /reset (this deletes all bookings).
//   BASE_URL=https://your-app.onrender.com API_KEY=... npm run seed
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const KEY = process.env.API_KEY;
if (!KEY) throw new Error('API_KEY is not set');

const providers = ['Dr Ade', 'Dr Bello', 'Dr Chukwu'];
const slots = [];
const day0 = new Date();
day0.setUTCHours(0, 0, 0, 0);

for (let d = 1; d <= 7; d++) {
  const day = new Date(day0.getTime() + d * 86400e3);
  if (day.getUTCDay() === 0) continue; // closed Sundays
  providers.forEach((provider, p) => {
    for (let h = 8; h < 16; h += 1.5) { // 09:00–16:00 Lagos time (UTC+1)
      const start = new Date(day.getTime() + (h + p * 0.5) * 3600e3);
      const end = new Date(start.getTime() + 30 * 60e3);
      const iso = (t) => t.toISOString().replace('.000Z', 'Z');
      slots.push({ id: `${iso(start).slice(0, 10)}-${provider.split(' ')[1].toLowerCase()}-${iso(start).slice(11, 16).replace(':', '')}`, provider, start: iso(start), end: iso(end) });
    }
  });
}

fetch(`${BASE}/reset`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
  body: JSON.stringify({ slots }),
})
  .then(async (r) => console.log(r.status, await r.text()))
  .catch((e) => { console.error(e); process.exit(1); });
