import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileGraph } from "./types.js";
import { buildSymbolGraph } from "./analyzer/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startServer(
  rootDir: string,
  graph: FileGraph,
  port: number,
): Promise<string> {
  const app = express();

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
