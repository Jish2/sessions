import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isCursorPath,
  sessionIdFromPath,
  discoverCursorSessions,
  decodeCursorSlug,
  readCursorSession,
  serializeCursorSession,
  collectCursorSubagentText,
} from './cursor';
import { readSessionLines } from './session-io';
import { getCwdFromSession, firstPrompt, extractMessages, messageCount } from './parser';
import { extractFiles, extractFilesRead } from './extract-files';
import { extractCommands } from './extract-commands';
import { asJsonString } from './extract-util';
import type { JsonValue } from './extract-util';

const j = (o: JsonValue): string => JSON.stringify(o);

let tmp: string;
let projectsDir: string;
let realCwd: string;

const CHAT_ID = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';

// A minimal Cursor projects tree: one project whose slug resolves against the real
// filesystem, one parent chat with user + assistant turns covering every block type
// we map, one subagent transcript, and a chat-free project dir.
function buildFixtureTree(root: string): string {
  const projects = join(root, 'projects');
  // A slug whose naive decode (tmp/tmp-base/app) must NOT exist: decodeCursorSlug
  // resolves greedily against the real filesystem, so we create the real tree.
  realCwd = join(root, 'app');
  mkdirSync(realCwd, { recursive: true });
  const slug = realCwd.split('/').filter(Boolean).join('-');

  const chatDir = join(projects, slug, 'agent-transcripts', CHAT_ID);
  mkdirSync(join(chatDir, 'subagents'), { recursive: true });

  const lines = [
    j({
      role: 'user',
      message: { content: [{ type: 'text', text: '<user_query>\nfix the flaky claymorphism test\n</user_query>' }] },
    }),
    j({
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading the test file first.' },
          { type: 'tool_use', name: 'Read', input: { filePath: '/repo/app/flaky.test.ts' } },
        ],
      },
    }),
    j({
      role: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'run_terminal_cmd', input: { command: 'bun test flaky' } },
          { type: 'tool_use', name: 'edit_file', input: { filePath: '/repo/app/flaky.test.ts' } },
        ],
      },
    }),
    // Dropped block types: tool_result and empty text must not become turns.
    j({ role: 'user', message: { content: [{ type: 'tool_result', content: 'pass' }] } }),
    j({ role: 'assistant', message: { content: [{ type: 'text', text: 'All green now.' }] } }),
    // Malformed line resilience.
    '{not json',
  ];
  writeFileSync(join(chatDir, `${CHAT_ID}.jsonl`), lines.join('\n') + '\n');

  // Subagent transcripts fold into the parent's search text but not discovery.
  writeFileSync(
    join(chatDir, 'subagents', 'sub1.jsonl'),
    j({ role: 'user', message: { content: [{ type: 'text', text: 'subagent outrigger task text' }] } }) + '\n',
  );

  // A chat-free project dir, and an empty chat dir (no matching jsonl).
  mkdirSync(join(projects, 'Users-x-empty', 'agent-transcripts'), { recursive: true });

  // Deterministic mtimes: the trailer carries this as last-activity.
  const chatFile = join(chatDir, `${CHAT_ID}.jsonl`);
  const at = new Date('2026-08-31T20:00:00Z');
  const mt = new Date('2026-09-01T15:30:00Z');
  utimesSync(chatFile, at, mt);
  return projects;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-cursor-'));
  projectsDir = buildFixtureTree(tmp);
  process.env.SESSIONS_CURSOR_DIR = projectsDir;
});

