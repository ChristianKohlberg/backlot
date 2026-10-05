/**
 * The RUNLY_* variables that describe an environment (decision 0032): what
 * `runly ctx --env` prints and what `runly exec` exports, one set of names.
 *
 *   RUNLY_ENV_ID, RUNLY_PORT_<PORT>, RUNLY_URL_<SERVICE>,
 *   RUNLY_DATASTORE_<NAME>_URL, RUNLY_DATASTORE_<NAME>_PRESET (decision 0034),
 *   RUNLY_LOGIN_USER, RUNLY_LOGIN_PASSWORD
 *
 * Names are uppercased, any other character becomes `_`.
 */
export interface EnvVarSource {
  envId: string;
  ports?: Record<string, number>;
  urls?: Record<string, string>;
  datastores?: Record<string, { url: string; preset?: string | null }>;
  logins?: { user: string; password: string } | null;
}

/** `web-audit` -> `WEB_AUDIT`: a valid, stable shell variable suffix. */
export const envName = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** The variables, in a stable order. */
export function runlyEnvVars(c: EnvVarSource): Record<string, string> {
  const out: Record<string, string> = { RUNLY_ENV_ID: c.envId };
  for (const [k, v] of Object.entries(c.ports ?? {}).sort()) out[`RUNLY_PORT_${envName(k)}`] = String(v);
  for (const [k, v] of Object.entries(c.urls ?? {}).sort()) out[`RUNLY_URL_${envName(k)}`] = v;
  for (const [k, v] of Object.entries(c.datastores ?? {}).sort()) {
    out[`RUNLY_DATASTORE_${envName(k)}_URL`] = v.url;
    // What the datastore holds right now (decision 0034); absent before its first restore.
    if (v.preset) out[`RUNLY_DATASTORE_${envName(k)}_PRESET`] = v.preset;
  }
  if (c.logins) {
    out.RUNLY_LOGIN_USER = c.logins.user;
    out.RUNLY_LOGIN_PASSWORD = c.logins.password;
  }
  return out;
}

/** Quoted only when it has to be, so plain values stay plain. */
export const shellValue = (v: string): string => (/^[A-Za-z0-9_./:@%+,=-]*$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);

/**
 * `export KEY=value` lines. `export` is what makes them reach a child:
 * `eval "$(runly ctx --env)" && npm test` with bare `KEY=value` lines set
 * shell variables that `npm test` never saw.
 */
export function exportLines(c: EnvVarSource): string[] {
  return Object.entries(runlyEnvVars(c)).map(([k, v]) => `export ${k}=${shellValue(v)}`);
}
