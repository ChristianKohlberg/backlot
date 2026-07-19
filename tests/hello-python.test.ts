/**
 * hello-python fixture regressions — the deterministic macOS-CI readiness
 * failure of 2026-07 (BACKLOG "hello-python never passes its readiness probe").
 *
 * Root cause, measured on a GitHub macos-latest runner: stdlib HTTPServer's
 * server_bind() reverse-resolves the bound address (socket.getfqdn ->
 * gethostbyaddr), and on that runner's broken resolver one lookup takes ~35s —
 * longer than the manifest's 30s readiness timeout. The old server.py also
 * printed "listening" BEFORE constructing the server, so the failure evidence
 * quoted a log line about a socket that never existed.
 *
 * Raw fixture style (tests/helpers.ts): no daemon. The broker loop over this
 * fixture is covered by tests/milestones.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { tempDir, freePort, startService, waitHttp } from './helpers.js';

const example = join(import.meta.dirname, '..', 'examples', 'hello-python');

describe('hello-python fixture', () => {
  it('becomes ready without reverse DNS (35s per lookup on GH macOS runners)', async () => {
    const tmp = tempDir('pydns');
    // sitecustomize.py is imported into every python started with this
    // PYTHONPATH: simulate the runner's broken resolver by making every
    // reverse lookup hang far longer than the readiness window.
    writeFileSync(
      join(tmp.dir, 'sitecustomize.py'),
      'import socket, time\n' +
        'def _stall(*a, **k):\n' +
        '    time.sleep(30)\n' +
        '    raise OSError("resolver is broken on this host")\n' +
        'socket.gethostbyaddr = _stall\n',
    );
    const port = await freePort();
    const svc = startService(['python3', 'server.py'], {
      cwd: example,
      env: { PORT: String(port), DB_PATH: join(tmp.dir, 'unused.db'), PYTHONPATH: tmp.dir },
    });
    try {
      await waitHttp(`http://127.0.0.1:${port}/health`, svc, /Traceback/, 10_000);
    } finally {
      await svc.stop();
      tmp.cleanup();
    }
  });

  it('does not log "listening" until the socket is actually bound', async () => {
    const port = await freePort();
    // Squat the port so the fixture's bind must fail.
    const squatter: Server = createServer();
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', () => resolve()));
    const svc = startService(['python3', 'server.py'], {
      cwd: example,
      env: { PORT: String(port), DB_PATH: 'unused.db' },
    });
    try {
      const start = Date.now();
      while (svc.proc.exitCode === null && svc.proc.signalCode === null) {
        if (Date.now() - start > 10_000) throw new Error(`expected EADDRINUSE exit:\n${svc.logs()}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      // The bind failed — so the log must not have advertised readiness. This
      // is the line the supervisor quotes as failure evidence; a "listening"
      // printed before the bind sent the whole diagnosis chasing a service
      // that was allegedly up.
      expect(svc.logs()).toContain('Traceback');
      expect(svc.logs()).not.toContain('listening on');
    } finally {
      await svc.stop();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});
