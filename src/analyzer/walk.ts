import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Ignore } from "ignore";

// The `ignore` package ships a CJS build whose type declarations don't
// synthesize a clean default export under NodeNext + esModuleInterop, so we
// load it via createRequire and keep the import purely for its types.
const require = createRequire(import.meta.url);
const ignoreFactory: (options?: unknown) => Ignore = require("ignore");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ALWAYS_SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage"]);

/** Raised when `maxFiles` is exceeded, so callers can distinguish "too big" from a real failure. */
export class TooManyFilesError extends Error {
  constructor(public readonly limit: number) {
    super(`project contains more than ${limit} source files`);
    this.name = "TooManyFilesError";
  }
}

export interface WalkOptions {
  /**
   * Abort with TooManyFilesError past this many source files. Left undefined by
   * the local CLI (no limit); the hosted server sets it, since there the walk
   * runs on someone else's machine against an untrusted upload.
   */
  maxFiles?: number;
}

/**
 * Recursively walks `rootDir` and returns absolute paths of files with a
 * supported extension, skipping the always-ignored directories, `.d.ts`
 * files, and anything matched by a `.gitignore` at the root.
 */
export function walkSourceFiles(rootDir: string, options: WalkOptions = {}): string[] {
  const { maxFiles } = options;
  const ig = ignoreFactory();
  const gitignorePath = path.join(rootDir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }

  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        if (ig.ignores(relativePath) || ig.ignores(relativePath + "/")) continue;
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".d.ts")) continue;

      const ext = path.extname(entry.name);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      if (ig.ignores(relativePath)) continue;

      results.push(absolutePath);
      if (maxFiles !== undefined && results.length > maxFiles) {
        throw new TooManyFilesError(maxFiles);
      }
    }
  }

  walk(rootDir);
  return results;
}

export { SOURCE_EXTENSIONS };
