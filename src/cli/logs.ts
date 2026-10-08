/**
 * `runly logs` (decision 0038). The daemon only says WHICH files hold the
 * environment's logs (`logs-spec`); the CLI reads, filters, interleaves and
 * follows them itself, so a long `-f` never holds a daemon request open.
 *
 *   runly logs [service…] [--lines N] [--since up|<duration>] [--grep <re>]
 *              [-f|--follow [--until <re>] [--timeout <s>]] [--build]
 *
 * Several services interleave by time with a `service | ` prefix; one named
 * service prints bare lines (the pre-0.16 output). `--until` follows until a
 * line of the CURRENT process matches (exit 0) or `--timeout` runs out (exit
 * 124, like timeout(1)).
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { interleave, markPrior, readLastLines, readLog, sinceLastStart, UPKEEP_LOG, type LogLine } from '../core/logs.js';
import { parseDuration } from '../core/units.js';

export interface LogsSpec {
  envId: string;
  dir: string;
  build: boolean;
  files: Array<{ service: string; file: string }>;
}

export interface LogsOptions {
  lines?: number;
  since?: string;
  grep?: RegExp;
  follow: boolean;
  until?: RegExp;
  timeoutMs?: number;
  json: boolean;
  /** Prefix lines with `service | ` (several services). */
  prefix: boolean;
}

/** Parse `--since`: `up`, or a duration (`90s`, `10m`, a bare number = seconds). */
export function parseSince(v: string): { kind: 'up' } | { kind: 'age'; ms: number } | undefined {
  if (v.trim().toLowerCase() === 'up') return { kind: 'up' };
  const ms = parseDuration(v);
  return ms === undefined || !Number.isFinite(ms) ? undefined : { kind: 'age', ms };
}

function select(lines: LogLine[], o: LogsOptions): LogLine[] {
  // Start markers are bookkeeping for --since up; a service that printed
  // nothing has an empty log, not a line runly wrote.
  let out = lines.filter((l) => !l.marker);
  if (o.grep) out = out.filter((l) => o.grep!.test(l.text));
  return out;
}

function render(l: LogLine, o: LogsOptions): string {
  if (o.json) return JSON.stringify({ service: l.service, at: Number.isNaN(l.at) ? null : new Date(l.at).toISOString(), text: l.text });
  return o.prefix ? `${l.service} | ${l.text}` : l.text;
}

/** Where a follower stands in one log: the live file's inode and the offset read up to. */
interface Cursor {
  ino: number;
  pos: number;
}

function cursorOf(file: string): Cursor {
  try {
    const st = statSync(file);
    return { ino: st.ino, pos: st.size };
  } catch {
    return { ino: 0, pos: 0 };
  }
}

/**
 * The backlog: what is on disk now, filtered. With `ends`, each live file is
 * read only up to that offset — where a follower then takes over, so a line
 * written while the backlog is parsed is printed once.
 *
 * Lines before a service's last start marker belong to an earlier process and
 * are marked `prior`: shown, but never what `--until` matches.
 */
export function backlog(spec: LogsSpec, o: LogsOptions, ends?: Map<string, number>): LogLine[] {
  const since = o.since === undefined ? undefined : parseSince(o.since)!;
  // --lines bounds the backlog; with --since and no --lines, the whole window.
  const limit = o.lines ?? (o.since !== undefined ? Infinity : 40);
  // The plain `--lines N` read: only the end of each file, read backwards.
  const tailOnly = since === undefined && o.grep === undefined && Number.isFinite(limit);
  const groups = spec.files.map(({ service, file }) => {
    const end = ends?.get(file);
    let lines = tailOnly ? readLastLines(file, service, limit, end) : readLog(file, service, undefined, end);
    if (since?.kind === 'up') lines = sinceLastStart(lines);
    else if (since?.kind === 'age') {
      const from = Date.now() - since.ms;
      lines = lines.filter((l) => !Number.isNaN(l.at) && l.at >= from);
    }
    return markPrior(lines);
  });
  let all = select(interleave(groups), o);
  if (Number.isFinite(limit)) all = all.slice(-limit);
  return all;
}

/**
 * Print the backlog and, with `follow`, every new line until interrupted,
 * `until` matches or `timeoutMs` passes (exit 124, like timeout(1) —
 * decision 0038 — whether or not `--until` was given). Returns the exit code.
 */
