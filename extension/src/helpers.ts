import fs from "node:fs";
import path from "node:path";
import type { FileGraph } from "../../src/types.js";
import type { SourceLocation, WebviewRequest } from "./protocol.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage"]);

export function affectsGraph(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  if (parts.some((part) => SKIPPED_DIRECTORIES.has(part))) return false;
  const name = path.basename(relative);
  return name === ".gitignore" || name.endsWith(".json") ||
    (!name.endsWith(".d.ts") && SOURCE_EXTENSIONS.has(path.extname(name)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRequest(value: unknown): WebviewRequest | null {
  if (!isRecord(value)) return null;
  if (value.type === "ready" || value.type === "refresh" || value.type === "chooseWorkspace") return { type: value.type };
  if (value.type === "symbols" && typeof value.fileId === "string" && value.fileId.length <= 4096 &&
      Number.isSafeInteger(value.requestId) && (value.requestId as number) >= 0) {
    return { type: "symbols", fileId: value.fileId, requestId: value.requestId as number };
  }
  if (value.type === "open" && isRecord(value.location)) {
    const { fileId, line, preserveFocus } = value.location;
    if (typeof fileId !== "string" || fileId.length > 4096) return null;
    if (line !== undefined && (!Number.isSafeInteger(line) || (line as number) < 1)) return null;
    if (preserveFocus !== undefined && typeof preserveFocus !== "boolean") return null;
    return { type: "open", location: { fileId, line: line as number | undefined, preserveFocus } };
  }
  return null;
}

/** A message may only navigate to a current graph file still inside the workspace. */
export function sourcePath(root: string, graph: FileGraph | null, location: SourceLocation): string {
  const id = location.fileId;
  if (!graph || !graph.nodes.some((node) => node.id === id)) throw new Error("That file is not in the current code map. Refresh the map and try again.");
  if (id.includes("\0") || id.includes("\\") || path.isAbsolute(id) || id.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error("Invalid source location.");
  }
  const target = path.resolve(root, id);
  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(target);
  const relative = path.relative(realRoot, realTarget);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(realTarget).isFile()) {
    throw new Error("The source file no longer belongs to this workspace.");
  }
  return target;
}

/** Coalesces filesystem bursts and drains one last refresh after in-flight work. */
export class RefreshQueue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private dirty = false;
  private disposed = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly run: () => Promise<void>, private readonly onError: (error: unknown) => void, private readonly delayMs = 250) {}

  request(immediate = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.dirty = true;
    const done = new Promise<void>((resolve) => this.waiters.push(resolve));
    clearTimeout(this.timer);
    if (immediate) void this.drain();
    else this.timer = setTimeout(() => { void this.drain(); }, this.delayMs);
    return done;
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return;
    clearTimeout(this.timer);
    this.running = true;
    try {
      while (this.dirty && !this.disposed) {
        this.dirty = false;
        try { await this.run(); }
        catch (error) { this.onError(error); }
      }
    } finally {
      this.running = false;
      if (!this.dirty || this.disposed) this.waiters.splice(0).forEach((resolve) => resolve());
      else void this.drain();
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.dirty = false;
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
}
