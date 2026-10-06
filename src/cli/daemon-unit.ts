/**
 * Supervision for the daemon (decision 0039): `runly daemon install` writes a
 * systemd user unit (Linux) or a launchd agent (macOS) that runs the daemon
 * with restart-on-failure, so a crashed daemon is back within seconds —
 * `recover()` re-holds the public ports and reaps what the dead one left —
 * instead of waiting for the next CLI command.
 *
 * It coexists with the CLI's autospawn. The socket lock (election) still
 * decides who serves, so there is never a second daemon; and once the unit is
 * installed, a CLI that finds no daemon starts the UNIT rather than spawning
 * one of its own, so the daemon stays supervised across `runly update` and
 * `runly daemon stop`.
 *
 * One unit per state root: the default root gets `runly-daemon`, any other
 * (`BACKLOT_STATE_DIR`) a name with a hash of its path, so test daemons and
 * parallel installs never touch each other's unit.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateRoot } from '../core/paths.js';

export type UnitKind = 'systemd' | 'launchd';

export interface UnitPlan {
  kind: UnitKind;
  /** systemd unit name (without .service) or launchd label. */
  name: string;
  /** Where the unit file goes. */
  path: string;
  content: string;
}

/** The default state root, as paths.ts derives it without BACKLOT_STATE_DIR. */
function defaultStateRoot(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(base, 'backlot');
}

/** `runly-daemon`, or `runly-daemon-<hash>` for a non-default state root. */
export function unitBaseName(root = stateRoot()): string {
  if (root === defaultStateRoot()) return 'runly-daemon';
  return `runly-daemon-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`;
}

export function unitKind(): UnitKind | null {
  if (process.platform === 'linux') return 'systemd';
  if (process.platform === 'darwin') return 'launchd';
  return null;
}

const daemonEntry = (): string => join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'index.js');

/**
 * What the daemon runs with. A unit does not inherit a login shell's
 * environment, and services, builds and upkeep run with the daemon's: PATH
 * (node, pnpm, docker, dotnet) and the BACKLOT_* settings are captured at
 * install time. Anything else a service needs belongs in its manifest `env:`.
 */
function unitEnvironment(root: string): Record<string, string> {
  const env: Record<string, string> = { BACKLOT_STATE_DIR: root };
  if (process.env.PATH) env.PATH = process.env.PATH;
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('BACKLOT_') || v === undefined) continue;
    if (['BACKLOT_STATE_DIR', 'BACKLOT_HOLDER_PID', 'BACKLOT_DB_COPY', 'BACKLOT_ENV_ID', 'BACKLOT_SERVICE', 'BACKLOT_STATE_ROOT', 'BACKLOT_FAKE_VERSION'].includes(k)) continue;
    env[k] = v;
  }
  return env;
}

/** systemd quoting for one Environment= assignment. */
const systemdEnv = (k: string, v: string): string => `Environment="${`${k}=${v}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const systemdArg = (a: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).replace(/%/g, '%%');
const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function unitPlan(root = stateRoot()): UnitPlan | null {
  const kind = unitKind();
  if (!kind) return null;
  const name = unitBaseName(root);
  const argv = [process.execPath, '--disable-warning=ExperimentalWarning', daemonEntry()];
  const env = unitEnvironment(root);
  const log = join(root, 'daemon.log');
  if (kind === 'systemd') {
    const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
    const content = [
      '# Written by `runly daemon install` (decision 0039). `runly daemon uninstall` removes it.',
      '[Unit]',
      `Description=runly daemon (state root ${root})`,
      'Documentation=https://github.com/ChristianKohlberg/backlot/blob/main/docs/overview.md#the-daemon',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${argv.map(systemdArg).join(' ')}`,
      ...Object.entries(env).map(([k, v]) => systemdEnv(k, v)),
      `WorkingDirectory=${systemdArg(root)}`,
      // A crash (non-zero exit, a fatal signal) restarts it within seconds;
      // `runly daemon stop` and `runly update` exit 0 and are not undone.
      'Restart=on-failure',
      'RestartSec=1',
      // Services are the daemon's children by design and must survive its
      // crash (decision 0009): stop and restart signal the daemon alone, which
      // stops its services itself on a clean stop.
      'KillMode=process',
      // `daemon stop` waits up to 60 s for services to stop; leave room.
      'TimeoutStopSec=90',
      `StandardOutput=append:${log}`,
      `StandardError=append:${log}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return { kind, name, path: join(dir, `${name}.service`), content };
  }
  const label = name.replace(/^runly-daemon/, 'dev.runly.daemon');
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by \`runly daemon install\` (decision 0039). \`runly daemon uninstall\` removes it. -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
  return { kind, name: label, path: join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`), content };
}

