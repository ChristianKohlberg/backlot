/**
 * Service logs on disk (decision 0038).
 *
 * Every line a service writes is stored with the time it arrived —
 * `<ISO-8601> <line>` — so `runly logs` can interleave several services in
 * order and answer `--since`. Each process start writes a marker line, which
 * is what `--since up` (this process's output only) finds. A file is capped
 * (BACKLOT_LOG_CAP_BYTES, default 20 MB) and rotated once: past the cap it
 * becomes `<name>.log.1`, replacing the previous rotation. Logs live in the
 * environment's private directory, so they survive idle stops and daemon
 * restarts and go with the environment.
 *
 * Build and upkeep output of the last `up` are kept apart, in
 * `<service>.build.log` and `upkeep.build.log`, replaced by each new build.
 */
import { appendFileSync, closeSync, existsSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { policy } from './policy.js';

export const START_MARKER = '-- runly:';
const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/;
/** A stamped start marker line, as it is on disk. */
const MARKER_LINE = /^\S+Z -- runly:/;

export const logFileOf = (dir: string, service: string): string => join(dir, `${service}.log`);
export const buildLogOf = (dir: string, service: string): string => join(dir, `${service}.build.log`);
export const UPKEEP_LOG = 'upkeep';

/** The marker written when a service process starts; `--since up` reads from the last one. */
export function startMarker(service: string, pid: number | undefined, reason: string): string {
  return `${START_MARKER} ${service} started${pid ? ` (pid ${pid})` : ''}${reason ? ` — ${reason}` : ''} --`;
}

/**
 * Appends time-stamped lines to one service's log. Output arrives in chunks
 * from two streams; each stream keeps its own partial line, so a line is
 * stamped once, when it completes, and stdout and stderr never splice into
 * one line.
 */
export class LogWriter {
  private size = -1;
  private partial = new Map<string, string>();

  constructor(readonly file: string, private readonly cap = policy().logCapBytes) {}

  /** A whole line from runly itself (a start marker). */
  line(text: string): void {
    this.flushAll();
    this.append(`${new Date().toISOString()} ${text}\n`);
  }

  /** A chunk of output from `stream` ('out'/'err'). */
  write(stream: string, chunk: string): void {
    if (!chunk) return;
    const text = (this.partial.get(stream) ?? '') + chunk;
    const nl = text.lastIndexOf('\n');
    if (nl < 0) {
      // Bounded: a process that never prints a newline must not grow memory.
      if (text.length > 64_000) {
        this.partial.delete(stream);
        this.append(`${new Date().toISOString()} ${text}\n`);
      } else this.partial.set(stream, text);
      return;
    }
    this.partial.set(stream, text.slice(nl + 1));
    const stamp = new Date().toISOString();
    const lines = text.slice(0, nl).split('\n');
    this.append(lines.map((l) => `${stamp} ${l}\n`).join(''));
  }

  /** The stream ended: whatever is left of its last line is written. */
  end(stream: string): void {
    const rest = this.partial.get(stream);
    this.partial.delete(stream);
    if (rest) this.append(`${new Date().toISOString()} ${rest}\n`);
  }

  private flushAll(): void {
    for (const s of [...this.partial.keys()]) this.end(s);
  }

  private append(data: string): void {
    try {
      if (this.size < 0) this.size = existsSync(this.file) ? statSync(this.file).size : 0;
      if (this.size + data.length > this.cap && this.size > 0) {
        renameSync(this.file, `${this.file}.1`);
        this.size = 0;
      }
      appendFileSync(this.file, data);
      this.size += Buffer.byteLength(data);
    } catch {
      /* log dir gone mid-teardown */
    }
  }
}

/** Rotate a log past the cap (the retention sweep's backstop for a writer that never rotated). */
export function rotateIfOver(file: string, cap: number): boolean {
  try {
    if (statSync(file).size <= cap) return false;
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

export interface LogLine {
  service: string;
  /** Epoch ms; NaN for a line written before stamping existed (kept in place). */
  at: number;
  text: string;
  /** A start marker. */
  marker: boolean;
  /** Written by an earlier process than the last start marker's (`--until` never matches it). */
  prior?: boolean;
}

/**
 * Read the tail of a file (bounded), so a 20 MB log is never one string
 * twice. `end` stops at that offset (what a follower will read from), so a
 * line appended meanwhile is read once, by the follower.
 */
function readTail(file: string, maxBytes: number, end?: number): string {
  try {
    const size = Math.min(statSync(file).size, end ?? Infinity);
    const len = Math.min(size, maxBytes);
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const text = buf.toString('utf8');
      // A cut-off first line is dropped rather than shown half.
      return len < size ? text.slice(text.indexOf('\n') + 1) : text;
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function parseInto(out: LogLine[], text: string, service: string, last: number): number {
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    const m = STAMP.exec(raw);
    if (m) {
      last = Date.parse(m[1]!);
      out.push({ service, at: last, text: m[2]!, marker: m[2]!.startsWith(START_MARKER) });
    } else {
      out.push({ service, at: last, text: raw, marker: false });
    }
  }
  return last;
}

/** Parse one log (its rotation first, then the live file up to `end`) into lines. */
export function readLog(file: string, service: string, maxBytes = 64 * 1024 * 1024, end?: number): LogLine[] {
  const out: LogLine[] = [];
  let last = NaN;
  for (const f of [`${file}.1`, file]) {
    const text = readTail(f, maxBytes, f === file ? end : undefined);
    if (text) last = parseInto(out, text, service, last);
  }
  return out;
}

/**
 * The last lines of one log — at least `want` that are not start markers, or
 * all there are — read BACKWARDS from `end` in growing chunks, into the
 * rotation only when the live file runs out. `logs --lines 40` on a 20 MB log
 * used to parse both whole files to print 40 lines.
 */
export function readLastLines(file: string, service: string, want: number, end?: number): LogLine[] {
  const content = (text: string) => text.split('\n').filter((l) => l !== '' && !MARKER_LINE.test(l)).length;
  const chunks: string[] = [];
  let have = 0;
  for (const f of [file, `${file}.1`]) {
    if (have >= want) break;
    let fd: number;
    let size: number;
    try {
      size = Math.min(statSync(f).size, f === file ? (end ?? Infinity) : Infinity);
      fd = openSync(f, 'r');
    } catch {
      continue;
    }
    try {
      let pos = size;
      let held = Buffer.alloc(0);
      let step = 64 * 1024;
      let text = '';
      while (pos > 0) {
        const len = Math.min(step, pos);
        pos -= len;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, pos);
        held = Buffer.concat([buf, held]);
        step *= 2;
        if (pos === 0) {
          text = held.toString('utf8');
          break;
        }
        // Whole lines only: what follows the first newline of what is held.
        const nl = held.indexOf(0x0a);
        if (nl < 0) continue;
        const whole = held.subarray(nl + 1).toString('utf8');
        if (have + content(whole) >= want) {
          text = whole;
          break;
        }
      }
      have += content(text);
      chunks.unshift(text);
    } finally {
      closeSync(fd);
    }
  }
  const out: LogLine[] = [];
  let last = NaN;
  for (const text of chunks) last = parseInto(out, text, service, last);
  return out;
}

/** Mark every line before the last start marker as `prior` (an earlier process's). */
export function markPrior(lines: LogLine[]): LogLine[] {
  let lastMarker = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.marker) {
      lastMarker = i;
      break;
    }
  }
  return lines.map((l, i) => (i < lastMarker ? { ...l, prior: true } : l));
}

/** Only the lines of the CURRENT process: from the last start marker on. */
export function sinceLastStart(lines: LogLine[]): LogLine[] {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.marker) return lines.slice(i);
  return lines;
}

/** Interleave several services' lines by time (stable within one service). */
export function interleave(groups: LogLine[][]): LogLine[] {
  const all = groups.flatMap((g, gi) => g.map((l, i) => ({ l, gi, i })));
  all.sort((a, b) => {
    const ta = Number.isNaN(a.l.at) ? -Infinity : a.l.at;
    const tb = Number.isNaN(b.l.at) ? -Infinity : b.l.at;
    return ta - tb || (a.gi === b.gi ? a.i - b.i : a.gi - b.gi);
  });
  return all.map((x) => x.l);
}

/** Start a build log afresh for this build. */
export function beginBuildLog(file: string, header: string): void {
  try {
    writeFileSync(file, `${new Date().toISOString()} ${START_MARKER} ${header} --\n`);
  } catch {
    /* no log dir (warm without an environment) */
  }
}
