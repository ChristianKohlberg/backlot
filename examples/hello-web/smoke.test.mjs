// The `smoke` check for hello-web: proves the whole vertical (HTTP -> sqlite)
// against whatever BASE_URL infront injected. Exit code = the verdict.
const base = process.env.BASE_URL;
if (!base) {
  console.error('BASE_URL not set — run through `infront run smoke`');
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
