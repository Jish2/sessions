import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { type Tool } from './types';
import { tryParse, asJsonObject, asJsonString, type JsonObject } from './extract-util';
import { getCursorProjectsDir } from './paths';

// Cursor stores agent transcripts as one JSONL file per chat under
// ~/.cursor/projects/<project-slug>/agent-transcripts/<chatId>/<chatId>.jsonl,
// with subagent transcripts nested one level deeper at <chatId>/subagents/*.jsonl.
// Everything else in this codebase reads one JSONL file per session into
// `lines: string[]`; this module bridges that gap by synthesizing an equivalent
// `lines[]` from the raw Cursor lines, so the parser and extractors treat Cursor
// like any other tool. Env override keeps tests hermetic (they point at a temp
// fixture tree), matching SESSIONS_PI_DIR / SESSIONS_OPENCODE_DB.

/** Absolute path to Cursor's projects root, honoring SESSIONS_CURSOR_DIR. I.e. ~/.cursor/projects.
 *  The resolver lives in src/paths.ts, shared with the index and the no-index scanner. */
export { getCursorProjectsDir } from './paths';

/** Whether a stored file_path denotes a Cursor agent transcript (parent session, not a subagent). */
export function isCursorPath(filePath: string): boolean {
  const rel = filePath.startsWith(getCursorProjectsDir() + sep)
    ? filePath.slice(getCursorProjectsDir().length + 1)
    : '';
  // <slug>/agent-transcripts/<chatId>/<chatId>.jsonl — subagents sit one level deeper.
  const parts = rel.split(sep);
  return parts.length === 4 && parts[1] === 'agent-transcripts' && parts[3] === parts[2] + '.jsonl';
}

/** The `<chatId>` embedded in the path (basename minus .jsonl of the chat-id-named file). */
export function sessionIdFromPath(filePath: string): string {
  const base = filePath.split(sep).pop() ?? '';
  return base.endsWith('.jsonl') ? base.slice(0, -6) : base;
}

/** A discovered session as a real transcript file path. */
interface DiscoveredSession {
  path: string;
  tool: Tool;
}

/**
 * Top-level session transcripts (subagent transcripts under a chat's `subagents/`
 * dir are excluded by the exact-depth shape — they fold into their parent via
 * collectCursorSubagentText at index time, matching pi/claude subagent handling).
 */
export function discoverCursorSessions(): DiscoveredSession[] {
  const root = getCursorProjectsDir();
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return [];
  }
  const out: DiscoveredSession[] = [];
  for (const slug of projects) {
    const transcriptsDir = join(root, slug, 'agent-transcripts');
    let chats: string[];
    try {
      chats = readdirSync(transcriptsDir);
    } catch {
      continue;
    }
    for (const chatId of chats) {
      const file = join(transcriptsDir, chatId, `${chatId}.jsonl`);
      if (existsSync(file)) out.push({ path: file, tool: 'cursor' });
    }
  }
  return out;
}

/**
 * Decode a Cursor project slug back to a directory path. Cursor encodes the cwd as
 * path segments joined by `-` (e.g. `Users-jgoon-github-ros` → /Users/jgoon/github/ros),
 * with no escape for dashes INSIDE a segment — the same ambiguity Claude's project
 * dirs have. Greedy longest-match against the real filesystem: at each step, take the
 * longest dash-joined run of remaining segments that names an existing directory.
 * Falls back to the naive dash→slash map when nothing resolves (deleted project).
 */
export function decodeCursorSlug(slug: string): string {
  const segments = slug.split('-').filter((s) => s.length > 0);
  let resolved: string = sep;
  let i = 0;
  while (i < segments.length) {
    let hit = -1;
    for (let take = segments.length - i; take >= 1; take--) {
      const candidate = segments.slice(i, i + take).join('-');
      if (existsSync(join(resolved, candidate))) {
        hit = take;
        break;
      }
    }
    if (hit === -1) return '/' + segments.join('/');
    resolved = join(resolved, segments.slice(i, i + hit).join('-'));
    i += hit;
  }
  return resolved;
}

/**
 * Cursor chunk type → the shared `{type:'tool', tool, state:{input}}` block shape the
 * OpenCode synthesizer and the extractors already understand. Cursor names have
 * drifted across releases; cover both eras. Unknown tools pass through lowercased —
 * extractors only match the names they know, so a passthrough name is inert.
 */
const CURSOR_TOOL_NAMES = {
  read: 'read',
  read_file: 'read',
  write: 'write',
  write_file: 'write',
  edit: 'edit',
  edit_file: 'edit',
  str_replace: 'edit',
  multi_edit: 'edit',
  multi_edit_file: 'edit',
  bash: 'bash',
  run_terminal_cmd: 'bash',
  shell: 'bash',
  grep: 'grep',
  grep_file: 'grep',
  glob: 'glob',
  file_glob: 'glob',
  list: 'list',
  list_dir: 'list',
  codebase_search: 'grep',
} satisfies Record<string, string>;

