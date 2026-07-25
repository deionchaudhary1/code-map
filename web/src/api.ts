import type {
  AppConfig,
  ExplainContextResponse,
  ExplainResponse,
  ExplainTarget,
  FileGraph,
  SessionResponse,
  SymbolGraph,
} from "./types";
import mockGraph from "../mock/graph.json";

/**
 * Where the graph routes live. Local mode serves them at /api; hosted mode
 * scopes them per session. Route shapes below the prefix are identical, so
 * callers pass a prefix instead of branching on mode.
 */
export type ApiPrefix = string;

export const LOCAL_PREFIX: ApiPrefix = "/api";

export function sessionPrefix(sessionId: string): ApiPrefix {
  return `/api/sessions/${encodeURIComponent(sessionId)}`;
}

/** Pulls the {error} message servers return, falling back to the status line. */
async function errorFrom(res: Response, what: string): Promise<Error> {
  const body = await res.json().catch(() => null);
  const message = body && typeof body.error === "string" ? body.error : null;
  return new Error(message ?? `${what} failed: ${res.status} ${res.statusText}`);
}

export async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw await errorFrom(res, "GET /api/config");
  return (await res.json()) as AppConfig;
}

export async function fetchFileGraph(prefix: ApiPrefix): Promise<FileGraph> {
  const res = await fetch(`${prefix}/graph`);
  if (!res.ok) throw await errorFrom(res, "GET graph");
  return (await res.json()) as FileGraph;
}

/** Local-mode-only fallback so the UI is testable without the CLI running. */
export async function fetchFileGraphOrMock(prefix: ApiPrefix): Promise<FileGraph> {
  try {
    return await fetchFileGraph(prefix);
  } catch (err) {
    console.warn("Falling back to mock graph data:", err);
    return mockGraph as FileGraph;
  }
}

export async function fetchSymbolGraph(
  prefix: ApiPrefix,
  fileId: string,
): Promise<SymbolGraph> {
  const res = await fetch(`${prefix}/symbols?file=${encodeURIComponent(fileId)}`);
  if (!res.ok) throw await errorFrom(res, "GET symbols");
  return (await res.json()) as SymbolGraph;
}

/** Local mode: the server owns the Ollama call and returns finished text. */
export async function fetchExplanation(
  prefix: ApiPrefix,
  target: ExplainTarget,
): Promise<ExplainResponse> {
  const res = await fetch(`${prefix}/explain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target),
  });
  if (!res.ok) throw await errorFrom(res, "POST explain");
  return (await res.json()) as ExplainResponse;
}

/** Hosted mode: the server assembles the prompt, the browser runs the model. */
export async function fetchExplainContext(
  prefix: ApiPrefix,
  target: ExplainTarget,
): Promise<ExplainContextResponse> {
  const res = await fetch(`${prefix}/explain-context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target),
  });
  if (!res.ok) throw await errorFrom(res, "POST explain-context");
  return (await res.json()) as ExplainContextResponse;
}

export async function uploadZip(file: File): Promise<SessionResponse> {
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: file,
  });
  if (!res.ok) throw await errorFrom(res, "upload");
  return (await res.json()) as SessionResponse;
}

export async function cloneRepo(url: string): Promise<SessionResponse> {
  const res = await fetch("/api/clone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw await errorFrom(res, "clone");
  return (await res.json()) as SessionResponse;
}

export function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}
