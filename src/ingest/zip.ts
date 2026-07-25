import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { IngestError, formatBytes } from "./errors.js";

// adm-zip ships CJS; loading it via createRequire matches how walk.ts handles
// the same problem with `ignore` under NodeNext.
const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip") as new (buffer: Buffer) => AdmZipInstance;

interface AdmZipEntry {
  entryName: string;
  isDirectory: boolean;
  header: { size: number; attr: number };
  getData(): Buffer;
}

interface AdmZipInstance {
  getEntries(): AdmZipEntry[];
}

export interface ExtractOptions {
  maxFiles: number;
  maxUncompressedBytes: number;
}

/** Unix mode bits live in the high 16 of the external attributes field. */
function isSymlink(entry: AdmZipEntry): boolean {
  const unixMode = (entry.header.attr >>> 16) & 0xffff;
  return (unixMode & 0xf000) === 0xa000;
}

/**
 * Rejects any entry name that would write outside `destDir`. Checked against
 * the resolved path rather than the raw string, so encodings of `..` that
 * normalize back into the tree are caught too.
 */
function safeJoin(destDir: string, entryName: string): string {
  if (entryName.includes("\0")) {
    throw new IngestError("Zip contains an entry name with a null byte.");
  }
  if (path.isAbsolute(entryName) || /^[a-zA-Z]:/.test(entryName)) {
    throw new IngestError(`Zip contains an absolute path: ${entryName}`);
  }
  const target = path.resolve(destDir, entryName);
  const prefix = path.resolve(destDir) + path.sep;
  if (!target.startsWith(prefix)) {
    throw new IngestError(`Zip contains an entry that escapes the archive root: ${entryName}`);
  }
  return target;
}

/**
 * Extracts a zip into the session directory, entry by entry.
 *
 * Deliberately does not use adm-zip's `extractAllTo` — the traversal guard has
 * to run per entry, before any write, and the limits have to abort mid-archive
 * so a zip bomb is stopped while expanding rather than after.
 */
export function extractZipToDir(
  zipBuffer: Buffer,
  destDir: string,
  options: ExtractOptions,
): { fileCount: number; bytes: number } {
  let zip: AdmZipInstance;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw new IngestError("Could not read the uploaded file as a zip archive.");
  }

  let entries: AdmZipEntry[];
  try {
    entries = zip.getEntries();
  } catch {
    throw new IngestError("Could not read the uploaded file as a zip archive.");
  }

  if (entries.length === 0) {
    throw new IngestError("The uploaded zip is empty.");
  }

  let fileCount = 0;
  let bytes = 0;

  for (const entry of entries) {
    if (isSymlink(entry)) {
      throw new IngestError(`Zip contains a symlink, which is not supported: ${entry.entryName}`);
    }

    const target = safeJoin(destDir, entry.entryName);

    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    // Trust the header only to fail fast; the real count comes from the data.
    if (bytes + entry.header.size > options.maxUncompressedBytes) {
      throw new IngestError(
        `Zip expands to more than ${formatBytes(options.maxUncompressedBytes)}.`,
      );
    }

    fileCount++;
    if (fileCount > options.maxFiles) {
      throw new IngestError(`Zip contains more than ${options.maxFiles} files.`);
    }

    const data = entry.getData();
    bytes += data.length;
    if (bytes > options.maxUncompressedBytes) {
      throw new IngestError(
        `Zip expands to more than ${formatBytes(options.maxUncompressedBytes)}.`,
      );
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }

  return { fileCount, bytes };
}

/**
 * Zips of a repo usually contain a single top-level folder (`my-repo-main/`).
 * Analyzing that wrapper makes every file id start with it and puts the real
 * root one level down, so descend when the archive has exactly one directory
 * and nothing else at the top.
 */
export function unwrapSingleRoot(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const visible = entries.filter((e) => e.name !== "__MACOSX");
  if (visible.length === 1 && visible[0].isDirectory()) {
    return path.join(dir, visible[0].name);
  }
  return dir;
}
