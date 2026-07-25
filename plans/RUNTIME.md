# Runtime Tracing

## Goal

Today code-map is purely static: it tells you what *could* happen (file A imports file B, this function calls that one). This feature adds the other half — actually **run** the analyzed program and overlay what *did* happen:

- Which files and functions actually executed, and how many times.
- The **shape** of the data flowing through them: parameter types, return types, object key sets, array element types — inferred from real values, not declarations.
- **Sample values** for those parameters and returns (truncated and redacted), so you can see that `parseConfig` returns `{ port: number, hosts: string[] }` and that on the observed run `port` was `4280`.
- Real call edges — including ones the static analyzer can't see (dynamic dispatch, callbacks, handlers invoked by a framework).

The payoff is the thing static graphs can't give you: dead code is visibly dead, hot paths are visibly hot, and untyped JS gets de-facto types recovered from observation.

**Is it possible?** Yes, and without a debugger UI or source rewriting. Node ships two mechanisms that do most of the work: `NODE_V8_COVERAGE` (free per-function execution counts for any Node process) and module loader hooks (`module.register`, Node ≥20.6) that let us wrap a module's exports as it loads. Neither requires the target project to change a line of code.

## Approach

### Two tiers, shipped in order

| Tier | What it gives | Mechanism | Overhead | Risk to target program |
|---|---|---|---|---|
| **1. Coverage** | Executed / not executed + hit counts per function | `NODE_V8_COVERAGE=<dir>` env var on the child process | ~2–5% | None — V8 built-in |
| **2. Values** | Arg/return shapes + sample values + observed call edges | Loader hook wraps exported functions & class methods | 10–30% on hot paths | Low, but non-zero (wrapped functions) |

Tier 1 alone is worth shipping on its own: it's a single env var, it works with `npm test`, `node server.js`, or any Node command, and it answers "what code is actually live?" Tier 2 is opt-in behind `--trace-values`.

### How the program gets run

```
code-map . --run "npm test"
code-map . --run "node src/index.js" --trace-values
```

The CLI spawns the command as a child process from the project root with:

- `NODE_V8_COVERAGE=<tmp>/coverage` (tier 1)
- `NODE_OPTIONS="--import <code-map>/dist/trace/register.js"` appended, not replaced (tier 2)
- `CODE_MAP_TRACE_OUT=<tmp>/trace.ndjson`, `CODE_MAP_TRACE_ROOT=<projectRoot>`

Child stdout/stderr are streamed through to the user's terminal so a test run still looks like a test run. On exit, the CLI reads the coverage JSON and the NDJSON trace, folds them into the existing `FileGraph`, and serves the result. Non-zero exit codes are surfaced as a warning, not a failure — a crashing run is still a trace worth looking at.

### Why export-wrapping instead of source instrumentation

The obvious approach for tier 2 is rewriting source with ts-morph to wrap every function body in enter/exit hooks. Rejected:

| | Export wrapping (chosen) | AST instrumentation |
|---|---|---|
| Captures | Exported functions, exported class methods, default exports | Every function, including inner/local ones |
| TypeScript / JSX | Works for free — we wrap the *already-transpiled* module namespace, so whatever runs the TS (tsx, ts-node, a build step) does its job first and we sit downstream | Must re-implement or chain the project's own transform |
| Bundlers / loaders in the chain | Composes | Fights |
| Can break the target | Only via identity changes (see caveats) | Yes — any codegen bug is a crash in the user's program |
| Implementation size | ~200 lines | ~600+ lines and a long tail of edge cases |

The granularity loss is largely theoretical for this tool: code-map's UI already displays files by their **exports**, and `SymbolNode` marks `isExported`. Exported functions are exactly the layer the graph shows. Internal helper calls that never cross a module boundary won't get value capture — tier 1 coverage still marks them executed, which is enough to render them correctly in the graph.

Known caveats to document rather than solve in v1: wrapping changes function identity, so code doing `fn.name`, `instanceof` on a wrapped constructor, or referential equality on an exported function may behave differently. Mitigations: preserve `name`/`length` via `Object.defineProperty`, never wrap classes themselves (only their prototype methods), and provide `--trace-exclude <glob>` to skip files that misbehave.