/** The installed unit for this state root, if any. */
export function installedUnit(root = stateRoot()): UnitPlan | null {
  const plan = unitPlan(root);
  return plan && existsSync(plan.path) ? plan : null;
}

/**
 * Does the installed unit run THIS CLI's daemon? A unit written by another
 * install (a global one, while this CLI is a checkout) would start a daemon of
 * another version, which the version gate then refuses — and `runly update`
 * would restart the same wrong one. Such a unit is left alone.
 */
export function unitRunsThisBuild(plan: UnitPlan): boolean {
  try {
    const xmlEntry = daemonEntry().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text = readFileSync(plan.path, 'utf8');
    return text.includes(daemonEntry()) || text.includes(xmlEntry);
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return { ok: true, output: output.trim() };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, output: String(e.stderr || e.message || err).trim() };
  }
}

const uid = (): number => (typeof process.getuid === 'function' ? process.getuid() : 0);
const systemctl = (...args: string[]) => run(process.env.BACKLOT_SYSTEMCTL || 'systemctl', ['--user', ...args]);
const launchctl = (...args: string[]) => run(process.env.BACKLOT_LAUNCHCTL || 'launchctl', args);

/** Write and enable the unit. Does not start it (the caller decides: a daemon may already run). */
export function installUnit(plan: UnitPlan): { steps: string[]; error?: string } {
  const steps: string[] = [];
  mkdirSync(dirname(plan.path), { recursive: true });
  const previous = existsSync(plan.path) ? readFileSync(plan.path, 'utf8') : null;
  writeFileSync(plan.path, plan.content);
  steps.push(`${previous === null ? 'wrote' : previous === plan.content ? 'kept' : 'updated'} ${plan.path}`);
  if (plan.kind === 'systemd') {
    for (const args of [['daemon-reload'], ['enable', `${plan.name}.service`]]) {
      const r = systemctl(...args);
      if (!r.ok) return { steps, error: `systemctl --user ${args.join(' ')} failed: ${r.output}` };
      steps.push(`systemctl --user ${args.join(' ')}`);
    }
  } else {
    // bootstrap loads it (and, with RunAtLoad, starts it); reloading an
    // already-loaded label needs a bootout first.
    launchctl('bootout', `gui/${uid()}/${plan.name}`);
    const r = launchctl('bootstrap', `gui/${uid()}`, plan.path);
    if (!r.ok) return { steps, error: `launchctl bootstrap failed: ${r.output}` };
    steps.push(`launchctl bootstrap gui/${uid()} ${plan.path}`);
  }
  return { steps };
}

/** Disable and remove the unit. The daemon that runs keeps running, unsupervised. */
export function uninstallUnit(plan: UnitPlan): { steps: string[]; error?: string } {
  const steps: string[] = [];
  if (plan.kind === 'systemd') {
    const r = systemctl('disable', `${plan.name}.service`);
    if (r.ok) steps.push(`systemctl --user disable ${plan.name}.service`);
    rmSync(plan.path, { force: true });
    steps.push(`removed ${plan.path}`);
    const reload = systemctl('daemon-reload');
    if (reload.ok) steps.push('systemctl --user daemon-reload');
  } else {
    // bootout stops a launchd job; the daemon is restarted by the next verb.
    const r = launchctl('bootout', `gui/${uid()}/${plan.name}`);
    if (r.ok) steps.push(`launchctl bootout gui/${uid()}/${plan.name}`);
    rmSync(plan.path, { force: true });
    steps.push(`removed ${plan.path}`);
  }
  return { steps };
}

/** Start the installed unit (the CLI's autospawn path when one is installed). True when the start was accepted. */
export function startUnit(plan: UnitPlan): boolean {
  if (plan.kind === 'systemd') return systemctl('start', `${plan.name}.service`).ok;
  return launchctl('kickstart', `gui/${uid()}/${plan.name}`).ok;
}
