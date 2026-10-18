/** Real shipped examples through the compiled CLI, in disposable copied worktrees. */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { get } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx, waitFor } from './support/context.js';

function request(url: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = get(url, { agent: false }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      res.on('error', reject);
    });
    req.setTimeout(20_000, () => req.destroy(new Error('example response timed out')));
    req.on('error', reject);
  });
}

describe.each(['hello-web', 'hello-multi', 'hello-python'])('%s through the full worktree lifecycle', example => {
  it('measures traffic, idles without losing data, wakes, resets and destroys without changing source', async () => {
    const c = makeCtx({ BACKLOT_SERVICE_IDLE_MS: '1500' });
    const source = join(import.meta.dirname, '..', 'examples', example);
    const files = Object.fromEntries(readdirSync(source, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name !== 'smoke-report.json')
      .map(entry => [entry.name, readFileSync(join(source, entry.name), 'utf8')]));
    const wt = c.worktree(files);
    const cli = async (args: string[]) => {
      const result = await c.cli([...args, '--json'], wt);
      expect(result.code, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`).toBe(0);
      return result.json;
    };
    try {
      const up = await cli(['up']);
      const url = up.urls.web as string;
      const requestUrl = example === 'hello-python' ? `${url}/api/facts` : url;
      const data = up.datastores.main.url as string;
      expect(existsSync(data)).toBe(true);
      const originalResponse = await request(requestUrl);
      expect(originalResponse.status).toBe(200);
      const initial = await cli(['stats']);
      expect(initial.live.environments).toHaveLength(1);
      expect(initial.series.some((s: { name: string }) => s.name === 'datastore.restore_ms')).toBe(true);

      const [table, column] = example === 'hello-web' ? ['greetings', 'message'] : example === 'hello-multi' ? ['items', 'name'] : ['facts', 'fact'];
      const db = new DatabaseSync(data);
      try {
        db.exec('PRAGMA busy_timeout=1000');
        db.prepare(`INSERT INTO ${table} (${column}) VALUES (?)`).run('audit-data-survives-idle');
      } finally {
        db.close();
      }
      const mutatedResponse = await request(requestUrl);
      expect(mutatedResponse.text).toContain('audit-data-survives-idle');

      // Poll only read-only verbs: measuring the stack must not keep it awake.
      expect(await waitFor(async () => {
        await cli(['stats']);
        const ps = await cli(['ps']);
        return ps.services.length > 0 && ps.services.every((s: { state: string }) => s.state === 'idle');
      }, 20_000)).toBe(true);
      expect(existsSync(data), 'idle preserves the seeded database').toBe(true);
      expect(await request(requestUrl)).toEqual(mutatedResponse);
      let afterWake;
      expect(await waitFor(async () => {
        afterWake = await cli(['stats']);
        return afterWake.series.some((s: { name: string }) => s.name === 'wake.total_ms');
      })).toBe(true);
      expect(afterWake.series.some((s: { name: string; total: number }) => s.name === 'proxy.server_bytes' && s.total > 0)).toBe(true);
      expect(afterWake.series.some((s: { name: string }) => s.name === 'proxy.first_byte_ms')).toBe(true);

      const reset = await cli(['reset-data']);
      expect(reset.datastores.main.url).toBe(data);
      expect(reset.urls.web).toBe(url);
      expect(await request(requestUrl)).toEqual(originalResponse);
      const finalStats = await cli(['stats']);
      const restores = finalStats.series.filter((s: { name: string; labels: { outcome?: string } }) => s.name === 'datastore.restore_ms' && s.labels.outcome === 'success');
      expect(restores.reduce((count: number, s: { count: number }) => count + s.count, 0)).toBe(2);
      await cli(['destroy']);
      expect(existsSync(data)).toBe(false);
      expect((await cli(['stats'])).live.environments).toHaveLength(0);
      for (const [name, contents] of Object.entries(files)) {
        expect(readFileSync(join(wt, name), 'utf8'), `${example}/${name} remains intact`).toBe(contents);
      }
    } finally {
      c.dispose();
    }
  }, 90_000);
});