### Shape inference

A `describeValue(v, depth)` function produces a compact `ValueShape`, serialized **synchronously at capture time** (never hold the live reference — the callee may mutate it):

- Primitives → `{ kind: "string" | "number" | "boolean" | "null" | "undefined" | "bigint" | "symbol" }`
- Arrays → `{ kind: "array", length, element: <union of first 20 elements' shapes> }`
- Plain objects → `{ kind: "object", keys: [{ name, shape }] }`, first 30 keys
- Class instances → `{ kind: "instance", className, keys: [...] }`
- Functions → `{ kind: "function", name, arity }`
- Promise → `{ kind: "promise", resolved?: <shape> }` (awaited for the return value of async functions)
- Map/Set/Date/RegExp/Buffer/typed arrays → dedicated kinds with size/summary
- Depth cap 3, then `{ kind: "truncated" }`; cycles → `{ kind: "circular" }`

Every shape carries an optional `sample: string` — `JSON`-ish rendering truncated to 80 chars.

**Redaction is mandatory and on by default.** Any key matching `/pass(word)?|secret|token|api[-_]?key|auth|credential|cookie|session/i` has its sample replaced with `"<redacted>"` (the shape is kept). Strings longer than 200 chars are truncated. `--trace-no-redact` exists for the user's own toy projects but prints a warning.

**Merging across calls:** each function keeps up to 5 recorded samples (first 3 calls, then reservoir-sampled) plus a merged union shape across *all* calls, so a parameter that's sometimes `string` and sometimes `null` shows as `string | null`. Hit counts and duration percentiles are accumulated for every call, not just sampled ones.

### Budgets

Tracing must never hang or balloon the traced program: max 50 MB trace file, max 200 recorded samples per function, max 2 000 000 total events, then the recorder flips to counting-only mode and sets a `truncated: true` flag the UI surfaces. Writes are append-only NDJSON via a buffered stream.

### Mapping runtime data back to the graph

Both tiers produce file paths (absolute) + function names/positions. Normalize to `FileNode.id` (repo-relative, forward slashes) via the existing path logic in `src/analyzer/walk.ts`, and to `SymbolNode.id` (`"<file id>#<name>"`, methods as `"<file id>#<Class>.<method>"`) — the same id scheme `src/analyzer/symbolGraph.ts` already emits, so the side panel can join on it directly. V8 coverage gives byte offsets; convert to lines and match against `SymbolNode.startLine`, falling back to name matching when offsets don't line up (minified or transformed output).

Source maps are the main mapping hazard: if the target runs transpiled output, coverage points at `dist/`. v1 handles this by consuming an adjacent `.map` file when present and otherwise reporting unmapped files in a "couldn't map N files" notice rather than silently dropping them.

### Relationship to existing plans

Complements, doesn't replace, `plans/AI_INSIGHTS.md` — that plan's API-call detection is deliberately static. Runtime traces can later *confirm* which of those detected calls actually fire (and resolve `<dynamic>` URLs to real ones), but that's listed as out of scope below. No section of an existing plan is superseded; add a one-line pointer in `AI_INSIGHTS.md` noting the runtime layer exists.

Runtime shapes are also strong context for the existing `POST /api/explain` prompt — "this function is called 412 times and returns `{ id: string, roles: string[] }`" is much better grounding than a code excerpt alone. Wiring that in is step 8.

## Changes Required

