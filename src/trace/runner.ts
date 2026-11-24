import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { FileGraph, RuntimeTrace } from "../types.js";
import { mapCoverage } from "./coverage.js";

export interface TraceOptions {
  command: string;
  rootDir: string;
  timeoutMs: number;
}

interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Runs `command` in a shell from the project root with coverage collection on.
 *
 * A shell is used deliberately: the point is that `--run "npm test -- --watch=false"`
 * behaves the way it would if the user typed it. The command comes from the
 * user's own terminal about their own project, which is the same trust level as
 * running it directly. This must never be driven by remote input — see the
 * security boundary in plans/RUNTIME.md.
 */
function runCommand(options: TraceOptions, coverageDir: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(options.command, {
      cwd: options.rootDir,
      shell: true,
      stdio: "inherit", // a test run should still look like a test run
      env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, durationMs: Date.now() - started });
    });
  });
}

/**
 * Executes the traced command and folds the result into a RuntimeTrace.
 *
 * Returns a trace even when the run fails: a crashing program still executed
 * code worth looking at, and the failure is reported as a warning rather than
 * swallowed or thrown.
 */
export async function runTrace(graph: FileGraph, options: TraceOptions): Promise<RuntimeTrace> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `code-map-trace-${crypto.randomUUID().slice(0, 8)}-`));
  const coverageDir = path.join(tempDir, "coverage");
  fs.mkdirSync(coverageDir, { recursive: true });

  const startedAt = new Date().toISOString();

  try {
    const result = await runCommand(options, coverageDir);
    const mapped = mapCoverage(coverageDir, graph, options.rootDir);

    let warning: string | undefined;
    if (result.timedOut) {
      warning =
        `The command was still running after ${Math.round(options.timeoutMs / 1000)}s and was killed. ` +
        "V8 writes coverage only on a clean exit, so nothing was captured — " +
        "raise --trace-timeout, or use a command that terminates on its own.";
    } else if (mapped.executedFiles.length === 0 && mapped.unmappedFiles.length > 0) {
      // The overwhelmingly common cause for a TypeScript project: the command
      // ran built output while the graph describes the sources it was built
      // from. Naming the directory beats a generic "nothing executed".
      const dirs = [...new Set(mapped.unmappedFiles.map((f) => f.split("/")[0]))].slice(0, 3);
      warning =
        `The code that ran (${dirs.join(", ")}) isn't the code that was analyzed. ` +
        "This happens when the command executes build output but the graph describes " +
        "the source it was built from — analyze the built directory, or run the sources " +
        "directly (for example with tsx).";
    } else if (mapped.executedFiles.length === 0) {
      warning =
        "The command finished but no project files were recorded as executed. " +
        "This usually means it ran a different runtime than Node, or only touched " +
        "files outside the analyzed directory.";
    } else if (result.exitCode !== 0) {
      warning = `The command exited with code ${result.exitCode}. The trace covers what ran before it failed.`;
    }

    return {
      command: options.command,
      exitCode: result.exitCode,
      startedAt,
      durationMs: result.durationMs,
      tier: "coverage",
      executedFiles: mapped.executedFiles,
      fileHits: mapped.fileHits,
      symbols: mapped.symbols,
      callEdges: [],
      truncated: false,
      unmappedFiles: mapped.unmappedFiles,
      warning,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Files in the graph that the trace never saw execute. */
export function unexecutedFiles(graph: FileGraph, trace: RuntimeTrace): string[] {
  const executed = new Set(trace.executedFiles);
  return graph.nodes.filter((n) => !executed.has(n.id)).map((n) => n.id);
}
