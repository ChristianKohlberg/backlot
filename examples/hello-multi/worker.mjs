// hello-multi worker — a PORTLESS service. Exercises: readiness by log marker
// (`ready: { log: ... }`), the shape CI/e2e can't probe with HTTP.
// It processes queued jobs from the shared sqlite db until killed.
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.DB_PATH ?? './multi.db';
const db = new DatabaseSync(DB_PATH);
// Same file the api reads: without a busy timeout, an update colliding with a
// reader's lock throws SQLITE_BUSY and kills the worker.
db.exec('PRAGMA busy_timeout = 5000');

console.log('worker ready — polling for queued jobs');

setInterval(() => {
  const job = db.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get();
  if (job) {
    db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(job.id);
    console.log(`worker processed job ${job.id}`);
  }
}, 200);
