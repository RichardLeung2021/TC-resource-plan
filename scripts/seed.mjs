// Load seed/data.json into a deployed plan through its API.
// Usage: node scripts/seed.mjs https://dxxxx.cloudfront.net <passcode> [--force]
// Needs Node.js 18 or later (built-in fetch). Refuses to run on a plan that
// already has projects unless --force is given.
import { readFile } from 'node:fs/promises';

const [base, passcode, flag] = process.argv.slice(2);
if (!base || !passcode) {
  console.error('Usage: node scripts/seed.mjs <site-url> <passcode> [--force]');
  process.exit(1);
}
const api = base.replace(/\/+$/, '') + '/api';
const headers = { 'x-plan-passcode': passcode, 'content-type': 'application/json' };

const state = await fetch(api + '/state', { headers });
if (state.status === 401) { console.error('Passcode rejected.'); process.exit(1); }
if (!state.ok) { console.error('Could not reach the API:', state.status); process.exit(1); }
const existing = (await state.json()).collections.projects.length;
if (existing && flag !== '--force') {
  console.log(`The plan already has ${existing} projects, so the seed data was not loaded. Use --force to overwrite matching documents.`);
  process.exit(0);
}

const data = JSON.parse(await readFile(new URL('../seed/data.json', import.meta.url), 'utf8'));
const jobs = [];
for (const [col, docs] of Object.entries(data)) for (const [id, doc] of Object.entries(docs)) jobs.push([col, id, doc]);

let done = 0, failed = 0;
async function worker() {
  while (jobs.length) {
    const [col, id, doc] = jobs.shift();
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(`${api}/docs/${encodeURIComponent(col)}/${encodeURIComponent(id)}`, { method: 'PUT', headers, body: JSON.stringify(doc) });
      if (r.ok) { done++; break; }
      if (attempt >= 3) { failed++; console.error(`Failed ${col}/${id}: ${r.status}`); break; }
      await new Promise(res => setTimeout(res, 500 * attempt));
    }
    if (done % 50 === 0) console.log(`${done} documents written`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
console.log(`Finished: ${done} written, ${failed} failed.`);
process.exit(failed ? 1 : 0);
