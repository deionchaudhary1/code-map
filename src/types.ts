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
//   GET  /api/symbols?file=<FileNode.id> -> SymbolGraph  (404 { error } if unknown file)
//   POST /api/explain  body: ExplainTarget -> ExplainResponse
//        (503 { error } when Ollama is unreachable; 404 { error } for unknown ids)
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
//   DELETE /api/sessions/<id>                     -> 204
//        (404 { error } when the session is unknown or has expired)
