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

export interface FileGraph {
  /** Absolute path of the analyzed project root */
  root: string;
  nodes: FileNode[];
  edges: ImportEdge[];
  /** Each cycle is a list of FileNode.ids forming a strongly connected component (length >= 2) */
  cycles: string[][];
  stats: {
    fileCount: number;
    edgeCount: number;
    cycleCount: number;
    skippedFiles: number; // files that failed to parse
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

// HTTP API contract served by the local server:
//   GET /api/graph                     -> FileGraph
//   GET /api/symbols?file=<FileNode.id> -> SymbolGraph  (404 { error } if unknown file)
