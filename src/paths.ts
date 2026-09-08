// Where sessions keeps durable, non-cache state on disk.
//
// This is deliberately a neutral module rather than part of src/memory/store.ts:
// the installer (src/setup.ts) and the memory store both own things inside the data
// dir, and having the installer import a path from a feature module inverts the
// dependency and drags bun:sqlite into the setup/uninstall path. Path resolution
// living beside its consumers is the same shape as getCacheDir/getDbPath in
// src/cache.ts — this file is that, for the durable directory.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Home root. `SESSIONS_HOME` exists so the installer can be exercised against a temp
 * dir: src/mcp-config.ts edits real client config files (~/.codex/config.toml among
 * them), and a test that writes those for real is not a test anyone can run twice.
 */
export function getHome(): string {
  return process.env.SESSIONS_HOME || homedir();
}

/**
 * The durable data directory. Honors SESSIONS_DATA_DIR and is resolved lazily —
 * never frozen at import — for the same reason as src/cache.ts:41-45: the module
 * instance is shared across a `bun test` run, so a test that mutates the env on an
 * already-imported module must still be honored.
 */
export function getDataDir(): string {
  return process.env.SESSIONS_DATA_DIR || join(getHome(), '.local', 'share', 'sessions');
}

/** The memory store. Deliberately outside the cache dir — see src/memory/store.ts. */
export function getMemoryDbPath(): string {
  return join(getDataDir(), 'memory.db');
}

/**
 * The transcript vault: an append-only, user-owned archive of session transcripts.
 * Built on getDataDir() (the ~/.local/share/sessions durable-data convention that
 * `sessions uninstall` leaves alone) so it inherits SESSIONS_DATA_DIR, with
 * SESSIONS_ARCHIVE_DIR as the direct override. Resolved lazily — never frozen at
 * import — for the same test-hermeticity reason as getDataDir above.
 */
export function getArchiveDir(): string {
  return process.env.SESSIONS_ARCHIVE_DIR || join(getDataDir(), 'archive');
}

/**
 * Where Pi keeps its session transcripts. One resolver shared by the index
 * (src/cache.ts), the no-index scanner (src/scanner.ts), and the usage report
 * (src/report/extract.ts) so all three always look at the same tree.
 *
 * Order:
 *   1. SESSIONS_PI_DIR — this project's own override (tests, unusual setups);
 *   2. PI_CODING_AGENT_SESSION_DIR — Pi's documented session-storage override;
 *   3. PI_CODING_AGENT_DIR — Pi's config-dir override (sessions live under it);
 *   4. ~/.pi/agent/sessions — Pi's default.
 * Resolved lazily (never frozen at import) for the same test-hermeticity reason
 * as getDataDir above.
 */
export function getPiSessionsDir(): string {
  if (process.env.SESSIONS_PI_DIR) return process.env.SESSIONS_PI_DIR;
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
  if (process.env.PI_CODING_AGENT_DIR) return join(process.env.PI_CODING_AGENT_DIR, 'sessions');
  return join(homedir(), '.pi', 'agent', 'sessions');
}

/**
 * Where Cursor keeps per-project agent transcripts. One resolver shared by the index
 * (src/cache.ts), the no-index scanner (src/scanner.ts), and the normalizer
 * (src/cursor.ts) so all three always look at the same tree.
 * Honors SESSIONS_CURSOR_DIR (tests, unusual setups); resolved lazily — never frozen
 * at import — for the same test-hermeticity reason as getDataDir above.
 */
export function getCursorProjectsDir(): string {
  return process.env.SESSIONS_CURSOR_DIR || join(homedir(), '.cursor', 'projects');
}

/** Claude Code's per-project transcripts root. Lazily resolved (never frozen at
 *  import) so tests can redirect it via SESSIONS_CLAUDE_DIR — same contract as
 *  getPiSessionsDir above. */
export function getClaudeProjectsDir(): string {
  return process.env.SESSIONS_CLAUDE_DIR || join(homedir(), '.claude', 'projects');
}

/** Codex's flat rollout tree. Lazily resolved via SESSIONS_CODEX_DIR — same contract. */
export function getCodexSessionsDir(): string {
  return process.env.SESSIONS_CODEX_DIR || join(homedir(), '.codex', 'sessions');
}

function hasExplicitPiOverride(): boolean {
  return Boolean(
    process.env.SESSIONS_PI_DIR || process.env.PI_CODING_AGENT_SESSION_DIR || process.env.PI_CODING_AGENT_DIR,
  );
}

/**
 * All pi-format session roots to index, deduped and existence-filtered.
 *
 * An explicit override (SESSIONS_PI_DIR / PI_CODING_AGENT_SESSION_DIR /
 * PI_CODING_AGENT_DIR) always wins alone — tests and custom installs keep
 * single-root behavior. With no override, every known home is scanned: Pi's
 * default (~/.pi/agent/sessions), an ambient Tau install's TAU_CODING_AGENT_DIR,
 * and Tau's default (~/.tau/agent/sessions). Tau is a pi rebrand that replaces
 * the config-dir env var rather than setting PI_CODING_AGENT_DIR, so a plain
 * ~/.pi default alone misses a Tau corpus (and vice versa).
 */
export function getPiSessionRoots(): string[] {
  if (hasExplicitPiOverride()) return [getPiSessionsDir()];
  const candidates = [
    join(homedir(), '.pi', 'agent', 'sessions'),
    process.env.TAU_CODING_AGENT_DIR ? join(process.env.TAU_CODING_AGENT_DIR, 'sessions') : '',
    join(homedir(), '.tau', 'agent', 'sessions'),
  ];
  return [...new Set(candidates.filter((p) => p !== '' && existsSync(p)))];
}