afterAll(() => {
  delete process.env.SESSIONS_CURSOR_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

function chatPath(): string {
  const slug = realCwd.split('/').filter(Boolean).join('-');
  return join(projectsDir, slug, 'agent-transcripts', CHAT_ID, `${CHAT_ID}.jsonl`);
}

describe('discovery', () => {
  test('finds parent chats only', () => {
    const found = discoverCursorSessions();
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe(chatPath());
    expect(found[0]!.tool).toBe('cursor');
  });

  test('isCursorPath matches the exact-depth shape', () => {
    expect(isCursorPath(chatPath())).toBe(true);
    expect(isCursorPath(join(projectsDir, 'x', 'agent-transcripts', CHAT_ID, 'subagents', 'sub1.jsonl'))).toBe(false);
    expect(isCursorPath('/tmp/elsewhere/whatever.jsonl')).toBe(false);
  });

  test('sessionIdFromPath reads the chat id', () => {
    expect(sessionIdFromPath(chatPath())).toBe(CHAT_ID);
  });
});

describe('decodeCursorSlug', () => {
  test('resolves against the real filesystem', () => {
    const slug = realCwd.split('/').filter(Boolean).join('-');
    expect(decodeCursorSlug(slug)).toBe(realCwd);
  });

  test('falls back to naive decode for vanished trees', () => {
    expect(decodeCursorSlug('tmp-anything-here-really-missing')).toBe('/tmp/anything/here/really/missing');
  });
});

describe('readCursorSession', () => {
  test('synthesizes the normalized session shape', () => {
    const lines = readCursorSession(chatPath()).map((l) => tryParseJsonSafe(l));
    expect(lines[0]?.type).toBe('session');
    expect(asJsonString(lines[0]?.cwd)).toBe(realCwd);
    expect(asJsonString(lines[0]?.timestamp)?.startsWith('2')).toBe(true);
    const last = lines[lines.length - 1]!;
    expect(last.type).toBe('cursor-meta');
    expect(asJsonString(last.timestamp)).toContain('2026-09-01');
  });

  test('normalizes blocks and drops non-turns', () => {
    const raw = readCursorSession(chatPath());
    expect(raw.some((l) => l.includes('bun test flaky'))).toBe(true);
    expect(raw.some((l) => l.includes('flaky.test.ts'))).toBe(true);
    expect(raw.some((l) => l.includes('tool_result'))).toBe(false);
    expect(raw.some((l) => l.includes('subagent outrigger'))).toBe(false);
  });

  test('survives truncation/missing files', () => {
    expect(readCursorSession(join(projectsDir, 'nope', 'agent-transcripts', 'x', 'x.jsonl'))).toEqual([]);
  });

  test('message lines carry no fabricated timestamps', () => {
    const lines = readCursorSession(chatPath()).map((l) => tryParseJsonSafe(l));
    const messages = lines.filter((l) => l?.type === 'message');
    for (const m of messages) expect(m?.timestamp).toBeUndefined();
  });
});

describe('shared IO + parser integration', () => {
  test('readSessionLines detects cursor paths without a tool hint', () => {
    const lines = readSessionLines(chatPath());
    expect(lines[0]).toContain('"type":"session"');
    expect(lines[0]).toContain(realCwd);
  });

  test('cwd + firstPrompt + messageCount flow through the shared parser', () => {
    const lines = readSessionLines(chatPath(), 'cursor');
    expect(getCwdFromSession(lines, 'cursor')).toBe(realCwd);
    expect(firstPrompt(lines, 'cursor')).toContain('fix the flaky claymorphism test');
    expect(firstPrompt(lines, 'cursor')).not.toContain('user_query');
    expect(messageCount(lines)).toBe(4);
  });

  test('extractMessages emits dense indexed turns', () => {
    const lines = readSessionLines(chatPath(), 'cursor');
    const msgs = extractMessages(lines);
    expect(msgs.map((m) => m.index)).toEqual(msgs.map((_, i) => i));
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  test('serialize == live materialization (vault round-trip contract)', () => {
    expect(serializeCursorSession(chatPath())).toBe(readCursorSession(chatPath()).join('\n'));
  });
});

describe('extractors (opencode-shaped blocks)', () => {
  const lines = () => readSessionLines(chatPath(), 'cursor');

  test('files written come from write/edit tool blocks', () => {
    expect(extractFiles(lines(), 'cursor')).toContain('/repo/app/flaky.test.ts');
  });

  test('files read come from read tool blocks', () => {
    expect(extractFilesRead(lines(), 'cursor')).toContain('/repo/app/flaky.test.ts');
  });

  test('commands come from bash tool blocks', () => {
    expect(extractCommands(lines(), 'cursor')).toContain('bun test flaky');
  });
});

describe('subagent fold-in', () => {
  test('collectCursorSubagentText gathers child user text', () => {
    expect(collectCursorSubagentText(chatPath())).toContain('subagent outrigger task text');
  });
});

// ——— tiny test-local helpers (fixtures are trusted shapes; no validation theater) ———
function tryParseJsonSafe(line: string): Record<string, JsonValue | undefined> | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
