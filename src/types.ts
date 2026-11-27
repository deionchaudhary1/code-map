// Shared graph schema. web/src/types.ts must stay an exact copy of this file
// (the Vite app can't import outside its root when published).

export interface FileNode {
  /** Repo-relative path with forward slashes, e.g. "src/utils/parse.ts" */
  id: string;
  extension: string; // ".ts" | ".tsx" | ".js" | ".jsx" | ".mjs" | ".cjs"
  sizeBytes: number;
  /** Names of exported symbols; default export appears as "default" */
  exports: string[];
  /** True if no other file in the graph imports this file */
  isEntryPoint: boolean;
  /** Top-level folder ("src", "web", or "." for root files) — used for coloring */
  folder: string;
}

export interface ImportEdge {
  /** FileNode.id of the importing file */
  source: string;
  /** FileNode.id of the imported file */
  target: string;
  /** 1-indexed line of the import/export/require declaration, when known. */
  line?: number;
  importedSymbols: string[];
  /** TS `import type` only */
  isTypeOnly: boolean;
  /** True if this edge participates in a circular-import cycle */
  inCycle: boolean;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "unknown";

/** An outbound HTTP call (fetch/axios) found in a source file. */
export interface ApiCallEdge {
  /** Stable id: "<source>::<method>::<url>" — used for selection and /api/explain */
  id: string;
  /** FileNode.id of the file making the call */
  source: string;
  method: HttpMethod;
  /** Literal URL, with template placeholders normalized to ":param"; "<dynamic>" when unresolvable */
  url: string;
  /** True when the URL could not be read as a literal */
  isDynamic: boolean;
  client: "fetch" | "axios" | "other";
  /** 1-indexed line of the call site in `source` */
  line: number;
  /**
   * FileNode.id of the file registering the matching server route, when one was
   * found; otherwise the id of the synthetic EndpointNode this call points at.
   */
  target: string;
  /** 1-indexed line of the matching route registration, when resolved. */
  targetLine?: number;
}

/** A synthetic node for an HTTP endpoint that no in-repo route handler matched. */
export interface EndpointNode {
  /** "endpoint::<METHOD> <url>" — namespaced so it can never collide with a FileNode.id */
  id: string;
  method: HttpMethod;
  url: string;
}

/** A server route registration (Express-style) found in the codebase. */
export interface RouteDefinition {
  /** FileNode.id of the file registering the route */
  file: string;
  method: HttpMethod;
  /** Registered path, e.g. "/api/users/:id" */
  path: string;
  line: number;
}

/**
 * Shape of a value observed at runtime. Populated by tier 2 (`--trace-values`)
 * only; the coverage tier never emits these. Defined now so adding tier 2 is
 * not a schema migration.
 */
export type ValueShape =
  | {
      kind: "string" | "number" | "boolean" | "null" | "undefined" | "bigint" | "symbol";
      sample?: string;
    }
  | { kind: "array"; length: number; element?: ValueShape; sample?: string }
  | { kind: "object"; keys: { name: string; shape: ValueShape }[]; sample?: string }
  | {
      kind: "instance";
      className: string;
      keys: { name: string; shape: ValueShape }[];
      sample?: string;
    }
  | { kind: "function"; name: string; arity: number }
  | { kind: "promise"; resolved?: ValueShape }
  | { kind: "map" | "set"; size: number; sample?: string }
  | { kind: "union"; options: ValueShape[] }
  | { kind: "truncated" | "circular" | "redacted" };

export interface RuntimeParam {
  name: string;
  shape: ValueShape;
}

export interface RuntimeSample {
  args: ValueShape[];
  returns?: ValueShape;
  threw?: { name: string; message: string };
  durationMs: number;
}

export interface RuntimeSymbol {
  /** SymbolNode.id — "<file id>#<name>" */
  id: string;
  /** FileNode.id the symbol belongs to */
  file: string;
  /** Times this function was entered. 0 means present but never executed. */
  calls: number;
  /** Tier 2 only; 0 under coverage. */
  totalMs: number;
  /** Merged union shapes across every observed call (tier 2). */
  params: RuntimeParam[];
  returns?: ValueShape;
  throwCount: number;
  /** Up to 5 concrete calls (tier 2). */
  samples: RuntimeSample[];
}

/** Caller → callee edge observed at runtime. Tier 2 only. */
export interface RuntimeCallEdge {
  /** SymbolNode.id, or "<entry>" for top-level */
  source: string;
  target: string;
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
  /** Per-file total hit counts, keyed by FileNode.id */
  fileHits: Record<string, number>;
  symbols: RuntimeSymbol[];
  callEdges: RuntimeCallEdge[];
  /** Budget exceeded — data is partial */
  truncated: boolean;
  /** Coverage entries under the project root that matched no FileNode */
  unmappedFiles: string[];
  /**
   * Set when the run produced no usable coverage. V8 flushes only on a clean
   * exit, so a timeout or hard kill yields nothing — which is indistinguishable
   * from "the program ran but executed no code" unless it is said outright.
   */
  warning?: string;
}

export interface FileGraph {
  /** Absolute path of the analyzed project root */
  root: string;
  nodes: FileNode[];
  edges: ImportEdge[];
  /** Outbound HTTP calls detected in the codebase */
  apiCalls: ApiCallEdge[];
  /** Synthetic nodes for endpoints with no matching in-repo route */
  endpoints: EndpointNode[];
  /** Server routes registered in the codebase (used to resolve apiCalls) */
  routes: RouteDefinition[];
  /** Each cycle is a list of FileNode.ids forming a strongly connected component (length >= 2) */
  cycles: string[][];
  stats: {
    fileCount: number;
    edgeCount: number;
    cycleCount: number;
    skippedFiles: number; // files that failed to parse
    apiCallCount: number;
    routeCount: number;
  };
  /**
   * Present only when the CLI was given `--run`. Absent for every other path,
   * including all of hosted mode, which never executes analyzed code.
   */
  runtime?: RuntimeTrace;
}

/**
 * A synthetic node for an AI-derived topic — a group of files that do the same
 * kind of work. The "topic::" prefix namespaces the id so it can never collide
 * with a FileNode.id or an EndpointNode.id.
 */
export interface TopicNode {
  /** "topic::<slug>" */
  id: string;
  name: string;
  /** 1-2 sentences describing what this part of the codebase does */
  summary: string;
  /** FileNode.ids belonging to this topic */
  members: string[];
}

/**
 * The result of one clustering pass. Deliberately not part of FileGraph: it is
 * generated on demand from a model that may not be running, while FileGraph is
 * a pure static-analysis artifact that must always be available.
 */
export interface TopicSet {
  topics: TopicNode[];
  model: string;
  /** ISO timestamp of when the model produced this */
  generatedAt: string;
  /** FileNode.ids the model did not place — rendered neutral, with no hub */
  unassigned: string[];
}

/**
 * Hosted-mode counterpart to ExplainContextResponse: the server assembles the
 * clustering prompt, the browser runs the model against its own Ollama.
 */
export interface TopicContextResponse {
  prompt: string;
  system: string;
  suggestedModel: string;
  /** Output tokens the response needs; assignment arrays truncate below this. */
  numPredict: number;
}

export type SymbolKind = "function" | "class" | "method" | "const-arrow-fn";

export interface SymbolNode {
  /** "<file id>#<symbolName>" — methods use "<file id>#<Class>.<method>" */
  id: string;
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  isExported: boolean;
}

export interface CallEdge {
  /** SymbolNode.id of the caller */
  source: string;
  /**
   * SymbolNode.id of the callee for local calls; for calls into imported
   * modules, "<resolved file id or module specifier>#<symbolName>".
   */
  target: string;
  /** True when the callee is an imported symbol rather than a local one */
  isExternalCall: boolean;
}

export interface SymbolGraph {
  /** FileNode.id this symbol graph belongs to */
  file: string;
  nodes: SymbolNode[];
  edges: CallEdge[];
}

/** What the user asked to have explained. */
export type ExplainTarget =
  | { kind: "import"; source: string; target: string }
  | { kind: "apiCall"; id: string }
  | { kind: "node"; id: string };

export interface ExplainResponse {
  explanation: string;
  model: string;
  /** True when served from the server-side cache rather than a fresh generation */
  cached: boolean;
}

/**
 * Everything needed to generate an explanation, without generating it. Hosted
 * mode returns this instead of an ExplainResponse: the server assembles the
 * prompt (it has the source files) but the browser makes the Ollama call, since
 * only the browser can reach the user's own machine.
 */
export interface ExplainContextResponse {
  prompt: string;
  system: string;
  /** Stable per-target key, e.g. "import::a.ts::b.ts" — the client caches on it */
  cacheKey: string;
  /** Model the server suggests; the client may override it */
  suggestedModel: string;
}

/**
 * Which server the frontend is talking to. Fetched at startup so a single
 * `web/dist` build works under both the local CLI server and the hosted server.
 */
export type AppConfig =
  | { mode: "local"; aiEnabled: boolean; ollamaModel: string }
  | { mode: "hosted"; ollamaModel: string; maxUploadBytes: number };

/** Returned by the hosted server's ingestion routes. */
export interface SessionResponse {
  sessionId: string;
  graph: FileGraph;
}

// HTTP API contract served by the local server:
//   GET  /api/config                    -> AppConfig  ({ mode: "local", ... })
//   GET  /api/graph                     -> FileGraph
//   GET  /api/runtime                   -> RuntimeTrace | null  (local only —
//        hosted mode never runs analyzed code, so it does not serve this)
//   GET  /api/symbols?file=<FileNode.id> -> SymbolGraph  (404 { error } if unknown file)
//   POST /api/explain  body: ExplainTarget -> ExplainResponse
//        (503 { error } when Ollama is unreachable; 404 { error } for unknown ids)
//   POST /api/topics                    -> TopicSet
//        (503 { error } when AI is disabled or Ollama is unreachable;
//         502 { error } when the model's reply could not be parsed)
//
// Additional contract served by the hosted server (src/hostedServer.ts). Session
// routes mirror the local ones under a per-session prefix, so the frontend only
// has to swap the prefix rather than branch per call:
//   GET    /api/config                            -> AppConfig ({ mode: "hosted", ... })
//   POST   /api/upload   body: raw zip bytes      -> SessionResponse
//   POST   /api/clone    body: { url }            -> SessionResponse
//   GET    /api/sessions/<id>/graph               -> FileGraph (root blanked)
//   GET    /api/sessions/<id>/symbols?file=<id>   -> SymbolGraph
//   POST   /api/sessions/<id>/explain-context     -> ExplainContextResponse
//          body: ExplainTarget
//   POST   /api/sessions/<id>/topics-context      -> TopicContextResponse
//   POST   /api/sessions/<id>/topics-parse        -> TopicSet
//          body: { raw: string, model: string }   (502 { error } if unparseable)
//   DELETE /api/sessions/<id>                     -> 204
//        (404 { error } when the session is unknown or has expired)
