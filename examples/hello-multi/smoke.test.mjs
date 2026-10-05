// hello-multi's smoke test: proves the full topology — web renders what api
// serves, and the portless worker drains the job queue. Writes smoke-report.json.
//   eval "$(runly ctx --env)" && node smoke.test.mjs
import { writeFileSync } from 'node:fs';

const api = process.env.RUNLY_URL_API ?? process.env.API_URL;
const web = process.env.RUNLY_URL_WEB ?? process.env.WEB_URL;
if (!api || !web) {
  console.error('RUNLY_URL_API / RUNLY_URL_WEB not set — run: eval "$(runly ctx --env)" && node smoke.test.mjs');
  process.exit(2);
}

const report = { checks: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail();
};
const fail = () => {
  writeFileSync('smoke-report.json', JSON.stringify(report, null, 2));
  process.exit(1);
};

const items = await fetch(`${api}/api/items`).then((r) => r.json());
check('api serves seeded items', Array.isArray(items) && items.length > 0, `${items.length} items`);

const page = await fetch(web).then((r) => r.text());
check('web renders api data', items.every((i) => page.includes(i.name)));

// The worker drains the queue asynchronously — poll briefly.
let jobs = [];
for (let i = 0; i < 25; i++) {
  jobs = await fetch(`${api}/api/jobs`).then((r) => r.json());
  if (jobs.length > 0 && jobs.every((j) => j.status === 'done')) break;
  await new Promise((r) => setTimeout(r, 200));
}
check('worker processed all jobs', jobs.length > 0 && jobs.every((j) => j.status === 'done'), `${jobs.length} jobs done`);

writeFileSync('smoke-report.json', JSON.stringify(report, null, 2));
console.log('smoke ok — full topology proven (web -> api -> db, worker -> db)');
