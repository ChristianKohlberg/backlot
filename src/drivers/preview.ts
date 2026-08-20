/**
 * Lease-scoped public preview publishers (decision 0027).
 *
 * Distinct from the substrate driver's `expose()` — that wires internal service
 * URLs for remote substrates. Preview is an explicit, opt-in verb that publishes
 * one service port to the internet for human inspection.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BrokerError, now } from '../core/util.js';
import { killGroupVerified } from '../daemon/supervisor.js';
import { serviceTag, startTime } from '../core/procscan.js';
import { stateRoot } from '../core/paths.js';
import type { ServicePid } from '../core/types.js';

/** The manifest's `preview` block, as far as a publisher may read it. */
export interface PreviewSettings {
  domain?: string;
  prefix?: string;
}

export interface PreviewPublisher {
  readonly name: string;
  /** env-error when the external tool is missing or misconfigured. */
  checkPrerequisite(): void;
  /**
   * Start a supervised tunnel to `localUrl`. The process is spawned detached with
   * backlot tags so `pool gc` and lease teardown can reap it.
   *
   * An adapter OWNS the process it spawned until it hands back a pid: if it
   * throws, it must already have killed it. Nothing downstream can clean up a
   * tunnel whose pid was never returned, and a live one is a public,
   * unauthenticated URL with no record anywhere.
   */
  start(opts: {
    envId: string;
    service: string;
    localUrl: string;
    logDir: string;
    /**
     * The stack's `preview` block, verbatim. A publisher that names its own
     * hostnames needs the zone; `cloudflare-quick` ignores it entirely.
     */
    settings?: PreviewSettings;
  }): Promise<{ url: string; pid: ServicePid }>;
  /**
   * Returns true only when the tunnel is CONFIRMED gone. A false verdict must
   * keep the caller's record (reapPids' contract): a forgotten preview pid is a
   * public, unauthenticated URL nobody can ever name again.
   */
  stop(rec: ServicePid): Promise<boolean>;
}

