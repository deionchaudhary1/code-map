import type { FileGraph, SymbolGraph } from "../../src/types.js";

export interface SourceLocation {
  fileId: string;
  line?: number;
  preserveFocus?: boolean;
}

export type WebviewRequest =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "chooseWorkspace" }
  | { type: "open"; location: SourceLocation }
  | { type: "symbols"; fileId: string; requestId: number };

export interface MapState {
  workspaceName: string;
  workspaceId: string;
  graph: FileGraph | null;
  revision: number;
  refreshing: boolean;
  dirty: boolean;
  error: string | null;
  activeFileId: string | null;
}

export type HostMessage =
  | { type: "state"; state: MapState }
  | { type: "symbols"; fileId: string; requestId: number; revision: number; graph: SymbolGraph | null; error: string | null }
  | { type: "navigationError"; message: string };

export type WorkerRequest =
  | { id: number; type: "analyze"; rootDir: string; maxFiles: number }
  | { id: number; type: "symbols"; rootDir: string; fileId: string };

export type WorkerResponse =
  | { id: number; type: "result"; graph: FileGraph | SymbolGraph }
  | { id: number; type: "error"; message: string };
