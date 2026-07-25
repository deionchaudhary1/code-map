import type { ExplainTarget } from "../types.js";

/** Narrows an untrusted request body to an ExplainTarget, or undefined if it isn't one. */
export function parseExplainTarget(body: unknown): ExplainTarget | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;

  if (b.kind === "import" && typeof b.source === "string" && typeof b.target === "string") {
    return { kind: "import", source: b.source, target: b.target };
  }
  if (b.kind === "apiCall" && typeof b.id === "string") {
    return { kind: "apiCall", id: b.id };
  }
  if (b.kind === "node" && typeof b.id === "string") {
    return { kind: "node", id: b.id };
  }
  return undefined;
}

export const EXPLAIN_TARGET_SHAPE =
  'body must be {kind:"import",source,target} | {kind:"apiCall",id} | {kind:"node",id}';