const URL_RE = /https:\/\/[^\s]+trycloudflare\.com/;
/** How long to wait for a quick tunnel to publish its URL before giving up. */
const startTimeoutMs = (): number => {
  const raw = Number(process.env.BACKLOT_PREVIEW_START_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
};

function cloudflaredBin(): string {
  const override = process.env.BACKLOT_CLOUDFLARED?.trim();
  if (override) return override;
  try {
    return execFileSync('which', ['cloudflared'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'cloudflared';
  }
}

function cloudflaredAvailable(bin: string): boolean {
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin);
  try {
    execFileSync('which', [bin], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a tunnel process this adapter spawned but is about to stop tracking.
 *
 * `spawnedStart` is the identity recorded at spawn, never re-read here: reading
 * it now would hand `killGroupVerified` the start time of whatever holds that
 * pid at this instant, so its pid-reuse guard could never disagree and a
 * recycled pid would take our SIGTERM/SIGKILL. An already-exited child is the
 * very case where the pid is free for reuse, so it returns before signalling.
 *
 * Returns the pid when it could NOT be confirmed dead. That is the one outcome
 * worth saying out loud: no pid was ever returned, so no lease row records it
 * and `pool gc` has nothing to reclaim it by — the caller must put it in the
 * error it is about to throw, or a live public URL leaves no trace at all.
 */
async function abandon(proc: ChildProcess, spawnedStart: number | undefined): Promise<number | undefined> {
  const pid = proc.pid;
  if (pid === undefined || proc.exitCode !== null) return undefined;
  try {
    return (await killGroupVerified(pid, spawnedStart)) ? undefined : pid;
  } catch {
    return pid;
  }
}

/** Append the surviving pid to an error's detail, so the operator can find it. */
function withSurvivor(err: unknown, pid: number | undefined): unknown {
  if (pid === undefined || !(err instanceof BrokerError)) return err;
  const warning =
    `the cloudflared process (pid ${pid}) could NOT be confirmed dead and was never recorded anywhere —` +
    ` it may still be serving a PUBLIC, unauthenticated URL; kill it by hand`;
  return new BrokerError(err.klass, err.message, err.source, `${err.logExcerpt ? `${err.logExcerpt}\n` : ''}${warning}`);
}

class CloudflareQuickPublisher implements PreviewPublisher {
  readonly name = 'cloudflare-quick';

  checkPrerequisite(): void {
    const bin = cloudflaredBin();
    if (!cloudflaredAvailable(bin)) {
      throw new BrokerError(
        'env-error',
        `preview requires cloudflared (Cloudflare quick tunnel) — install it and ensure it is on PATH, or set BACKLOT_CLOUDFLARED to its path`,
        'preview',
      );
    }
  }

  async start(opts: { envId: string; service: string; localUrl: string; logDir: string }): Promise<{ url: string; pid: ServicePid }> {
    this.checkPrerequisite();
    const bin = cloudflaredBin();
    mkdirSync(opts.logDir, { recursive: true });
    const logPath = join(opts.logDir, `preview-${opts.service}.log`);
    const tagName = `preview:${opts.service}`;
    const proc = spawn(bin, ['tunnel', '--url', opts.localUrl], {
      env: { ...process.env, ...serviceTag(opts.envId, tagName, stateRoot()) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const spawnedStart = proc.pid === undefined ? undefined : startTime(proc.pid);
    let buf = '';
    const sink = (d: Buffer) => {
      const s = d.toString();
      buf = (buf + s).slice(-16_000);
      try {
        appendFileSync(logPath, s);
      } catch {
        /* log dir gone */
      }
    };
    proc.stdout?.on('data', sink);
    proc.stderr?.on('data', sink);

    let url: string;
    try {
      url = await new Promise<string>((resolve, reject) => {
        const deadline = now() + startTimeoutMs();
        const poll = () => {
          const m = URL_RE.exec(buf);
          if (m) return resolve(m[0]);
          if (proc.exitCode !== null) {
            return reject(
              new BrokerError('env-error', `cloudflared exited before publishing a URL (exit ${proc.exitCode})`, 'preview', buf.slice(-2000)),
            );
          }
          if (now() > deadline) {
            return reject(new BrokerError('env-error', 'timed out waiting for cloudflared to publish a preview URL', 'preview', buf.slice(-2000)));
          }
          setTimeout(poll, 100).unref();
        };
        proc.on('error', (err) =>
          reject(new BrokerError('env-error', `failed to start cloudflared: ${err.message}`, 'preview')),
        );
        poll();
      });
    } catch (err) {
      // Giving up on the WAIT is not giving up on the PROCESS. A tunnel that
      // was merely slow publishes its URL a second after the timeout, and with
      // no pid returned there is no lease record, no `pool gc` entry and no
      // `preview stop` that could ever name it — a public, unauthenticated URL
      // serving until the host reboots.
      throw withSurvivor(err, await abandon(proc, spawnedStart));
    }

    const pid = proc.pid;
    if (!pid) {
      throw withSurvivor(new BrokerError('env-error', 'cloudflared started without a pid', 'preview'), await abandon(proc, spawnedStart));
    }
    return { url, pid: { pid, startTime: spawnedStart } };
  }

  async stop(rec: ServicePid): Promise<boolean> {
    return killGroupVerified(rec.pid, rec.startTime);
  }
}

/**
 * cloudflared prints this once a connection to the edge stands. A named tunnel
 * has no URL to announce — we already know the hostname — so readiness is the
 * only thing worth waiting for. Waiting for nothing and returning immediately
 * would hand back a URL that 502s for the next few seconds, which reads as a
 * broken service rather than a tunnel still dialling.
 */
const NAMED_READY_RE = /Registered tunnel connection/;

/** Where `cloudflared tunnel login` left the certificate that authorises the zone. */
function originCert(): string {
  const override = process.env.TUNNEL_ORIGIN_CERT?.trim();
  return override || join(homedir(), '.cloudflared', 'cert.pem');
}

/**
 * One DNS label, from something a human wrote in a manifest.
 *
 * A hostname that Cloudflare rejects surfaces three steps later as a DNS error
 * during `route dns`, long after the tunnel exists — so the bad character is
 * caught here, where the name is still just a string.
 */
function label(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) throw new BrokerError('work-error', `'${raw}' has no character a DNS label may contain`, 'preview');
  return cleaned.slice(0, 63).replace(/-+$/g, '');
}

function cf(bin: string, args: string[], what: string): string {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const detail = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr?: unknown }).stderr ?? '') : '';
    throw new BrokerError('env-error', `${what} failed`, 'preview', detail.slice(-2000));
  }
}

/**
 * The tunnel's id, creating it on first use.
 *
 * Reused rather than recreated: the tunnel and its DNS record are what make the
 * hostname stable across leases, which is the whole point of naming one. A
 * tunnel per publish would churn objects in the operator's Cloudflare account
 * every few minutes and leave the reaping of them as a second lifecycle to get
 * right.
 */
function ensureTunnel(bin: string, name: string): string {
  const find = (): string | undefined => {
    const raw = cf(bin, ['tunnel', 'list', '--output', 'json'], 'listing Cloudflare tunnels');
    const rows: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(rows)) return undefined;
    const hit = rows.find((r) => r && typeof r === 'object' && (r as { name?: unknown }).name === name);
    return hit ? String((hit as { id?: unknown }).id ?? '') || undefined : undefined;
  };
  const existing = find();
  if (existing) return existing;
  cf(bin, ['tunnel', 'create', name], `creating the Cloudflare tunnel '${name}'`);
  const created = find();
  if (!created) {
    throw new BrokerError('env-error', `created the Cloudflare tunnel '${name}' but it is not in the tunnel list`, 'preview');
  }
  return created;
}

class CloudflareNamedPublisher implements PreviewPublisher {
  readonly name = 'cloudflare-named';

  checkPrerequisite(): void {
    const bin = cloudflaredBin();
    if (!cloudflaredAvailable(bin)) {
      throw new BrokerError(
        'env-error',
        `preview requires cloudflared — install it and ensure it is on PATH, or set BACKLOT_CLOUDFLARED to its path`,
        'preview',
      );
    }
    const cert = originCert();
    if (!existsSync(cert)) {
      throw new BrokerError(
        'env-error',
        `the '${this.name}' publisher needs a Cloudflare origin certificate at ${cert} — run 'cloudflared tunnel login' once, or point TUNNEL_ORIGIN_CERT at it`,
        'preview',
      );
    }
  }

  async start(opts: {
    envId: string;
    service: string;
    localUrl: string;
    logDir: string;
    settings?: PreviewSettings;
  }): Promise<{ url: string; pid: ServicePid }> {
    this.checkPrerequisite();
    const domain = opts.settings?.domain?.trim();
    if (!domain) {
      // work-error, not env-error: the machine is fine, the manifest is short a
      // line. An env-error would send the operator hunting for a broken install.
      throw new BrokerError(
        'work-error',
        `the '${this.name}' publisher needs 'preview.domain' in the manifest (the zone to publish under, e.g. example.dev)`,
        'preview',
      );
    }
    // Unset prefix means the environment id, which is unique by construction —
    // see PreviewSpec.prefix for why the manifest is the wrong place to make a
    // pooled stack's hostnames distinct.
    const prefix = label(opts.settings?.prefix?.trim() || opts.envId);
    const hostname = `${label(`${opts.service}-${prefix}`)}.${domain}`;
    const tunnelName = `backlot-${label(`${prefix}-${opts.service}`)}`;

    const bin = cloudflaredBin();
    const uuid = ensureTunnel(bin, tunnelName);
    // `--overwrite-dns` because the record outlives the lease on purpose: the
    // second publish of the same hostname must land on the same tunnel rather
    // than fail on the record it left behind last time.
    cf(bin, ['tunnel', 'route', 'dns', '--overwrite-dns', tunnelName, hostname], `routing ${hostname} to '${tunnelName}'`);

    mkdirSync(opts.logDir, { recursive: true });
    const logPath = join(opts.logDir, `preview-${opts.service}.log`);
    const cfgPath = join(opts.logDir, `preview-${opts.service}.tunnel.yml`);
    // A catch-all is mandatory — cloudflared refuses to start without one.
    writeFileSync(
      cfgPath,
      [
        `tunnel: ${uuid}`,
        `credentials-file: ${join(homedir(), '.cloudflared', `${uuid}.json`)}`,
        'ingress:',
        `  - hostname: ${hostname}`,
        `    service: ${opts.localUrl}`,
        '  - service: http_status:404',
        '',
      ].join('\n'),
    );

    const tagName = `preview:${opts.service}`;
    const proc = spawn(bin, ['tunnel', '--config', cfgPath, 'run', tunnelName], {
      env: { ...process.env, ...serviceTag(opts.envId, tagName, stateRoot()) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const spawnedStart = proc.pid === undefined ? undefined : startTime(proc.pid);
    let buf = '';
    const sink = (d: Buffer) => {
      const s = d.toString();
      buf = (buf + s).slice(-16_000);
      try {
        appendFileSync(logPath, s);
      } catch {
        /* log dir gone */
      }
    };
    proc.stdout?.on('data', sink);
    proc.stderr?.on('data', sink);

    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = now() + startTimeoutMs();
        const poll = () => {
          if (NAMED_READY_RE.test(buf)) return resolve();
          if (proc.exitCode !== null) {
            return reject(
              new BrokerError('env-error', `cloudflared exited before the tunnel connected (exit ${proc.exitCode})`, 'preview', buf.slice(-2000)),
            );
          }
          if (now() > deadline) {
            return reject(new BrokerError('env-error', `timed out waiting for the tunnel to '${hostname}' to connect`, 'preview', buf.slice(-2000)));
          }
          setTimeout(poll, 100).unref();
        };
        proc.on('error', (err) => reject(new BrokerError('env-error', `failed to start cloudflared: ${err.message}`, 'preview')));
        poll();
      });
    } catch (err) {
      // Same reasoning as the quick publisher: giving up on the WAIT is not
      // giving up on the PROCESS. A tunnel that merely connected slowly serves
      // the hostname a second after the timeout, and with no pid returned there
      // is nothing that could ever name it.
      throw withSurvivor(err, await abandon(proc, spawnedStart));
    }

    const pid = proc.pid;
    if (!pid) {
      throw withSurvivor(new BrokerError('env-error', 'cloudflared started without a pid', 'preview'), await abandon(proc, spawnedStart));
    }
    return { url: `https://${hostname}`, pid: { pid, startTime: spawnedStart } };
  }

  /**
   * Only the process goes. The tunnel and its DNS record stay, and that is the
   * feature: the next publish of this service reaches the same address, which
   * is the reason to name one at all. Until then the hostname answers with
   * Cloudflare's "tunnel not running" page — a visible, correct answer, not a
   * pointer at someone else's service.
   */
  async stop(rec: ServicePid): Promise<boolean> {
    return killGroupVerified(rec.pid, rec.startTime);
  }
}

const publishers: Record<string, PreviewPublisher> = {
  'cloudflare-quick': new CloudflareQuickPublisher(),
  'cloudflare-named': new CloudflareNamedPublisher(),
};

export function resolvePreviewPublisher(name: string): PreviewPublisher {
  const pub = publishers[name];
  if (!pub) {
    throw new BrokerError('work-error', `unknown preview publisher '${name}' (known: ${Object.keys(publishers).join(', ')})`, 'preview');
  }
  return pub;
}

/** Default publisher when the manifest and config do not name one. */
export const DEFAULT_PREVIEW_PUBLISHER = 'cloudflare-quick';
