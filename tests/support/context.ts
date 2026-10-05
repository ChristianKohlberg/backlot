/**
 * A private runly for one test file: its own state root, a CLI bound to it,
 * a journal reader, and a disposal that leaves nothing running (decision 0037).
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Journal } from '../../src/core/journal.js';
import { disposeStateSync } from './leaks.js';

export const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli', 'index.js');

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json?: any;
}

export interface Ctx {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  cli(args: string[], cwd: string, more?: Record<string, string>, timeoutMs?: number): Promise<CliResult>;
  journal(): Journal;
  daemonPid(): number | undefined;
  stopDaemon(cwd: string): Promise<void>;
  /** A git worktree with these files (paths relative to it). */
  worktree(files: Record<string, string>): string;
  dispose(): void;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 20_000, stepMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}

export function makeCtx(extraEnv: Record<string, string> = {}): Ctx {
  const stateDir = mkdtempSync(join(tmpdir(), 'runly-ctx-'));
  const trees: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '300', ...extraEnv };
  delete env.BACKLOT_HOLDER_PID;
  const cli = (args: string[], cwd: string, more: Record<string, string> = {}, timeoutMs = 90_000): Promise<CliResult> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...more }, maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
        let json: unknown;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* human output */
        }
        resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr), json });
      });
    });
  const daemonPid = (): number | undefined => {
    try {
      return Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
    } catch {
      return undefined;
    }
  };
  return {
    stateDir,
    env,
    cli,
    journal: () => new Journal(join(stateDir, 'journal.db')),
    daemonPid,
    async stopDaemon(cwd: string) {
      const pid = daemonPid();
      await cli(['daemon', 'stop', '--json'], cwd);
      for (let i = 0; i < 200 && pid; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await sleep(50);
      }
    },
    worktree(files: Record<string, string>) {
      const wt = mkdtempSync(join(tmpdir(), 'runly-ctx-wt-'));
      trees.push(wt);
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(wt, rel)), { recursive: true });
        writeFileSync(join(wt, rel), content);
      }
      execFileSync('git', ['init', '-q'], { cwd: wt });
      execFileSync('git', ['add', '-A'], { cwd: wt });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: wt });
      return wt;
    },
    dispose() {
      disposeStateSync(stateDir);
      for (const wt of trees) disposeStateSync(wt);
    },
  };
}

/** A tiny HTTP server: answers its pid, or (with UPSTREAM) the upstream's answer. */
export const SERVER = `import { createServer } from 'node:http';
const upstream = process.env.UPSTREAM;
createServer(async (q, s) => {
  if (upstream && q.url === '/chain') {
    try { s.end('via ' + process.pid + ' -> ' + (await (await fetch(upstream)).text())); }
    catch (e) { s.statusCode = 502; s.end(String(e)); }
    return;
  }
  s.end(String(process.pid));
}).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening ' + process.env.PORT));
`;
