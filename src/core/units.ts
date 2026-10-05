/**
 * The two units a manifest and the policy knobs speak: durations (`90s`,
 * `10m`, `2h`) and sizes (`600M`, `2G`). Parsing lives in one place so the
 * schema, the engine and `runly plan` can never disagree about what `2G` is.
 */

/**
 * A duration in milliseconds. Strings take a unit (`ms`, `s`, `m`, `h`, `d`);
 * a bare number is SECONDS (the manifest convention, like `timeout:`).
 * `never`/`off` is Infinity. Returns undefined for anything unreadable.
 */
export function parseDuration(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v * 1000 : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'never' || s === 'off') return Infinity;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

/**
 * A size in bytes. Numbers are bytes; strings take K/M/G/T (binary multiples,
 * with or without `i`/`B`): `600M`, `2G`, `1.5GiB`. Undefined when unreadable.
 */
export function parseSize(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt])?(i?b)?$/i.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const exp = unit === 'k' ? 1 : unit === 'm' ? 2 : unit === 'g' ? 3 : unit === 't' ? 4 : 0;
  return Math.round(n * 1024 ** exp);
}

/** `2.0G`, `600M`, `12K` — for humans, one decimal at most. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return '∞';
  const units = ['B', 'K', 'M', 'G', 'T'];
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

/** `45s`, `10m`, `1.5h`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'never';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
