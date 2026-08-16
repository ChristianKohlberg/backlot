/**
 * Lease-scoped public preview publishers (decision 0027).
 *
 * Distinct from the substrate driver's `expose()` — that wires internal service
 * URLs for remote substrates. Preview is an explicit, opt-in verb that publishes
 * one service port to the internet for human inspection.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BrokerError, now } from '../core/util.js';
import { killGroupVerified } from '../daemon/supervisor.js';
import { serviceTag, startTime } from '../core/procscan.js';
import { stateRoot } from '../core/paths.js';
import type { ServicePid } from '../core/types.js';

export interface PreviewPublisher {
  readonly name: string;
  /** infra-error when the external tool is missing; env-error when misconfigured. */
  checkPrerequisite(): void;
  /**
   * Start a supervised tunnel to `localUrl`. The process is spawned detached with
   * backlot tags so `pool gc` and lease teardown can reap it.
   */
  start(opts: {
    envId: string;
    service: string;
    localUrl: string;
    logDir: string;
  }): Promise<{ url: string; pid: ServicePid }>;
  stop(rec: ServicePid): Promise<void>;
}

const URL_RE = /https:\/\/[^\s]+trycloudflare\.com/;
const START_TIMEOUT_MS = 45_000;

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

    const url = await new Promise<string>((resolve, reject) => {
      const deadline = now() + START_TIMEOUT_MS;
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

    const pid = proc.pid;
    if (!pid) throw new BrokerError('env-error', 'cloudflared started without a pid', 'preview');
    return { url, pid: { pid, startTime: startTime(pid) } };
  }

  async stop(rec: ServicePid): Promise<void> {
    await killGroupVerified(rec.pid, rec.startTime);
  }
}

const publishers: Record<string, PreviewPublisher> = {
  'cloudflare-quick': new CloudflareQuickPublisher(),
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
