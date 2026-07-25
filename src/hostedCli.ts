#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startHostedServer, HOSTED_DEFAULTS } from "./hostedServer.js";

const execFileAsync = promisify(execFile);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`error: ${name} must be a positive number, got "${raw}"`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  // Clone is a hard requirement of hosted mode, so fail at boot rather than on
  // the first user request.
  try {
    await execFileAsync("git", ["--version"]);
  } catch {
    console.error("error: `git` is not on PATH — hosted mode needs it to clone repositories.");
    process.exit(1);
  }

  const options = {
    port: envInt("PORT", 4280),
    ollamaModel: process.env.OLLAMA_MODEL ?? HOSTED_DEFAULTS.ollamaModel,
    sessionTtlMs: envInt("SESSION_TTL_MS", HOSTED_DEFAULTS.sessionTtlMs),
    maxUploadBytes: envInt("MAX_UPLOAD_BYTES", HOSTED_DEFAULTS.maxUploadBytes),
    maxRepoBytes: envInt("MAX_REPO_BYTES", HOSTED_DEFAULTS.maxRepoBytes),
    maxFiles: envInt("MAX_FILES", HOSTED_DEFAULTS.maxFiles),
    cloneTimeoutMs: envInt("CLONE_TIMEOUT_MS", HOSTED_DEFAULTS.cloneTimeoutMs),
    rateLimitMax: envInt("RATE_LIMIT_MAX", HOSTED_DEFAULTS.rateLimitMax),
  };

  const url = await startHostedServer(options);
  console.log(`code-map (hosted) running at ${url}`);
  console.log(
    `limits: ${options.maxFiles} files, ` +
      `${Math.round(options.maxUploadBytes / 1_000_000)} MB upload, ` +
      `${Math.round(options.maxRepoBytes / 1_000_000)} MB repo, ` +
      `${Math.round(options.sessionTtlMs / 60_000)} min session TTL`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
