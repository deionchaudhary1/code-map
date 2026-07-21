import fs from "node:fs";
import path from "node:path";
import type { ExplainTarget, FileGraph } from "../types.js";
import { generate } from "./ollama.js";

const SYSTEM_PROMPT = [
  "You explain how parts of a software codebase connect to each other.",
  "You are given factual details extracted by a static analyzer, plus short code excerpts.",
  "Explain the connection in 2-4 sentences of plain English for a developer new to this codebase:",
  "what the relationship is, and why it plausibly exists given what the files do.",
  "Reference the actual file names and symbols you were given.",
  "Do not invent files, functions, or behavior that is not in the provided context.",
  "If the context is too thin to say anything specific, say so briefly instead of speculating.",
].join(" ");

/** Caps how much of a file is sent — enough to convey purpose, small enough to stay fast on a local model. */
const HEAD_LINES = 40;
const CONTEXT_LINES = 6;

function readFileLines(root: string, fileId: string): string[] | undefined {
  try {
    return fs.readFileSync(path.join(root, fileId), "utf8").split("\n");
  } catch {
    return undefined;
  }
}

function head(root: string, fileId: string, limit = HEAD_LINES): string {
  const lines = readFileLines(root, fileId);
  if (!lines) return "(file could not be read)";
  const slice = lines.slice(0, limit);
  if (lines.length > limit) slice.push(`… (${lines.length - limit} more lines)`);
  return slice.join("\n");
}

/** Lines around a specific 1-indexed line number. */
function around(root: string, fileId: string, line: number): string {
  const lines = readFileLines(root, fileId);
  if (!lines) return "(file could not be read)";
  const start = Math.max(0, line - 1 - CONTEXT_LINES);
  const end = Math.min(lines.length, line + CONTEXT_LINES);
  return lines
    .slice(start, end)
    .map((text, i) => `${start + i + 1}${start + i + 1 === line ? " >" : "  "} ${text}`)
    .join("\n");
}

/** Builds the prompt for a target, or returns an error message if the target isn't in the graph. */
export function buildPrompt(
  graph: FileGraph,
  target: ExplainTarget,
): { prompt: string; cacheKey: string } | { error: string } {
  if (target.kind === "import") {
    const edge = graph.edges.find((e) => e.source === target.source && e.target === target.target);
    if (!edge) return { error: `no import edge from ${target.source} to ${target.target}` };

    const symbols = edge.importedSymbols.length ? edge.importedSymbols.join(", ") : "(none recorded)";
    const prompt = [
      `Connection type: ES module import${edge.isTypeOnly ? " (TypeScript type-only)" : ""}.`,
      `The file "${edge.source}" imports [${symbols}] from "${edge.target}".`,
      edge.inCycle ? "These two files are part of a circular import cycle." : "",
      "",
      `--- Start of ${edge.source} ---`,
      head(graph.root, edge.source),
      `--- End of ${edge.source} ---`,
      "",
      `--- Start of ${edge.target} ---`,
      head(graph.root, edge.target),
      `--- End of ${edge.target} ---`,
      "",
      "Explain why this import relationship exists and what role each file plays.",
    ].join("\n");

    return { prompt, cacheKey: `import::${edge.source}::${edge.target}` };
  }

  if (target.kind === "apiCall") {
    const call = graph.apiCalls.find((c) => c.id === target.id);
    if (!call) return { error: `no API call with id ${target.id}` };

    const isEndpointTarget = call.target.startsWith("endpoint::");
    const route = graph.routes.find((r) => !isEndpointTarget && r.file === call.target);

    const prompt = [
      `Connection type: outbound HTTP request (via ${call.client}).`,
      `The file "${call.source}" issues a ${call.method} request to "${call.url}" at line ${call.line}.`,
      isEndpointTarget
        ? "No route handler for this URL was found in this codebase, so it likely targets an external service or a server that lives outside this repository."
        : `A matching route handler is registered in "${call.target}"${route ? ` (${route.method} ${route.path}, line ${route.line})` : ""}.`,
      "",
      `--- Call site in ${call.source} ---`,
      around(graph.root, call.source, call.line),
      `--- End call site ---`,
      "",
      ...(route
        ? [
            `--- Route handler in ${call.target} ---`,
            around(graph.root, call.target, route.line),
            `--- End route handler ---`,
            "",
          ]
        : []),
      "Explain what data this request is fetching or sending and how the two sides fit together.",
    ].join("\n");

    return { prompt, cacheKey: `apiCall::${call.id}` };
  }

  const node = graph.nodes.find((n) => n.id === target.id);
  if (!node) return { error: `no file node with id ${target.id}` };

  const importedBy = graph.edges.filter((e) => e.target === node.id).map((e) => e.source);
  const imports = graph.edges.filter((e) => e.source === node.id).map((e) => e.target);
  const calls = graph.apiCalls.filter((c) => c.source === node.id);

  const prompt = [
    `Subject: the file "${node.id}".`,
    `It exports: ${node.exports.length ? node.exports.join(", ") : "(nothing)"}.`,
    `It imports from: ${imports.length ? imports.join(", ") : "(nothing in this repo)"}.`,
    `It is imported by: ${importedBy.length ? importedBy.join(", ") : "(nothing — it may be an entry point)"}.`,
    calls.length
      ? `It makes HTTP requests: ${calls.map((c) => `${c.method} ${c.url}`).join(", ")}.`
      : "",
    "",
    `--- Start of ${node.id} ---`,
    head(graph.root, node.id, 60),
    `--- End of ${node.id} ---`,
    "",
    "Explain what role this file plays in the codebase and how it relates to the files around it.",
  ].join("\n");

  return { prompt, cacheKey: `node::${node.id}` };
}

const cache = new Map<string, string>();

export function clearExplanationCache(): void {
  cache.clear();
}

export async function explain(
  graph: FileGraph,
  target: ExplainTarget,
  model: string,
): Promise<{ explanation: string; model: string; cached: boolean } | { error: string }> {
  const built = buildPrompt(graph, target);
  if ("error" in built) return built;

  const cacheKey = `${model}::${built.cacheKey}`;
  const hit = cache.get(cacheKey);
  if (hit) return { explanation: hit, model, cached: true };

  const explanation = await generate({ model, prompt: built.prompt, system: SYSTEM_PROMPT });
  cache.set(cacheKey, explanation);
  return { explanation, model, cached: false };
}
