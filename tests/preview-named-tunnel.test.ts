/**
 * The `cloudflare-named` preview publisher (decision 0028).
 *
 * What separates it from `cloudflare-quick` is the only thing worth testing
 * here: the hostname is **ours and known in advance**, derived from the
 * manifest, rather than handed to us by Cloudflare at connect time. So these
 * tests assert the derivation, the artefacts it leaves for cloudflared, and the
 * two refusals that must not reach the network at all.
 *
 * cloudflared is faked. A real one would create tunnels and DNS records in
 * someone's Cloudflare account, which is not a thing a test suite may do.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTagged } from '../src/core/procscan.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

/**
 * A cloudflared that answers the three subcommands the named publisher uses and
 * then plays the tunnel process.
 *
 * `tunnel list` reports the tunnel as existing only AFTER a `create` has run,
 * so the create-then-find path is exercised rather than short-circuited — that
 * ordering is the one that breaks when someone reaches for `--output json` on a
 * cloudflared too old to have it.
 */
function makeFakeCloudflared(dir: string): string {
  const script = join(dir, 'named-cloudflared.mjs');
  writeFileSync(
    script,
    `import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const created = process.env.FAKE_CREATED_FILE;
const journal = process.env.FAKE_CALL_LOG;
appendFileSync(journal, args.join(' ') + '\\n');

if (args[0] === 'tunnel' && args[1] === 'list') {
  const names = existsSync(created) ? readFileSync(created, 'utf8').split('\\n').filter(Boolean) : [];
  process.stdout.write(JSON.stringify(names.map((n, i) => ({ id: '0000000' + i + '-uuid', name: n }))));
  process.exit(0);
}
if (args[0] === 'tunnel' && args[1] === 'create') {
  appendFileSync(created, args[2] + '\\n');
  process.exit(0);
}
if (args[0] === 'tunnel' && args[1] === 'route') {
  // cloudflared meldet die Zeile auf STDERR, nicht stdout — genau darin lag der Fehler.
  const wanted = args[args.length - 1];
  const zone = process.env.FAKE_SWALLOW_ZONE;
  if (process.env.FAKE_QUIET_ROUTE) console.error('INF done');
  else if (zone) console.error('INF ' + wanted + '.' + zone + ' is already configured to route to your tunnel');
  else console.error('INF Added CNAME ' + wanted + ' which will route to this tunnel');
  process.exit(0);
}
// tunnel --config <cfg> run <name>
writeFileSync(process.env.FAKE_PREVIEW_PIDFILE, String(process.pid));
setTimeout(() => {}, 3600_000);
const emit = () => console.error('INF Registered tunnel connection connIndex=0');
emit();
setInterval(emit, 500);
`,
  );
  const wrapper = join(dir, 'named-cloudflared');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function ctx(stackExtra: string, extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-named-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-named-wt-'));
  writeFileSync(
    join(wt, 'srv.mjs'),
    `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n`,
  );
  writeFileSync(
    join(wt, 'stack.yaml'),
    `name: namedtest\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { log: ready, timeout: 20 } }\n${stackExtra}`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });

  // The publisher refuses without an origin certificate. Its CONTENT is never
  // read by backlot — only cloudflared would care — so an empty file is a
  // faithful stand-in for "the operator has logged in".
  const cert = join(stateDir, 'cert.pem');
  writeFileSync(cert, '');

  const env = {
    ...process.env,
    BACKLOT_STATE_DIR: stateDir,
    BACKLOT_SWEEP_MS: '300',
    BACKLOT_CLOUDFLARED: makeFakeCloudflared(stateDir),
    TUNNEL_ORIGIN_CERT: cert,
    FAKE_PREVIEW_PIDFILE: join(stateDir, 'tunnel.pid'),
    FAKE_CREATED_FILE: join(stateDir, 'created.txt'),
    FAKE_CALL_LOG: join(stateDir, 'calls.txt'),
    ...extraEnv,
  };
  const cli = (args: string[], cwd = wt) =>
    new Promise<{ code: number; json?: Record<string, unknown>; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ code: err && typeof err === 'object' && 'code' in err ? Number(err.code) : 0, json, stdout: String(stdout), stderr: String(stderr) });
      });
    });

  const cleanup = () => {
    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
    for (const p of scanTagged(stateDir)) {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    try {
      process.kill(Number(readFileSync(join(stateDir, 'tunnel.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* never started */
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { wt, cli, stateDir, cleanup };
}

const NAMED = 'preview:\n  publisher: cloudflare-named\n  domain: example.dev\n  prefix: probe\n';

describe('the cloudflare-named preview publisher', () => {
  it('publishes under a hostname derived from service, prefix and domain', async () => {
    const { cli, stateDir } = ctx(NAMED);
    expect((await cli(['up', '--json'])).code).toBe(0);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(0);
    expect(prev.json?.url).toBe('https://web-probe.example.dev');

    // The address is the environment's, not the process's: it must survive into
    // the context blob, which is what a consumer reads.
    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls).toEqual({ web: 'https://web-probe.example.dev' });

    // The tunnel was created and the record routed — in that order, and by name.
    const calls = readFileSync(join(stateDir, 'calls.txt'), 'utf8');
    expect(calls).toMatch(/tunnel create backlot-probe-web/);
    expect(calls).toMatch(/tunnel route dns --overwrite-dns backlot-probe-web web-probe\.example\.dev/);
  });

  it('writes an ingress file pointing the hostname at the local port', async () => {
    const { cli, stateDir } = ctx(NAMED);
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);

    const envs = join(stateDir, 'envs');
    const cfg = findFile(envs, 'preview-web.tunnel.yml');
    expect(cfg).toBeTruthy();
    const text = readFileSync(cfg as string, 'utf8');
    expect(text).toMatch(/hostname: web-probe\.example\.dev/);
    expect(text).toMatch(/service: http:\/\/127\.0\.0\.1:\d+/);
    // cloudflared refuses to start without one, so its absence is not cosmetic.
    expect(text).toMatch(/service: http_status:404/);
  });

  it('refuses without preview.domain, and reaches nothing (work-error)', async () => {
    const { cli, stateDir } = ctx('preview:\n  publisher: cloudflare-named\n');
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(1);
    expect(String(prev.stderr + prev.stdout)).toMatch(/preview\.domain/);
    // A manifest short of a line must not create anything in someone's account.
    expect(existsSync(join(stateDir, 'created.txt'))).toBe(false);
  });

  it('refuses without an origin certificate, naming the command that fixes it', async () => {
    const { cli } = ctx(NAMED, { TUNNEL_ORIGIN_CERT: '/nonexistent/cert.pem' });
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(2);
    expect(String(prev.stderr + prev.stdout)).toMatch(/cloudflared tunnel login/);
  });

  it('stop kills the tunnel process and drops the URL from ctx', async () => {
    const { cli, stateDir } = ctx(NAMED);
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = Number(readFileSync(join(stateDir, 'tunnel.pid'), 'utf8'));

    expect((await cli(['preview', 'stop', '--json'])).code).toBe(0);

    expect(await goneWithin(pid, 5000)).toBe(true);
    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls ?? {}).toEqual({});
  });
  it('refuses when cloudflared routed a different hostname than the one asked for', async () => {
    // Der echte Fall: das Zertifikat autorisiert eine andere Zone, cloudflared
    // haengt sie an, legt `…baustelle.dev.fremde-zone.com` an — und meldet
    // Erfolg. Ohne diese Pruefung gibt backlot eine Adresse zurueck, die
    // nirgends aufloest.
    const { cli } = ctx(NAMED, { FAKE_SWALLOW_ZONE: 'fremde-zone.com' });
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(2);
    const out = String(prev.stderr + prev.stdout);
    expect(out).toMatch(/fremde-zone\.com/);
    // Die Meldung muss den Weg hinaus nennen, nicht nur den Widerspruch.
    expect(out).toMatch(/cloudflared tunnel login/);
  });

  it('publishes anyway when the routing message names no hostname at all', async () => {
    // Wortwahl aendert sich zwischen cloudflared-Fassungen. Auf eine
    // unbekannte, aber erfolgreiche Meldung hin abzubrechen wuerde
    // Veroeffentlichen fuer Fassungen kaputtmachen, die wir nie gesehen haben —
    // gefangen wird der Fall, in dem ein ANDERER Name ausdruecklich dasteht.
    const { cli } = ctx(NAMED, { FAKE_QUIET_ROUTE: '1' });
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(0);
    expect(prev.json?.url).toBe('https://web-probe.example.dev');
  });
});


function findFile(root: string, name: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}