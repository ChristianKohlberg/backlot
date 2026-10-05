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
 * line matches (exit 0) or `--timeout` runs out (exit 124, like timeout(1)).
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { interleave, readLog, sinceLastStart, type LogLine } from '../core/logs.js';
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

/** The backlog: what is on disk now, filtered. */
export function backlog(spec: LogsSpec, o: LogsOptions): LogLine[] {
  const since = o.since === undefined ? undefined : parseSince(o.since)!;
  const groups = spec.files.map(({ service, file }) => {
    let lines = readLog(file, service);
    if (since?.kind === 'up') lines = sinceLastStart(lines);
    else if (since?.kind === 'age') {
      const from = Date.now() - since.ms;
      lines = lines.filter((l) => !Number.isNaN(l.at) && l.at >= from);
    }
    return lines;
  });
  let all = select(interleave(groups), o);
  // --lines bounds the backlog; with --since and no --lines, the whole window.
  const limit = o.lines ?? (o.since !== undefined ? Infinity : 40);
  if (Number.isFinite(limit)) all = all.slice(-limit);
  return all;
}

/**
 * Print the backlog and, with `follow`, every new line until interrupted,
 * `until` matches or `timeoutMs` passes. Returns the exit code.
 */
export async function showLogs(spec: LogsSpec, o: LogsOptions, write: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
  const start = Date.now();
  const lines = backlog(spec, o);
  if (!o.follow && o.json) {
    // `lines` keeps its pre-0.16 meaning (the text, newline-joined); `entries` is the structured form.
    const service = spec.files.length === 1 ? spec.files[0]!.service : undefined;
    write(`${JSON.stringify({ envId: spec.envId, ...(service ? { service } : {}), build: spec.build, lines: lines.map((l) => render(l, { ...o, json: false })).join('\n'), entries: lines.map((l) => JSON.parse(render(l, { ...o, json: true })) as unknown) })}\n`);
    return 0;
  }
  for (const l of lines) {
    write(`${render(l, o)}\n`);
    if (o.until?.test(l.text)) return 0;
  }
  if (!o.follow) return 0;

  // Follow: remember where each file ends now, then poll for what is appended.
  // A file that shrank (rotated, or the environment was rebuilt) is read from
  // its start again.
  const pos = new Map<string, number>();
  const partial = new Map<string, string>();
  for (const { file } of spec.files) pos.set(file, sizeOf(file));
  for (;;) {
    if (o.timeoutMs !== undefined && Date.now() - start >= o.timeoutMs) return o.until ? 124 : 0;
    const fresh: LogLine[][] = [];
    for (const { service, file } of spec.files) {
      const size = sizeOf(file);
      let from = pos.get(file) ?? 0;
      if (size < from) {
        from = 0;
        partial.delete(file);
      }
      if (size === from) continue;
      const chunk = (partial.get(file) ?? '') + readRange(file, from, size);
      pos.set(file, size);
      const nl = chunk.lastIndexOf('\n');
      partial.set(file, nl < 0 ? chunk : chunk.slice(nl + 1));
      if (nl < 0) continue;
      fresh.push(parseChunk(chunk.slice(0, nl), service));
    }
    for (const l of select(interleave(fresh), o)) {
      write(`${render(l, o)}\n`);
      if (o.until?.test(l.text)) return 0;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
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

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
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
