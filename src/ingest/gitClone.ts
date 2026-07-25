import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dns from "node:dns/promises";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { IngestError, formatBytes } from "./errors.js";

const execFileAsync = promisify(execFile);

/** Only hosts on this list are cloneable. Kills the "clone an internal URL" class outright. */
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_GIT_HOSTS ?? "github.com").split(",").map((h) => h.trim().toLowerCase()),
);

const REPO_PATH = /^\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/;

/**
 * Validates a repo URL before any network call. Rejections are deliberately
 * specific so a user who pasted a valid-but-unsupported URL knows why.
 */
export function validateRepoUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new IngestError("That doesn't look like a URL.");
  }

  if (url.protocol !== "https:") {
    throw new IngestError("Only https:// repository URLs are supported.");
  }
  if (url.username || url.password) {
    throw new IngestError("Repository URLs must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new IngestError("Repository URLs must not contain a query string or fragment.");
  }
  if (url.port) {
    throw new IngestError("Repository URLs must not specify a port.");
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new IngestError(
      `Only repositories on ${[...ALLOWED_HOSTS].join(", ")} can be analyzed.`,
    );
  }
  if (!REPO_PATH.test(url.pathname)) {
    throw new IngestError("URL must point at a repository, e.g. https://github.com/owner/repo.");
  }

  const normalizedPath = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
  return `https://${url.hostname}${normalizedPath}.git`;
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return false;
  }
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(lower)) return true; // unique local
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — check the embedded address.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return false;
}

/**
 * Second layer behind the host allowlist: refuses to clone if the host resolves
 * into private space. The allowlist alone would already block this, but the
 * check keeps the guarantee if ALLOWED_GIT_HOSTS is ever widened, and closes
 * most of the DNS-rebinding gap (not all of it — the resolution git performs is
 * a separate lookup, so this is TOCTOU-racy by nature).
 */
async function assertPublicHost(hostname: string): Promise<void> {
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new IngestError(`Could not resolve ${hostname}.`);
  }
  if (addresses.length === 0) {
    throw new IngestError(`Could not resolve ${hostname}.`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new IngestError(`Refusing to clone ${hostname}: it resolves to a private address.`);
    }
  }
}

function directorySize(dir: string, limit: number): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          continue;
        }
        if (total > limit) return total;
      }
    }
  }
  return total;
}

export interface CloneOptions {
  timeoutMs: number;
  maxBytes: number;
}

/** Shallow-clones a validated URL into `destDir`. */
export async function cloneRepoToDir(
  rawUrl: string,
  destDir: string,
  options: CloneOptions,
): Promise<string> {
  const url = validateRepoUrl(rawUrl);
  await assertPublicHost(new URL(url).hostname);

  try {
    // execFile with an argument array: no shell, so the URL can't inject.
    // --depth 1 keeps history out; the tree is all the analyzer needs.
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--single-branch", "--no-tags", "--", url, destDir],
      {
        timeout: options.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          // Without this a private or misspelled repo blocks on a credential
          // prompt until the timeout instead of failing immediately.
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      },
    );
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : "";
    if (err instanceof Error && "killed" in err && err.killed) {
      throw new IngestError(
        `Cloning timed out after ${Math.round(options.timeoutMs / 1000)}s. Try a smaller repository.`,
        504,
      );
    }
    if (/not found|repository .* does not exist|authentication|could not read/i.test(stderr)) {
      throw new IngestError(
        "Repository not found. Only public repositories can be analyzed.",
        404,
      );
    }
    throw new IngestError(`git clone failed: ${stderr.slice(0, 200) || "unknown error"}`);
  }

  const size = directorySize(destDir, options.maxBytes);
  if (size > options.maxBytes) {
    throw new IngestError(
      `Repository is larger than ${formatBytes(options.maxBytes)}.`,
      413,
    );
  }

  return destDir;
}
