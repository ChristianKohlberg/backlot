// hello-multi web — the frontend service. Exercises: a second symbolic port,
// depends_on, and {{services.api.url}} injection (it never touches the DB).
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 3101);
const API_URL = process.env.API_URL;
if (!API_URL) {
  console.error('Error: API_URL not set — web is wired to the api service by the manifest');
  process.exit(1);
}

createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'web' }));
    return;
  }
  try {
    const items = await fetch(`${API_URL}/api/items`).then((r) => r.json());
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<!doctype html><title>hello-multi</title><h1>hello-multi</h1><ul>` +
        items.map((i) => `<li>${i.name}</li>`).join('') +
        `</ul>`,
    );
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`api unreachable: ${err.message}`);
  }
}).listen(PORT, () => {
  console.log(`hello-multi web listening on :${PORT} (api: ${API_URL})`);
});
