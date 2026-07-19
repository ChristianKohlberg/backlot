// hello-multi API — the backend service of the multi-service variant fixture.
// Exercises: its own symbolic port, a shared sqlite datastore, /health readiness.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT ?? 3100);
const DB_PATH = process.env.DB_PATH ?? './multi.db';

const db = new DatabaseSync(DB_PATH);
// The worker commits to this same file. Without a busy timeout, a read landing
// inside a commit's exclusive-lock window throws SQLITE_BUSY — an uncaught
// exception here, which kills the service mid-request. The window is
// microseconds; wait it out instead of dying.
db.exec('PRAGMA busy_timeout = 5000');

createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'api' }));
    return;
  }
  if (req.url === '/api/items') {
    const rows = db.prepare('SELECT id, name FROM items ORDER BY id').all();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }
  if (req.url === '/api/jobs') {
    const rows = db.prepare('SELECT id, status FROM jobs ORDER BY id').all();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}).listen(PORT, () => {
  console.log(`hello-multi api listening on :${PORT} (db: ${DB_PATH})`);
});
