import type { ExplainResponse, ExplainTarget, FileGraph, SymbolGraph } from "./types";
import mockGraph from "../mock/graph.json";

export async function fetchFileGraph(): Promise<FileGraph> {
  try {
    const res = await fetch("/api/graph");
    if (!res.ok) throw new Error(`GET /api/graph failed: ${res.status}`);
    return (await res.json()) as FileGraph;
  } catch (err) {
    // Dev-only fallback so the UI is testable without the server running.
    console.warn("Falling back to mock graph data:", err);
    return mockGraph as FileGraph;
  }
}

export async function fetchSymbolGraph(fileId: string): Promise<SymbolGraph> {
  const res = await fetch(`/api/symbols?file=${encodeURIComponent(fileId)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `GET /api/symbols failed: ${res.status}`);
  }
  return (await res.json()) as SymbolGraph;
}

export async function fetchExplanation(target: ExplainTarget): Promise<ExplainResponse> {
  const res = await fetch("/api/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `POST /api/explain failed: ${res.status}`);
  }
  return (await res.json()) as ExplainResponse;
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
