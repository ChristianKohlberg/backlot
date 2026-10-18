/**
 * The manifest schema is a contract: both example stacks must validate, and
 * the schema must actually REJECT malformed manifests (a schema that accepts
 * everything protects nothing).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';

const root = join(import.meta.dirname, '..');
const schema = JSON.parse(readFileSync(join(root, 'schema/runly.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(schema);

const loadStack = (example: string) =>
  parse(readFileSync(join(root, 'examples', example, 'runly.yml'), 'utf8'));

describe('stack.schema.json', () => {
  it('accepts examples/hello-web', () => {
    const ok = validate(loadStack('hello-web'));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('accepts examples/hello-multi', () => {
    const ok = validate(loadStack('hello-multi'));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('rejects a manifest without name/services', () => {
    expect(validate({})).toBe(false);
    expect(validate({ name: 'x' })).toBe(false);
    expect(validate({ services: {} })).toBe(false);
  });

  it('rejects a service without run', () => {
    expect(validate({ name: 'x', services: { web: { port: 'web' } } })).toBe(false);
  });

  it('rejects unknown top-level and service-level keys (typo protection)', () => {
    expect(validate({ name: 'x', services: { web: { run: 'node s.mjs' } }, substrate: 'morph' })).toBe(false);
    expect(validate({ name: 'x', services: { web: { run: 'node s.mjs', readyness: {} } } })).toBe(false);
  });

  it('rejects policy smuggled into the manifest (no pool/ttl keys exist)', () => {
    expect(validate({ name: 'x', services: { web: { run: 'node s.mjs' } }, pool: { size: 4 } })).toBe(false);
  });

  it('rejects an unknown datastore driver', () => {
    expect(
      validate({
        name: 'x',
        services: { web: { run: 'node s.mjs' } },
        datastores: { main: { driver: 'mongodb' } },
      }),
    ).toBe(false);
  });

  it('rejects invalid symbolic port names', () => {
    expect(validate({ name: 'x', services: { web: { run: 'node s.mjs', port: 'Web Port' } } })).toBe(false);
  });
});

describe('auth.logins (one login or several)', () => {
  const withAuth = (logins: unknown) => ({
    name: 'x',
    services: { web: { run: 'node s.mjs' } },
    auth: { logins },
  });

  it('still accepts the single-object form', () => {
    // The original shape. A stack that never grows a second login must not have
    // to change to keep validating.
    expect(validate(withAuth({ user: 'qa-admin', password: 'p' }))).toBe(true);
  });

  it('accepts a list, with role and description per entry', () => {
    const ok = validate(
      withAuth([
        { user: 'qa-admin', password: 'p', role: 'admin', description: 'all rights, all branches' },
        { user: 'qa-readonly', password: 'p', description: 'read-only' },
      ]),
    );
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('rejects an empty list, a bad entry, and unknown keys (typo protection)', () => {
    // An empty list says "logins are declared" while declaring none — a manifest
    // bug, not a way to express "no logins" (that is omitting the key).
    expect(validate(withAuth([]))).toBe(false);
    expect(validate(withAuth([{ user: 'qa-admin' }]))).toBe(false);
    expect(validate(withAuth([{ user: 'qa-admin', password: 'p', purpose: 'typo' }]))).toBe(false);
    expect(validate(withAuth({ user: 'qa-admin', password: 'p', roles: ['admin'] }))).toBe(false);
  });
});

describe('normalizeLogins', () => {
  it('gives one shape for both manifest forms, preserving order', async () => {
    const { normalizeLogins } = await import('../src/core/manifest.js');
    const one = { user: 'qa-admin', password: 'p' };
    const many = [one, { user: 'qa-readonly', password: 'p', description: 'read-only' }];
    // Omitted is [] — not undefined — so a caller can enumerate without a guard.
    expect(normalizeLogins(undefined)).toEqual([]);
    // A single-object manifest reports exactly one entry, so `allLogins` never
    // makes a consumer branch on which form the manifest used.
    expect(normalizeLogins(one)).toEqual([one]);
    // Manifest order is the contract: entry 0 is what ctx reports as `logins`.
    expect(normalizeLogins(many)).toEqual(many);
    expect(normalizeLogins(many)[0]).toBe(one);
  });
});

describe('stack identity (loadStack)', () => {
  it('sibling worktrees with the same repo dir name get DISTINCT stack ids', async () => {
    // The id used to key on base64url(root).slice(-8) — the last ~6 BYTES of
    // the path — so /work/agent-1/myapp and /work/agent-2/myapp (the
    // agent-per-worktree layout runly targets) collided and silently shared
    // one pool, one journal namespace, and one template store.
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { loadStack } = await import('../src/core/manifest.js');
    const base = mkdtempSync(join(tmpdir(), 'runly-id-'));
    try {
      const manifest = 'name: myapp\nservices:\n  web:\n    run: node s.mjs\n    port: web\n';
      for (const agent of ['agent-1', 'agent-2']) {
        mkdirSync(join(base, agent, 'myapp'), { recursive: true });
        writeFileSync(join(base, agent, 'myapp', 'runly.yml'), manifest);
      }
      const a = loadStack(join(base, 'agent-1', 'myapp'));
      const b = loadStack(join(base, 'agent-2', 'myapp'));
      expect(a.id).not.toBe(b.id);
      // Same checkout keeps a stable id — pools must survive daemon restarts.
      expect(loadStack(join(base, 'agent-1', 'myapp')).id).toBe(a.id);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('manifest filenames', () => {
  it('accepts both Runly extensions, prefers yml, searches upward and rejects retired names', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { loadStack } = await import('../src/core/manifest.js');
    const base = mkdtempSync(join(tmpdir(), 'runly-manifest-'));
    try {
      for (const name of ['runly.yml', 'runly.yaml', 'backlot.yml', 'stack.yaml']) {
        const dir = join(base, 'case-' + name);
        mkdirSync(join(dir, 'child'), { recursive: true });
        writeFileSync(join(dir, name), 'name: filename-test\nservices: {web: {run: "true"}}\n');
        if (name.startsWith('runly.')) {
          expect(loadStack(join(dir, 'child')).file).toBe(name);
        } else {
          expect(() => loadStack(dir)).toThrow(/no runly.yml or runly.yaml/);
        }
      }
      const both = join(base, 'both');
      mkdirSync(both);
      writeFileSync(join(both, 'runly.yaml'), 'name: yaml-choice\nservices: {web: {run: "true"}}\n');
      writeFileSync(join(both, 'runly.yml'), 'name: yml-choice\nservices: {web: {run: "true"}}\n');
      expect(loadStack(both).manifest.name).toBe('yml-choice');
      // An invalid preferred file must not silently fall back to another config.
      writeFileSync(join(both, 'runly.yml'), 'name: [invalid]\nservices: {web: {run: "true"}}\n');
      expect(() => loadStack(both)).toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