/** Map one raw Cursor content chunk to the normalized block, or null to drop it. */
function mapBlock(raw: JsonObject): JsonObject | null {
  switch (raw.type) {
    case 'text': {
      const text = asJsonString(raw.text);
      return text !== undefined && text.trim() ? { type: 'text', text } : null;
    }
    case 'thinking': {
      const thinking = asJsonString(raw.thinking ?? raw.text);
      return thinking?.trim() ? { type: 'thinking', thinking } : null;
    }
    case 'tool_use': {
      const name = asJsonString(raw.name);
      if (!name) return null;
      const lower = name.toLowerCase();
      // SAFETY: the `in` guard establishes lower is a key of CURSOR_TOOL_NAMES.
      const mapped = lower in CURSOR_TOOL_NAMES ? CURSOR_TOOL_NAMES[lower as keyof typeof CURSOR_TOOL_NAMES] : undefined;
      const block: JsonObject = { type: 'tool', tool: mapped ?? lower };
      if (raw.input !== undefined) block.state = { input: raw.input };
      return block;
    }
    default:
      // tool_result and friends: their text arrives via the tool block's state on
      // tools that model output; Cursor puts results on separate lines we drop.
      return null;
  }
}

/**
 * Reconstruct a Cursor chat as JSONL-style `lines[]` built entirely from shapes the
 * shared parser already understands: a pi-style `session` header carrying the decoded
 * cwd and file birthtime, then one `message` line per raw line whose content maps to
 * text/thinking/tool blocks, then a `cursor-meta` trailer carrying the file's mtime
 * as the session's last-activity time.
 *
 * Cursor transcript lines carry no `timestamp`, so the header/trailer bookends are
 * the only way `extractSessionMetadata` learns startedAt/endedAt. Both are honest:
 * birthtime is when the chat file was created, mtime is when Cursor last wrote it.
 */
export function readCursorSession(filePath: string): string[] {
  let raw: string[];
  try {
    raw = readFileSync(filePath, 'utf-8').trimEnd().split('\n');
  } catch {
    return [];
  }
  if (raw.length === 0 || raw[0] === '') return [];

  let birth: string;
  let mtime: string;
  try {
    const st = statSync(filePath);
    birth = Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtime.toISOString() : st.mtime.toISOString();
    mtime = st.mtime.toISOString();
  } catch {
    return [];
  }

  // cwd from the project slug (grandparent dir); unresolvable slugs fall back to the
  // naive decode so the session still indexes/search, just unscoped from a repo.
  const rel = filePath.slice(getCursorProjectsDir().length + 1);
  const slug = rel.split(sep)[0] ?? '';
  const cwd = decodeCursorSlug(slug);

  const lines: string[] = [];
  lines.push(JSON.stringify({ type: 'session', cwd, timestamp: birth, id: sessionIdFromPath(filePath) }));

  for (const line of raw) {
    const d = tryParse(line);
    if (!d) continue;
    const role = d.role === 'assistant' ? 'assistant' : d.role === 'user' ? 'user' : null;
    if (!role) continue;
    const msg = asJsonObject(d.message);
    const content = msg?.content ?? d.content;
    const blocks: JsonObject[] = [];
    if (Array.isArray(content)) {
      for (const c of content) {
        const parsed = asJsonObject(c);
        if (!parsed) continue;
        const mapped = mapBlock(parsed);
        if (mapped) blocks.push(mapped);
      }
    } else {
      const text = asJsonString(content);
      if (text?.trim()) blocks.push({ type: 'text', text });
    }
    if (blocks.length === 0) continue; // e.g. pure tool_result lines
    lines.push(JSON.stringify({ type: 'message', message: { role, content: blocks } }));
  }

  lines.push(JSON.stringify({ type: 'cursor-meta', timestamp: mtime }));
  return lines;
}

/**
 * Serialize a Cursor session to the normalized JSONL text the vault archives.
 * Byte-identical to what the live materializer emits (like serializeOpencodeSession),
 * so a vault copy re-parses through session-io/parser as tool `cursor` — no second
 * normalization scheme. Empty string when the transcript is gone.
 */
export function serializeCursorSession(filePath: string): string {
  return readCursorSession(filePath).join('\n');
}

/** Genuine user text across a chat's subagent (child) transcripts, for parent-session search recall. */
export function collectCursorSubagentText(filePath: string): string {
  if (!isCursorPath(filePath)) return '';
  const subagentsDir = join(dirname(filePath), 'subagents');
  let files: string[];
  try {
    files = readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return '';
  }
  const texts: string[] = [];
  for (const f of files) {
    let raw: string;
    try {
      raw = readFileSync(join(subagentsDir, f), 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const d = tryParse(line);
      if (!d || d.role !== 'user') continue;
      const msg = asJsonObject(d.message);
      const content = msg?.content ?? d.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        const block = asJsonObject(c);
        if (block?.type === 'text') {
          const text = asJsonString(block.text);
          if (text?.trim()) texts.push(text);
        }
      }
    }
  }
  return texts.join('\n');
}
