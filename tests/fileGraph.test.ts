import assert from "node:assert/strict";
import test from "node:test";
import { buildFileGraph, buildSymbolGraph, TooManyFilesError } from "../src/analyzer/index.js";
import { fixture } from "./helpers.js";

test("resolves relative imports, directory indexes, re-exports and CommonJS dependencies", (t) => {
  const root = fixture(t, {
    "main.ts": 'import { value } from "./lib"; export { value } from "./other"; require("./common");',
    "lib/index.ts": "export const value = 1;",
    "other.ts": "export const value = 2;",
    "common.cjs": "module.exports = 3;",
  });
  const graph = buildFileGraph(root);
  assert.deepEqual(graph.edges.map((e) => `${e.source}->${e.target}`).sort(), [
    "main.ts->common.cjs", "main.ts->lib/index.ts", "main.ts->other.ts",
  ]);
  assert.deepEqual(graph.nodes.filter((n) => n.isEntryPoint).map((n) => n.id), ["main.ts"]);
  assert.ok(graph.edges.every((edge) => edge.line === 1));
});

test("ignores build output, dependencies, declarations, and .gitignore matches", (t) => {
  const root = fixture(t, {
    ".gitignore": "secret/\n",
    "main.ts": 'import "./secret/hidden";',
    "secret/hidden.ts": "export {};",
    "node_modules/pkg/index.js": "export {};",
    "dist/main.js": "export {};",
    "types.d.ts": "declare const value: string;",
  });
  const graph = buildFileGraph(root);
  assert.deepEqual(graph.nodes.map((n) => n.id), ["main.ts"]);
  assert.deepEqual(graph.edges, []);
  assert.throws(() => buildFileGraph(root, { maxFiles: 0 }), TooManyFilesError);
});

test("reports cycles, self-imports, and an empty project", (t) => {
  const root = fixture(t, {
    "a.ts": 'import "./b";', "b.ts": 'import "./a";', "self.ts": 'import "./self";',
  });
  const graph = buildFileGraph(root);
  assert.deepEqual(graph.cycles.map((c) => c.sort()).sort(), [["a.ts", "b.ts"], ["self.ts"]]);
  assert.ok(graph.edges.every((e) => e.inCycle));
  assert.equal(buildFileGraph(fixture(t, {})).stats.fileCount, 0);
});

test("distinguishes inline type-only imports and re-exports from runtime dependencies", (t) => {
  const root = fixture(t, {
    "types.ts": "export interface Shape { x: number }; export const value = 1;",
    "inline.ts": 'import { type Shape } from "./types"; export { type Shape } from "./types";',
    "mixed.ts": 'import { type Shape, value } from "./types";',
    "side-effect.ts": 'import "./types";',
  });
  const graph = buildFileGraph(root);
  assert.equal(graph.edges.filter((e) => e.source === "inline.ts").length, 2);
  assert.ok(graph.edges.filter((e) => e.source === "inline.ts").every((e) => e.isTypeOnly));
  assert.ok(graph.edges.filter((e) => e.source !== "inline.ts").every((e) => !e.isTypeOnly));
});

test("symbol drill-down records local and imported calls", (t) => {
  const root = fixture(t, {
    "main.ts": 'import { helper } from "./lib"; import defaultFn from "./default"; function local() {} export function run() { local(); helper(); defaultFn(); }',
    "lib.ts": "export function helper() {}",
    "default.ts": "export default function defaultFn() {}",
  });
  const graph = buildSymbolGraph(root, "main.ts");
  assert.ok(graph.edges.some((e) => e.source === "main.ts#run" && e.target === "main.ts#local"));
  assert.ok(graph.edges.some((e) => e.source === "main.ts#run" && e.target === "lib.ts#helper"));
  assert.ok(graph.edges.some((e) => e.source === "main.ts#run" && e.target === "default.ts#defaultFn"));
});

test("connects matching HTTP calls to routes and keeps unmatched or dynamic calls explicit", (t) => {
  const root = fixture(t, {
    "client.ts": '\nfetch(`/api/projects/${id}?view=short`); fetch("/api/projects", { method: "POST" }); fetch(url);',
    "routes.ts": '\n\napp.get("/api/projects/:id", handler); app.get("/api/projects", handler);',
  });
  const graph = buildFileGraph(root);
  assert.equal(graph.apiCalls.length, 3);
  assert.equal(graph.routes.length, 2);
  assert.equal(graph.apiCalls[0].target, "routes.ts");
  assert.equal(graph.apiCalls[0].line, 2);
  assert.equal(graph.apiCalls[0].targetLine, 3);
  assert.equal(graph.apiCalls[1].targetLine, undefined);
  assert.equal(graph.apiCalls[1].target, "endpoint::POST /api/projects");
  assert.equal(graph.apiCalls[2].isDynamic, true);
  assert.equal(graph.endpoints.length, 2);
});
