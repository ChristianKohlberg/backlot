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
const schema = JSON.parse(readFileSync(join(root, 'schema/stack.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(schema);

const loadStack = (example: string) =>
  parse(readFileSync(join(root, 'examples', example, 'stack.yaml'), 'utf8'));

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
