import assert from "node:assert/strict";
import test from "node:test";
import { buildFileGraph, buildSymbolGraph } from "../src/analyzer/index.js";
import { fixture } from "./helpers.js";

test("uses inherited TypeScript paths for imports, re-exports, require and symbol calls", (t) => {
  const root = fixture(t, {
    "tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@core/*": ["src/*"] } } }),
    "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json" }),
    "src/helper.ts": "export function helper() { return 1; }",
    "entry.ts": 'import { helper as renamed } from "@core/helper"; export { helper } from "@core/helper"; require("@core/helper"); export function run() { renamed(); }',
  });
  const graph = buildFileGraph(root);
  assert.equal(graph.edges.length, 3);
  assert.ok(graph.edges.every((e) => e.target === "src/helper.ts"));
  assert.ok(buildSymbolGraph(root, "entry.ts").edges.some((e) => e.target === "src/helper.ts#helper"));
});

test("uses the nearest nested configuration and inherited paths relative to their declaring config", (t) => {
  const root = fixture(t, {
    "config/base.json": JSON.stringify({ compilerOptions: { baseUrl: "..", paths: { "@core/*": ["shared/*"] } } }),
    "tsconfig.json": JSON.stringify({ extends: "./config/base.json" }),
    "main.ts": 'import "@core/value";',
    "shared/value.ts": "export const value = 1;",
    "packages/web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@core/*": ["local/*"] } } }),
    "packages/web/app.ts": 'import "@core/value";',
    "packages/web/local/value.ts": "export const value = 2;",
  });
  const graph = buildFileGraph(root);
  assert.ok(graph.edges.some((e) => e.source === "main.ts" && e.target === "shared/value.ts"));
  assert.ok(graph.edges.some((e) => e.source === "packages/web/app.ts" && e.target === "packages/web/local/value.ts"));
});

test("supports jsconfig baseUrl and .js specifiers for TypeScript files", (t) => {
  const root = fixture(t, {
    "jsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src" } }),
    "main.ts": 'import "helper"; require("./src/helper.js");',
    "src/helper.ts": "export function helper() {}",
  });
  assert.deepEqual(buildFileGraph(root).edges.map((e) => e.target), ["src/helper.ts", "src/helper.ts"]);
});

test("never pulls ignored files, external files, or dependencies into the graph through aliases", (t) => {
  const root = fixture(t, {
    ".gitignore": "private/\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@private/*": ["private/*"], "pkg": ["node_modules/pkg/index.js"] } } }),
    "main.ts": 'import "@private/hidden"; import "pkg"; import "node:fs";',
    "private/hidden.ts": "export {};",
    "node_modules/pkg/index.js": "export {};",
  });
  assert.deepEqual(buildFileGraph(root).nodes.map((n) => n.id), ["main.ts"]);
  assert.deepEqual(buildFileGraph(root).edges, []);
});

test("reports an invalid project configuration instead of silently losing alias edges", (t) => {
  const root = fixture(t, { "tsconfig.json": '{ "compilerOptions": ', "main.ts": "export {};" });
  assert.throws(() => buildFileGraph(root), /tsconfig\.json/);
  const nested = fixture(t, { "package/tsconfig.json": '{ "extends": "./missing.json" }', "package/main.ts": "export {};" });
  assert.throws(() => buildFileGraph(nested), /missing\.json/);
});
