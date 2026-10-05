// hello-web's smoke test: proves the whole vertical (HTTP -> sqlite) against the
// environment `runly ctx --env` describes. Exit code = the verdict.
//   eval "$(runly ctx --env)" && node smoke.test.mjs
const base = process.env.RUNLY_URL_WEB ?? process.env.BASE_URL;
if (!base) {
  console.error('RUNLY_URL_WEB not set — run: eval "$(runly ctx --env)" && node smoke.test.mjs');
  process.exit(2);
}

const health = await fetch(`${base}/health`).then((r) => r.json());
if (!health.ok) {
  console.error('health check failed', health);
  process.exit(1);
}

const greetings = await fetch(`${base}/api/greetings`).then((r) => r.json());
if (!Array.isArray(greetings) || greetings.length === 0) {
  console.error('expected seeded greetings, got', greetings);
  process.exit(1);
}

console.log(`smoke ok — ${greetings.length} greetings served from the seeded db`);
