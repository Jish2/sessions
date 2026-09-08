import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSessions } from './scanner';
import type { JsonValue } from './extract-util';

const j = (o: JsonValue): string => JSON.stringify(o);

// Regression: pi (and claude) can write FLAT top-level .jsonl sessions next to the
// per-project subdirs. Bun.Glob.scan(<file-as-dir>) throws ENOTDIR, which used to
// kill discovery outright; these sessions must now be indexed, not crash the walk.

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-flat-'));
  for (const tool of ['pi', 'claude']) {
    const root = join(tmp, tool);
    const line = (cwd: string, prompt: string) => [
      j({ type: 'session', cwd, timestamp: '2026-09-01T10:00:00Z' }),
      j({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }),
    ];
    mkdirSync(join(root, 'some-project'), { recursive: true });
    writeFileSync(join(root, 'some-project', 'nested.jsonl'), line('/repo/nested', 'nested session prompt').join('\n') + '\n');
    writeFileSync(join(root, '2026-09-01T10-00-00_flat.jsonl'), line('/repo/flat', 'flat top-level prompt').join('\n') + '\n');
  }
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex-empty');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent
  process.env.SESSIONS_CURSOR_DIR = join(tmp, 'cursor-empty'); // absent
});

afterAll(() => {
  delete process.env.SESSIONS_PI_DIR;
  delete process.env.SESSIONS_CLAUDE_DIR;
  delete process.env.SESSIONS_CODEX_DIR;
  delete process.env.SESSIONS_OPENCODE_DB;
  delete process.env.SESSIONS_CURSOR_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe.each(['pi', 'claude'] as const)('%s discovery with a flat top-level file', (tool) => {
  test('does not throw and returns both nested and flat sessions', async () => {
    const results = await scanSessions('', tool, '');
    const prompts = results.map((r) => r.displayText).sort();
    expect(prompts).toEqual(['flat top-level prompt', 'nested session prompt']);
  });
});
