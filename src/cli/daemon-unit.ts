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
import { loadStack } from '../core/manifest.js';

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
 * The installing shell's variables a daemon needs and a unit would not have:
 * a unit starts from systemd's or launchd's bare environment, while services,
 * builds, upkeep and datastore commands run with the daemon's. Missing
 * DOTNET_ROOT made every template bake of a .NET stack fail under the unit.
 */
const CAPTURE_EXACT = ['PATH', 'LANG', 'DOTNET_ROOT', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'JAVA_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
const CAPTURE_PREFIXES = ['DOTNET_', 'LC_', 'NODE_', 'NVM_', 'SSL_CERT_'];
/** runly's own per-process tags and per-call inputs: never baked into a unit. */
const NEVER_CAPTURE = ['BACKLOT_STATE_DIR', 'BACKLOT_HOLDER_PID', 'BACKLOT_DB_COPY', 'BACKLOT_ENV_ID', 'BACKLOT_SERVICE', 'BACKLOT_STATE_ROOT', 'BACKLOT_FAKE_VERSION', 'RUNLY_SUPERVISOR', 'INVOCATION_ID'];

export interface CapturedEnv {
  /** What goes into the unit (BACKLOT_STATE_DIR and RUNLY_SUPERVISOR included). */
  env: Record<string, string>;
  /** Names taken from the installing shell, sorted. */
  captured: string[];
  /** Names the manifest's commands reference, or `--env` asked for, that this shell does not set. */
  notSet: string[];
  /** The manifest's `env_from` inputs: supplied per `up`, never stored in a unit. */
  excluded: string[];
  /** How many other variables of this shell were left out. */
  leftOut: number;
}

/**
 * `$NAME` / `${NAME}` the stack's commands read from the daemon's environment
 * — run, build, upkeep, datastore and appliance commands, auth.token — when
 * the install runs in a stack. Best effort: nothing when there is no manifest.
 */
function manifestReferences(cwd: string): { names: string[]; inputs: string[] } {
  try {
    const m = loadStack(cwd, { validate: false }).manifest;
    const texts: string[] = [];
    for (const s of Object.values(m.services ?? {})) {
      texts.push(s.run, typeof s.build === 'string' ? s.build : s.build?.run ?? '', s.ready?.cmd ?? '');
    }
    for (const u of m.upkeep ?? []) texts.push(u.run);
    for (const d of Object.values(m.datastores ?? {})) texts.push(d.create ?? '', d.drop ?? '', d.template_restore ?? '', d.list ?? '');
    for (const a of Object.values(m.appliances ?? {})) texts.push(a.start ?? '', a.stop ?? '', a.ready ?? '');
    texts.push(m.auth?.token ?? '');
    const names = new Set<string>();
    for (const t of texts) for (const match of t.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]!);
    const inputs = Object.values(m.services ?? {}).flatMap((s) => Object.keys(s.env_from ?? {}));
    return { names: [...names], inputs };
  } catch {
    return { names: [], inputs: [] };
  }
}

/**
 * What the daemon runs with under the unit: the installing shell's PATH, the
 * allowlist above, the BACKLOT_* settings, every variable the stack's commands
 * reference (when installed from a stack) and each `--env NAME` — never an
 * `env_from` input, which travels with each `up`. RUNLY_SUPERVISOR tells the
 * daemon who restarts it (`status.supervisor`).
 */
export function captureEnvironment(root: string, kind: UnitKind, extra: string[] = [], cwd = process.cwd(), from: NodeJS.ProcessEnv = process.env): CapturedEnv {
  const refs = manifestReferences(cwd);
  const inputs = new Set(refs.inputs);
  const wanted = new Set([...refs.names, ...extra]);
  const env: Record<string, string> = {};
  const captured: string[] = [];
  const notSet: string[] = [];
  let leftOut = 0;
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue;
    const take = !NEVER_CAPTURE.includes(k) && !inputs.has(k) && (
      k.startsWith('BACKLOT_') || CAPTURE_EXACT.includes(k) || CAPTURE_PREFIXES.some((p) => k.startsWith(p)) || wanted.has(k));
    if (take) {
      env[k] = v;
      captured.push(k);
    } else leftOut++;
  }
  for (const k of wanted) if (from[k] === undefined && !inputs.has(k) && !NEVER_CAPTURE.includes(k)) notSet.push(k);
  env.BACKLOT_STATE_DIR = root;
  env.RUNLY_SUPERVISOR = kind;
  return { env, captured: captured.sort(), notSet: notSet.sort(), excluded: [...inputs].filter((k) => from[k] !== undefined).sort(), leftOut };
}

/** systemd quoting for one Environment= assignment. */
const systemdEnv = (k: string, v: string): string => `Environment="${`${k}=${v}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const systemdArg = (a: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).replace(/%/g, '%%').replace(/\$/g, '$$$$');
/**
 * A path in a setting that takes the rest of the line (WorkingDirectory=,
 * StandardOutput=append:): never quoted — systemd reads quotes as part of the
 * path and refuses it as not absolute — only `%` escaped. A state root with
 * spaces works this way (verified with `systemd-analyze --user verify`).
 */
const systemdPath = (p: string): string => p.replace(/%/g, '%%');
const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function unitPlan(root = stateRoot(), extraEnv: string[] = [], opts: { capture?: boolean } = {}): (UnitPlan & { environment: CapturedEnv }) | null {
  const kind = unitKind();
  if (!kind) return null;
  const name = unitBaseName(root);
  const argv = [process.execPath, '--disable-warning=ExperimentalWarning', daemonEntry()];
  // Locating an installed unit needs only its name and path, not the capture.
  const environment = opts.capture === false
    ? { env: { BACKLOT_STATE_DIR: root, RUNLY_SUPERVISOR: kind }, captured: [], notSet: [], excluded: [], leftOut: 0 }
    : captureEnvironment(root, kind, extraEnv);
  const env = environment.env;
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
      `WorkingDirectory=${systemdPath(root)}`,
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
      `StandardOutput=append:${systemdPath(log)}`,
      `StandardError=append:${systemdPath(log)}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return { kind, name, path: join(dir, `${name}.service`), content, environment };
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
  return { kind, name: label, path: join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`), content, environment };
}

/** The installed unit for this state root, if any. */
export function installedUnit(root = stateRoot()): UnitPlan | null {
  const plan = unitPlan(root, [], { capture: false });
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
