// hello-web — the smallest stack infront can broker: one HTTP service + one
// sqlite datastore. This app is infront's front door AND its integration-test
// fixture: every engine property (lease, warm rebind, upkeep, reset-data) is
// exercised against it in CI, on macOS and Linux, with no Docker and no
// external database.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? './hello.db';

const db = new DatabaseSync(DB_PATH);

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/api/greetings') {
    const rows = db.prepare('SELECT id, message FROM greetings ORDER BY id').all();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }
  const rows = db.prepare('SELECT message FROM greetings ORDER BY id').all();
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    `<!doctype html><title>hello-web</title><h1>hello-web</h1><ul>` +
      rows.map((r) => `<li>${r.message}</li>`).join('') +
      `</ul>`,
  );
});

server.listen(PORT, () => {
  console.log(`hello-web listening on :${PORT} (db: ${DB_PATH})`);
});
