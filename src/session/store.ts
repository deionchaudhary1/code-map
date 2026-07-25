import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { FileGraph } from "../types.js";

/**
 * One analyzed upload or clone. The extracted/cloned tree stays on disk for the
 * session's lifetime because `buildSymbolGraph` and the explain prompt builder
 * both re-read source files per request rather than working from the graph.
 */
export interface Session {
  id: string;
  /**
   * The session's own directory — always SESSION_ROOT/id, and the unit of
   * cleanup. Distinct from projectDir because a zip wrapped in a single folder
   * puts the project a level down; deleting projectDir would strand this one.
   */
  dir: string;
  /** Where the analyzer actually ran. Never sent to the client. */
  projectDir: string;
  graph: FileGraph;
  createdAt: number;
  lastAccessedAt: number;
  /** How the tree got here, for logging. */
  origin: string;
}

const SESSION_ROOT = path.join(os.tmpdir(), "code-map-sessions");

const sessions = new Map<string, Session>();

/**
 * Creates the session directory and reserves an id. The caller populates
 * `tempDir` and then calls `registerSession` once analysis succeeds — a session
 * is only reachable over HTTP after it has a graph.
 */
export function createSessionDir(): { id: string; dir: string } {
  const id = crypto.randomUUID();
  const dir = path.join(SESSION_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

export function registerSession(
  id: string,
  dir: string,
  projectDir: string,
  graph: FileGraph,
  origin: string,
): Session {
  const now = Date.now();
  const session: Session = {
    id,
    dir,
    projectDir,
    graph,
    createdAt: now,
    lastAccessedAt: now,
    origin,
  };
  sessions.set(id, session);
  return session;
}

/** Returns the session and marks it active, or undefined if unknown/expired. */
export function getSession(id: string): Session | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  session.lastAccessedAt = Date.now();
  return session;
}

export function deleteSession(id: string): void {
  const session = sessions.get(id);
  sessions.delete(id);
  if (session) removeDir(session.dir);
}

/** Removes a directory that never became a session (failed upload/clone/analysis). */
export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`failed to remove ${dir}:`, err instanceof Error ? err.message : err);
  }
}

export function sessionCount(): number {
  return sessions.size;
}

/**
 * Expires sessions idle longer than `ttlMs`. Also removes directories under the
 * session root with no live session, which is what reclaims disk after a crash
 * or restart — the in-memory map is gone by then but the trees are still there.
 */
export function sweep(ttlMs: number): number {
  const cutoff = Date.now() - ttlMs;
  let removed = 0;

  for (const [id, session] of sessions) {
    if (session.lastAccessedAt < cutoff) {
      sessions.delete(id);
      removeDir(session.dir);
      removed++;
    }
  }

  let orphans: string[];
  try {
    orphans = fs.readdirSync(SESSION_ROOT);
  } catch {
    return removed;
  }
  for (const name of orphans) {
    if (sessions.has(name)) continue;
    const dir = path.join(SESSION_ROOT, name);
    try {
      // mtime, not the map, is the only evidence available for a directory
      // left behind by a previous process.
      if (fs.statSync(dir).mtimeMs >= cutoff) continue;
    } catch {
      continue;
    }
    removeDir(dir);
    removed++;
  }

  return removed;
}

export function startCleanupSweep(intervalMs: number, ttlMs: number): NodeJS.Timeout {
  const timer = setInterval(() => {
    const removed = sweep(ttlMs);
    if (removed > 0) console.log(`session sweep: removed ${removed} expired session(s)`);
  }, intervalMs);
  timer.unref();
  return timer;
}
