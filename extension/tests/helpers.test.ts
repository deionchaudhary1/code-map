import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildFileGraph } from "../../src/analyzer/index.js";
import { affectsGraph, parseRequest, RefreshQueue, sourcePath } from "../src/helpers.js";

test("validates webview messages without accepting commands, arbitrary payloads or invalid locations", () => {
  for (const value of [null, [], "ready", { type: "execute", command: "anything" },
    { type: "open", location: { fileId: "a.ts", line: 0 } },
    { type: "open", location: { fileId: "a.ts", preserveFocus: "yes" } },
    { type: "symbols", fileId: "a.ts", requestId: -1 }]) assert.equal(parseRequest(value), null);
  assert.deepEqual(parseRequest({ type: "ready", unrelated: true }), { type: "ready" });
  assert.equal(parseRequest({ type: "open", location: { fileId: "a.ts", line: 2 } })?.type, "open");
  assert.equal(parseRequest({ type: "symbols", fileId: "a.ts", requestId: 1 })?.type, "symbols");
});

test("refresh filters include source/config changes and exclude generated files and siblings", () => {
  const root = path.resolve("workspace");
  for (const file of ["src/main.ts", "app.jsx", "tsconfig.json", "config/base.json", ".gitignore"]) assert.equal(affectsGraph(root, path.join(root, file)), true, file);
  for (const file of ["node_modules/pkg/a.ts", "dist/a.js", ".git/config.json", "build/a.js", "coverage/a.js", "types.d.ts", "photo.png"]) assert.equal(affectsGraph(root, path.join(root, file)), false, file);
  assert.equal(affectsGraph(root, `${root}-other/main.ts`), false);
});

test("navigation requires current graph membership and rejects symlink escapes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-map-navigation-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "code-map-outside-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;");
  fs.writeFileSync(path.join(outside, "private.ts"), "export const privateValue = 1;");
  const graph = buildFileGraph(root);
  assert.equal(sourcePath(root, graph, { fileId: "a.ts" }), path.join(root, "a.ts"));
  assert.throws(() => sourcePath(root, graph, { fileId: "../outside/private.ts" }), /current code map/);
  assert.throws(() => sourcePath(root, graph, { fileId: "missing.ts" }), /current code map/);
  if (process.platform !== "win32") {
    fs.unlinkSync(path.join(root, "a.ts"));
    fs.symlinkSync(path.join(outside, "private.ts"), path.join(root, "a.ts"));
    assert.throws(() => sourcePath(root, graph, { fileId: "a.ts" }), /workspace/);
  }
});

test("debounces bursts and performs one trailing refresh after in-flight changes", async () => {
  let count = 0;
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const queue = new RefreshQueue(async () => { count++; if (count === 1) await blocked; }, (error) => assert.fail(String(error)), 10);
  const first = queue.request(true);
  const second = queue.request();
  const third = queue.request();
  release();
  await Promise.all([first, second, third]);
  assert.equal(count, 2);
  queue.dispose();
});

test("recovers from a failed refresh and cancels scheduled work when disposed", async () => {
  let count = 0; const errors: unknown[] = [];
  const queue = new RefreshQueue(async () => { count++; if (count === 1) throw new Error("broken config"); }, (error) => errors.push(error), 10);
  await queue.request(true);
  await queue.request(true);
  assert.equal(errors.length, 1); assert.equal(count, 2);
  const pending = queue.request(); queue.dispose(); await pending; await delay(25);
  assert.equal(count, 2);
});
