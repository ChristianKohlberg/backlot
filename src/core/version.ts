/**
 * The one place that knows what version this build is, and the only comparison
 * of a CLI against the daemon it is talking to.
 *
 * Read from package.json rather than baked into a constant: the MCP adapter
 * carried a hand-maintained version that drifted (0.4.0 while the package
 * shipped 0.5.0), so clients were told the wrong version of the tool they were
 * driving. One path serves both installs — the npm tarball ships package.json
 * beside `dist/`, and a git checkout has it at the same relative position.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readVersion(): string {
  // A test cannot provoke version skew from a single build any other way: the
  // CLI spawns the daemon from its OWN dist, so both sides always agree. This
  // lets a test stand up a daemon that CLAIMS a different version than the CLI
  // driving it. Never set it in real use.
  const fake = process.env.BACKLOT_FAKE_VERSION;
  if (fake) return fake;
  try {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const v = (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: unknown }).version;
    if (typeof v === 'string' && v !== '') return v;
  } catch {
    /* fall through — see below */
  }
  // A build whose package.json is missing or unreadable still has to work: the
  // version is a diagnostic, and failing every verb over an unreadable
  // diagnostic would be worse than not knowing. `doctor` reports the gap, and
  // an unknown version never counts as skew (it cannot be compared, and
  // refusing on "I don't know" would wedge such an install completely).
  return 'unknown';
}

export const VERSION: string = readVersion();

/**
 * Which BUILD of this version is running — the modification time of this very
 * module, as the process saw it when it loaded.
 *
 * The version alone cannot tell a rebuilt checkout from the build it replaced:
 * `git pull && npm run build` on a checkout install keeps package.json at the
 * same version while every file under dist/ changes, so `runly update` used to
 * report "already runly 0.12.0 — nothing to do" and leave the old code serving.
 * The daemon reads this once at start and keeps it; the CLI reads it fresh, so
 * any rebuild or reinstall since the daemon started shows up as a difference.
 * `unknown` (unreadable) never counts as a difference, for the same reason an
 * unknown version never counts as skew.
 */
function readBuild(): string {
  const fake = process.env.BACKLOT_FAKE_BUILD;
  if (fake) return fake;
  try {
    return String(Math.trunc(statSync(fileURLToPath(import.meta.url)).mtimeMs));
  } catch {
    return 'unknown';
  }
}

export const BUILD: string = readBuild();

/** True only when both builds are known and differ — a same-version rebuild or reinstall. */
export function rebuiltSince(cliBuild: string, daemonBuild: string | undefined): boolean {
  if (daemonBuild === undefined || daemonBuild === 'unknown' || cliBuild === 'unknown') return false;
  return cliBuild !== daemonBuild;
}

/**
 * Order two versions, or return undefined when they cannot be ordered.
 *
 * Deliberately not a full semver implementation: the only question asked of it
 * is "is the daemon behind or ahead of this CLI", and the answer drives a
 * message plus a refusal, never an install decision. A prerelease suffix makes
 * two versions UNORDERED rather than guessing at precedence — a wrong guess
 * would let `update` silently downgrade a daemon.
 */
export function compareVersions(a: string, b: string): number | undefined {
  if (a === b) return 0;
  if (a === 'unknown' || b === 'unknown') return undefined;
  const parse = (v: string): { nums: number[]; suffix: string } | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v.trim());
    if (!m) return undefined;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], suffix: m[4] ?? '' };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return undefined;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i]! !== pb.nums[i]!) return pa.nums[i]! < pb.nums[i]! ? -1 : 1;
  }
  // Same release numbers, different text (a prerelease against its release, or
  // two prereleases): different builds, no defensible order.
  return undefined;
}

export type SkewDirection = 'daemon-older' | 'daemon-newer' | 'daemon-unversioned' | 'unordered';

export interface VersionSkew {
  cli: string;
  daemon: string;
  direction: SkewDirection;
  /** Human sentence, ending in the remedy. Reused verbatim by CLI and doctor. */
  message: string;
}

/**
 * Compare this CLI against the daemon actually answering on the socket.
 *
 * This exists because `ensureDaemon` spawns the daemon from the CLI's own
 * `dist/`, which means an upgrade replaces both files but does NOT replace the
 * RUNNING daemon — it keeps serving old code for as long as it lives, and the
 * socket carries no version. An old daemon does not reject arguments it has
 * never heard of, it ignores them: a 0.8.0 daemon asked for `up --data-only`
 * boots the whole application instead, and the caller is told nothing. That is
 * the same failure shape as issue #41 — a wrong result that reads as a bug in
 * a different subsystem — which is why skew is refused rather than warned
 * about.
 *
 * `daemon` is undefined when the daemon predates version reporting (<= 0.8.0),
 * which is itself proof of skew for any build that has this function.
 */
export function versionSkew(cli: string, daemon: string | undefined): VersionSkew | null {
  if (daemon === undefined) {
    return {
      cli,
      daemon: 'pre-0.9.0',
      direction: 'daemon-unversioned',
      message:
        `the running daemon predates version reporting (runly <= 0.8.0) while this CLI is ${cli} — ` +
        `it would serve your request with the old code, silently ignoring anything this version added. ` +
        `Run 'runly update' to restart the daemon onto the installed version.`,
    };
  }
  if (daemon === cli) return null;
  const order = compareVersions(daemon, cli);
  const direction: SkewDirection = order === undefined ? 'unordered' : order < 0 ? 'daemon-older' : 'daemon-newer';
  const tail =
    direction === 'daemon-newer'
      ? `You are running an OLDER CLI than the daemon; 'runly update' would DOWNGRADE it, so it refuses without --force. ` +
        `Prefer invoking the newer CLI, or upgrade this one.`
      : `Run 'runly update' to restart the daemon onto the installed version.`;
  return {
    cli,
    daemon,
    direction,
    message: `the running daemon is runly ${daemon} but this CLI is ${cli} — it would serve your request with the other build's code. ${tail}`,
  };
}
