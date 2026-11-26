import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildFileGraph } from "../src/analyzer/index.js";
import { mapCoverage } from "../src/trace/coverage.js";
import { fixture } from "./helpers.js";

test("merges process coverage and retains zero-call symbols without counting dependencies", (t) => {
  const source = "export function used() { return 1; }\nexport function unused() { return 2; }\n";
  const root = fixture(t, { "source space.mjs": source, "never-loaded.mjs": "export function dead() {}" });
  const dir = path.join(root, "coverage");
  fs.mkdirSync(dir);
  for (const [name, count] of [["one", 2], ["two", 3]] as const) {
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ result: [
      { url: pathToFileURL(path.join(root, "source space.mjs")).href, functions: [
        { functionName: "", ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
        { functionName: "used", ranges: [{ startOffset: 7, endOffset: 35, count }] },
        { functionName: "unused", ranges: [{ startOffset: 43, endOffset: source.length, count: 0 }] },
      ] },
      { url: pathToFileURL(path.join(root, "node_modules/noise.js")).href, functions: [] },
      { url: "node:internal/process", functions: [] },
    ] }));
  }
  fs.writeFileSync(path.join(dir, "truncated.json"), "{");
  const mapped = mapCoverage(dir, buildFileGraph(root), root);
  assert.deepEqual(mapped.executedFiles, ["source space.mjs"]);
  assert.equal(mapped.symbols.find((s) => s.id.endsWith("#used"))?.calls, 5);
  assert.equal(mapped.symbols.find((s) => s.id.endsWith("#unused"))?.calls, 0);
  assert.equal(mapped.fileHits["source space.mjs"], 7);
  assert.deepEqual(mapped.unmappedFiles, []);
  assert.equal(mapped.symbols.some((s) => s.file === "never-loaded.mjs"), false);
});

test("reports executed build output that does not match the analyzed sources", (t) => {
  const root = fixture(t, { "src/main.ts": "export {};" });
  const dir = path.join(root, "coverage"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ result: [{
    url: pathToFileURL(path.join(root, "dist/main.js")).href,
    functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] }],
  }] }));
  const mapped = mapCoverage(dir, buildFileGraph(root), root);
  assert.deepEqual(mapped.executedFiles, []);
  assert.deepEqual(mapped.unmappedFiles, ["dist/main.js"]);
  assert.deepEqual(mapCoverage(path.join(root, "missing"), buildFileGraph(root), root).symbols, []);
});
