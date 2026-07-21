import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExplainTarget, FileGraph } from "./types.js";
import { buildSymbolGraph } from "./analyzer/index.js";
import { explain } from "./llm/explain.js";
import { OllamaUnavailableError } from "./llm/ollama.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  /** When false, /api/explain responds 503 without contacting Ollama. */
  aiEnabled: boolean;
  ollamaModel: string;
}

function parseExplainTarget(body: unknown): ExplainTarget | undefined {
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

export function startServer(
  rootDir: string,
  graph: FileGraph,
  port: number,
  options: ServerOptions,
): Promise<string> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/graph", (_req, res) => {
    res.json(graph);
  });

  app.get("/api/symbols", (req, res) => {
    const file = req.query.file;
    if (typeof file !== "string" || file.length === 0) {
      res.status(400).json({ error: "missing ?file= query parameter" });
      return;
    }
    if (!graph.nodes.some((n) => n.id === file)) {
      res.status(404).json({ error: `unknown file: ${file}` });
      return;
    }
    try {
      res.json(buildSymbolGraph(rootDir, file));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/explain", async (req, res) => {
    if (!options.aiEnabled) {
      res.status(503).json({ error: "AI explanations are disabled (started with --no-ai)." });
      return;
    }

    const target = parseExplainTarget(req.body);
    if (!target) {
      res.status(400).json({
        error: 'body must be {kind:"import",source,target} | {kind:"apiCall",id} | {kind:"node",id}',
      });
      return;
    }

    try {
      const result = await explain(graph, target, options.ollamaModel);
      if ("error" in result) {
        res.status(404).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      if (err instanceof OllamaUnavailableError) {
        res.status(503).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Serve the built frontend. dist/server.js sits next to web/ in the
  // published package; during tsx dev runs __dirname is src/, so ../web/dist
  // resolves correctly in both cases.
  const webDist = path.resolve(__dirname, "../web/dist");
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      resolve(`http://localhost:${port}`);
    });
    server.on("error", reject);
  });
}