export async function showLogs(spec: LogsSpec, o: LogsOptions, write: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
  if (spec.build && !o.follow) return showBuildSections(spec, o, write);
  const start = Date.now();
  // Where the follower starts is taken BEFORE the backlog is read: a line
  // written in between is then the follower's, not lost between the two.
  const cursors = new Map<string, Cursor>(spec.files.map(({ file }) => [file, cursorOf(file)]));
  const lines = backlog(spec, o, new Map([...cursors].map(([f, c]) => [f, c.pos])));
  // `--grep` that matched nothing exits 1, like grep(1) (0.19), so a script
  // can branch on it; the (empty) answer is still printed.
  const noMatch = o.grep !== undefined && lines.length === 0 ? 1 : 0;
  if (!o.follow && o.json) {
    // `lines` keeps its pre-0.16 meaning (the text, newline-joined); `entries` is the structured form.
    const service = spec.files.length === 1 ? spec.files[0]!.service : undefined;
    write(`${JSON.stringify({ envId: spec.envId, ...(service ? { service } : {}), build: spec.build, lines: lines.map((l) => render(l, { ...o, json: false })).join('\n'), entries: lines.map((l) => JSON.parse(render(l, { ...o, json: true })) as unknown) })}\n`);
    return noMatch;
  }
  for (const l of lines) {
    write(`${render(l, o)}\n`);
    if (!l.prior && o.until?.test(l.text)) return 0;
  }
  if (!o.follow) return noMatch;

  // Follow: poll each file for what is appended past its cursor. A rotation
  // renames the live file to `.1` (same inode) and starts a new one: the rest
  // of the old file is drained from `.1` first, then the new one is read from
  // its start. A file that shrank in place (truncated) is read from its start.
  const partial = new Map<string, string>();
  const take = (file: string, service: string, text: string, into: LogLine[][]) => {
    const chunk = (partial.get(file) ?? '') + text;
    const nl = chunk.lastIndexOf('\n');
    partial.set(file, nl < 0 ? chunk : chunk.slice(nl + 1));
    if (nl >= 0) into.push(parseChunk(chunk.slice(0, nl), service));
  };
  for (;;) {
    if (o.timeoutMs !== undefined && Date.now() - start >= o.timeoutMs) return 124;
    const fresh: LogLine[][] = [];
    for (const { service, file } of spec.files) {
      const cur = cursors.get(file) ?? { ino: 0, pos: 0 };
      let st: { ino: number; size: number };
      try {
        st = statSync(file);
      } catch {
        continue; // not there (yet), or mid-rotation
      }
      if (cur.ino !== 0 && st.ino !== cur.ino) {
        // Rotated: whatever the old file got after our cursor is in `.1` now.
        try {
          const old = statSync(`${file}.1`);
          if (old.ino === cur.ino && old.size > cur.pos) take(file, service, readRange(`${file}.1`, cur.pos, old.size), fresh);
        } catch {
          /* rotated away twice, or removed */
        }
        cursors.set(file, { ino: st.ino, pos: 0 });
      } else if (cur.ino === 0) {
        cursors.set(file, { ino: st.ino, pos: cur.pos });
      }
      const now = cursors.get(file)!;
      if (st.size < now.pos) {
        now.pos = 0;
        partial.delete(file);
      }
      if (st.size === now.pos) continue;
      take(file, service, readRange(file, now.pos, st.size), fresh);
      now.pos = st.size;
    }
    for (const l of select(interleave(fresh), o)) {
      write(`${render(l, o)}\n`);
      if (o.until?.test(l.text)) return 0;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * `logs --build` without `-f` (0.19): one section per build log (the upkeep
 * output first, then each service's last build), each with its own last
 * `--lines` lines — interleaved by time, one long build pushed every other
 * section out of the window. Each header says how many lines it shows of
 * how many, so a cut is never silent. `--grep` that matches nothing in any
 * section exits 1.
 */
function showBuildSections(spec: LogsSpec, o: LogsOptions, write: (s: string) => void): number {
  const since = o.since === undefined ? undefined : parseSince(o.since)!;
  const limit = o.lines ?? (o.since !== undefined ? Infinity : 40);
  const sections = spec.files.map(({ service, file }) => {
    let lines = readLog(file, service);
    if (since?.kind === 'up') lines = sinceLastStart(lines);
    else if (since?.kind === 'age') {
      const from = Date.now() - since.ms;
      lines = lines.filter((l) => !Number.isNaN(l.at) && l.at >= from);
    }
    const all = select(lines, o);
    const shown = Number.isFinite(limit) ? all.slice(-limit) : all;
    return { service, total: all.length, shown };
  });
  const matched = sections.reduce((n, s) => n + s.total, 0);
  const code = o.grep !== undefined && matched === 0 ? 1 : 0;
  if (o.json) {
    const entries = sections.flatMap((s) => s.shown.map((l) => JSON.parse(render(l, { ...o, json: true })) as unknown));
    write(`${JSON.stringify({
      envId: spec.envId, build: true,
      sections: sections.map((s) => ({ service: s.service, lines: s.total, shown: s.shown.length, truncated: s.total - s.shown.length })),
      lines: sections.flatMap((s) => s.shown.map((l) => render(l, { ...o, json: false, prefix: spec.files.length !== 1 }))).join('\n'),
      entries,
    })}\n`);
    return code;
  }
  for (const s of sections) {
    const what = s.service === UPKEEP_LOG ? 'upkeep' : `build ${s.service}`;
    const cut = s.total - s.shown.length;
    write(`== ${what}: ${s.total === 0 ? (o.grep ? 'no matching lines' : 'no output recorded') : cut > 0 ? `last ${s.shown.length} of ${s.total} lines (${cut} earlier cut; --lines ${s.total} shows all)` : `${s.total} line${s.total === 1 ? '' : 's'}`} ==\n`);
    for (const l of s.shown) write(`${l.text}\n`);
  }
  return code;
}

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/;

function parseChunk(text: string, service: string): LogLine[] {
  return text.split('\n').map((raw) => {
    const m = STAMP.exec(raw);
    return m
      ? { service, at: Date.parse(m[1]!), text: m[2]!, marker: m[2]!.startsWith('-- runly:') }
      : { service, at: Date.now(), text: raw, marker: false };
  });
}

function readRange(file: string, from: number, to: number): string {
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(to - from);
      readSync(fd, buf, 0, buf.length, from);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}
