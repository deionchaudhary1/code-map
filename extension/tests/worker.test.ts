import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisClient } from "../src/analysisClient.js";

const workerPath = fileURLToPath(new URL("../dist/analysisWorker.cjs", import.meta.url));

test("packaged analysis worker resolves dependencies and source locations, recovers from invalid configs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-map-worker-"));
  const client = new AnalysisClient(workerPath);
  t.after(() => { client.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, "a.ts"), '\nimport { b } from "./b.js";\nexport function run() { return b; }');
  fs.writeFileSync(path.join(root, "b.ts"), "export const b = 1;");
  const graph = await client.analyze(root, 50);
  assert.equal(graph.stats.fileCount, 2); assert.equal(graph.edges[0].line, 2);
  const symbols = await client.symbols(root, "a.ts");
  assert.equal(symbols.nodes[0].startLine, 3);
  await assert.rejects(client.analyze(root, 1), /more than 1/);
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{");
  await assert.rejects(client.analyze(root, 50), /tsconfig.json/);
  fs.unlinkSync(path.join(root, "tsconfig.json"));
  assert.equal((await client.analyze(root, 50)).stats.fileCount, 2);
});

test("disposing an analysis worker settles in-flight requests and rejects future ones", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-map-dispose-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.ts"), "export {}; ");
  const client = new AnalysisClient(workerPath);
  const result = client.analyze(root, 1);
  client.dispose();
  await assert.rejects(result, /closed/);
  await assert.rejects(client.analyze(root, 1), /closed/);
});