**New dependencies:** none required. Node ≥20.6 for `module.register` — bump `engines.node` in `package.json` from `>=18` to `>=20.6`. Optional later: `source-map` for transpiled-output mapping (defer until step 6 proves it's needed).

**Schema** (`src/types.ts`, mirrored verbatim to `web/src/types.ts` — they must stay identical):

```ts
export type ValueShape =
  | { kind: "string" | "number" | "boolean" | "null" | "undefined" | "bigint" | "symbol"; sample?: string }
  | { kind: "array"; length: number; element?: ValueShape; sample?: string }
  | { kind: "object"; keys: { name: string; shape: ValueShape }[]; sample?: string }
  | { kind: "instance"; className: string; keys: { name: string; shape: ValueShape }[]; sample?: string }
  | { kind: "function"; name: string; arity: number }
  | { kind: "promise"; resolved?: ValueShape }
  | { kind: "map" | "set"; size: number; sample?: string }
  | { kind: "union"; options: ValueShape[] }
  | { kind: "truncated" | "circular" | "redacted" };

export interface RuntimeParam { name: string; shape: ValueShape; }

export interface RuntimeSample {
  args: ValueShape[];
  returns?: ValueShape;
  threw?: { name: string; message: string };
  durationMs: number;
}

export interface RuntimeSymbol {
  /** SymbolNode.id — "<file id>#<name>" */
  id: string;
  file: string;
  calls: number;
  totalMs: number;
  /** Merged union shapes across every observed call */
  params: RuntimeParam[];
  returns?: ValueShape;
  throwCount: number;
  /** Up to 5 concrete calls */
  samples: RuntimeSample[];
}

/** Caller → callee edge observed at runtime (from the recorder's shadow stack). */
export interface RuntimeCallEdge {
  source: string; // SymbolNode.id, or "<entry>" for top-level
  target: string; // SymbolNode.id
  count: number;
  /** True when no static CallEdge covers this pair — a dynamic-dispatch discovery */
  staticallyUnseen: boolean;
}

export interface RuntimeTrace {
  command: string;
  exitCode: number | null;
  startedAt: string;
  durationMs: number;
  tier: "coverage" | "values";
  /** FileNode.ids that executed at least once */
  executedFiles: string[];
  /** Per-file hit counts, keyed by FileNode.id */
  fileHits: Record<string, number>;
  symbols: RuntimeSymbol[];
  callEdges: RuntimeCallEdge[];
  /** Budget exceeded — data is partial */
  truncated: boolean;
  /** Coverage entries that couldn't be mapped to a FileNode */
  unmappedFiles: string[];
}
```

`FileGraph` gains `runtime?: RuntimeTrace` (optional — the tool must work exactly as it does today with no run).

**New: `src/trace/`**
- `register.js` — the `--import` entry. Calls `module.register("./hooks.js")`, patches CJS `Module._load` for require-based projects, installs the process-exit flush. Plain JS, no TS build dependency, since it's injected into a foreign process.
- `hooks.js` — loader hook; for each resolved module under the project root (and not excluded), wraps the namespace's exported functions and exported classes' prototype methods.
- `wrap.js` — `wrapFunction(fn, symbolId)`: shadow-stack push/pop, timing, `describeValue` on args and return, async-aware (`.then` on returned promises), try/catch to record throws and rethrow untouched.
- `describe.js` — `describeValue` + redaction + merge/union logic.
- `record.js` — buffered NDJSON writer with the budget counters.
- `coverage.ts` — reads the `NODE_V8_COVERAGE` output dir, filters to project files, maps ranges → `SymbolNode.id`, emits `executedFiles` / `fileHits` / per-symbol `calls`.
- `runner.ts` — spawns the child with the right env, streams output, waits for exit, then calls `coverage.ts` + parses the NDJSON and merges both into one `RuntimeTrace`.

**CLI** (`src/cli.ts`): new options `--run <command>`, `--trace-values`, `--trace-exclude <glob...>`, `--trace-timeout <sec>` (default 300), `--trace-no-redact`. When `--run` is present, execute the run after `buildFileGraph` and before `startServer`, printing a summary line in the same style as the existing stats line (`Traced 1 240 calls across 87 functions; 43 of 130 files never executed`).

**Server** (`src/server.ts`): `GET /api/runtime` → `RuntimeTrace | null`; `GET /api/runtime/symbol?id=<SymbolNode.id>` → the single `RuntimeSymbol` with full samples (keeps `/api/graph` small); `POST /api/run` (stretch) to re-run the traced command without restarting the CLI. Add runtime facts to the context bundle in `src/llm/explain.ts`.

**Frontend** (`web/src/`):
- `TopBar.tsx` — a "Runtime" toggle (disabled with a tooltip when no trace exists) plus a "hide unexecuted" filter.
- `GraphCanvas.tsx` — in runtime mode, unexecuted nodes render dimmed/hollow, executed nodes scale with hit count, and `staticallyUnseen` call edges draw in a new accent color from `palette.ts`.
- `SidePanel.tsx` — a "Runtime" section on the file view (calls, time, executed symbols vs. total) and, in the existing symbol drill-down, a per-symbol signature block rendering the inferred shape as a pseudo-TypeScript signature with expandable sample values.
- `api.ts` — `fetchRuntime()`, `fetchRuntimeSymbol(id)`.
- `types.ts` — copy of the new schema.
- `StatsOverlay.tsx` — coverage percentage when a trace is loaded.

## Cost & Services

Free, permanently. Everything is local: V8's built-in coverage, Node's own loader hooks, a child process, and a temp file. No new npm dependency, no hosted service, no API key, nothing leaves the machine — same posture as the Ollama choice in `AI_INSIGHTS.md`. The only resource cost is disk for the trace file, capped at 50 MB and written to the OS temp dir so it's cleaned up automatically.

## Steps

1. **Schema + plumbing.** Add the runtime types to `src/types.ts`, mirror to `web/src/types.ts`, add `runtime?` to `FileGraph`, add `GET /api/runtime` returning `null`. Nothing behaves differently yet; `npm run typecheck` passes.
2. **Tier 1 runner.** `src/trace/runner.ts` spawning a child with `NODE_V8_COVERAGE`, plus `--run` in the CLI. Verify by tracing code-map's own CLI against a small fixture project and dumping the raw coverage JSON.
3. **Coverage → graph mapping.** `src/trace/coverage.ts`: filter to project files, offsets → lines → `SymbolNode.id`, produce a coverage-tier `RuntimeTrace`. Sanity check: a function you know didn't run must be absent from `executedFiles`/`fileHits`.
4. **Runtime mode in the UI.** Toggle in `TopBar.tsx`, dimming + hit-count sizing in `GraphCanvas.tsx`, coverage % in `StatsOverlay.tsx`. **This is the first user-visible payoff — a shippable stopping point.**
5. **Tier 2 recorder.** `register.js` / `hooks.js` / `wrap.js` / `describe.js` / `record.js` and the `--trace-values` flag, with budgets and redaction from the start. Test against an ESM fixture, a CJS fixture, and one real dependency-heavy project (tracing `npm test` on a small OSS repo) to shake out identity-related breakage.
6. **Trace ingestion + merge.** Parse the NDJSON, merge union shapes, build `RuntimeCallEdge`s, mark `staticallyUnseen` by diffing against `buildSymbolGraph` output, expose `GET /api/runtime/symbol`. Handle source-mapped `dist/` output or report it cleanly as unmapped.
7. **Shape display.** `SidePanel.tsx` renders the inferred pseudo-TypeScript signature and expandable samples; `staticallyUnseen` edges get their own color and legend entry.
8. **LLM grounding.** Feed runtime facts into `src/llm/explain.ts`'s context bundle; add a "runtime" flavor to the prompt ("this function ran 412 times and always returned …").
9. **Docs.** README section covering `--run`, the two tiers, the caveats (Node-only, exported functions only, identity changes), and redaction. Add the pointer line to `plans/AI_INSIGHTS.md`.

## Out of Scope

- **Browser/client-side execution.** Only Node processes are traced. Frontend code in the analyzed repo shows as unexecuted unless it also runs under Node (SSR, tests). A CDP-based browser tracer is a separate plan.
- **Non-Node runtimes** — Deno, Bun, Python, anything else.
- **AST-level instrumentation** of non-exported inner functions. Tier 1 coverage still marks them executed; their values aren't captured.
- **Live/streaming traces.** The run completes, then the trace is loaded. No attaching to an already-running process, no watch mode.
- **Time-travel debugging** — no per-call timeline, no stepping, no ordered event log in the UI. The trace is aggregated, not replayable.
- **Resolving static API-call edges with runtime data** (confirming which `fetch` calls fire, resolving `<dynamic>` URLs). A natural follow-up to `AI_INSIGHTS.md`, deliberately deferred.
- **Persisting traces across runs** or diffing two traces ("what changed between main and my branch"). Compelling, but needs a storage format decision.
- **Coverage-report parity.** This is not a replacement for c8/istanbul; no line/branch coverage percentages, no lcov export.
