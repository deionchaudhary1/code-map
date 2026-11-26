import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildFileGraph } from "../src/analyzer/index.js";
import { runTrace, unexecutedFiles } from "../src/trace/runner.js";
import { fixture, shellQuote } from "./helpers.js";

test("traces actual execution and preserves nonzero exits", async (t) => {
  const root = fixture(t, {
    "run.mjs": "function called() { return 1; } function unused() {} called(); called(); process.exitCode = 3;",
    "dead.mjs": "export function never() {}",
  });
  const graph = buildFileGraph(root);
  const trace = await runTrace(graph, { rootDir: root, command: `${shellQuote(process.execPath)} run.mjs`, timeoutMs: 5000 });
  assert.equal(trace.exitCode, 3);
  assert.deepEqual(trace.executedFiles, ["run.mjs"]);
  assert.equal(trace.symbols.find((s) => s.id === "run.mjs#called")?.calls, 2);
  assert.equal(trace.symbols.find((s) => s.id === "run.mjs#unused")?.calls, 0);
  assert.deepEqual(unexecutedFiles(graph, trace), ["dead.mjs"]);
  assert.match(trace.warning ?? "", /exited with code 3/);
});

test("a timeout also stops descendants launched by the command shell", { skip: process.platform === "win32" }, async (t) => {
  const root = fixture(t, {
    "slow.mjs": 'import fs from "node:fs"; fs.writeFileSync("started", "yes"); setTimeout(() => fs.writeFileSync("orphan-output", "still running"), 900);',
  });
  const start = Date.now();
  const trace = await runTrace(buildFileGraph(root), {
    rootDir: root, command: `${shellQuote(process.execPath)} slow.mjs & wait`, timeoutMs: 350,
  });
  assert.ok(fs.existsSync(path.join(root, "started")), "fixture child must start before the timeout");
  assert.match(trace.warning ?? "", /was killed/);
  await delay(Math.max(0, 1300 - (Date.now() - start)));
  assert.equal(fs.existsSync(path.join(root, "orphan-output")), false, "timed-out descendants must not keep writing");
});

test("interrupting the CLI stops the traced process group without starting its server", { skip: process.platform === "win32" }, async (t) => {
  const root = fixture(t, {
    "slow.mjs": 'import fs from "node:fs"; fs.writeFileSync("started", "yes"); setTimeout(() => fs.writeFileSync("orphan-output", "still running"), 900);',
  });
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli, root,
    "--no-ai", "--no-open", "--run", `${shellQuote(process.execPath)} slow.mjs & wait`],
  { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("exit", resolve);
  });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(root, "started")); i++) await delay(25);
  assert.ok(fs.existsSync(path.join(root, "started")), output);
  child.kill("SIGINT");
  const result = await exited;
  await delay(1200);
  assert.equal(fs.existsSync(path.join(root, "orphan-output")), false, "Ctrl+C must not leave the traced command running");
  assert.equal(result, 130);
  assert.doesNotMatch(output, /code-map running at/);
});
