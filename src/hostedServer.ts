import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, SessionResponse, ExplainContextResponse } from "./types.js";
import { buildFileGraph, buildSymbolGraph, TooManyFilesError } from "./analyzer/index.js";
import { buildPrompt, SYSTEM_PROMPT } from "./llm/explain.js";
import { parseExplainTarget, EXPLAIN_TARGET_SHAPE } from "./llm/explainTarget.js";
import { IngestError, formatBytes } from "./ingest/errors.js";
import { extractZipToDir, unwrapSingleRoot } from "./ingest/zip.js";
import { cloneRepoToDir } from "./ingest/gitClone.js";
import {
  createSessionDir,
  registerSession,
  getSession,
  deleteSession,
  removeDir,
  startCleanupSweep,
  type Session,
} from "./session/store.js";
import { scrubGraphForClient } from "./session/scrub.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface HostedServerOptions {
  port: number;
  /** Model name suggested to the browser; the user can override it in the UI. */
  ollamaModel: string;
  sessionTtlMs: number;
  maxUploadBytes: number;
  maxRepoBytes: number;
  maxFiles: number;
  cloneTimeoutMs: number;
  /** Analyses allowed per IP per 15 minutes. */
  rateLimitMax: number;
}

export const HOSTED_DEFAULTS: Omit<HostedServerOptions, "port"> = {
  ollamaModel: "llama3.1:8b",
  sessionTtlMs: 30 * 60_000,
  maxUploadBytes: 50 * 1024 * 1024,
  maxRepoBytes: 200 * 1024 * 1024,
  maxFiles: 5000,
  cloneTimeoutMs: 60_000,
  rateLimitMax: 10,
};

function sendIngestError(res: Response, err: unknown): void {
  if (err instanceof IngestError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof TooManyFilesError) {
    res.status(413).json({ error: `${err.message}. Try a smaller project.` });
    return;
  }
  console.error("ingest failed:", err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}

export function startHostedServer(options: HostedServerOptions): Promise<string> {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  // Cloning and analysis are the expensive, abusable operations; reads below
  // are cheap and already require a session id that only these routes hand out.
  const ingestLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: options.rateLimitMax,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many analyses from this address. Try again in a few minutes." },
  });

  app.get("/api/config", (_req, res) => {
    const config: AppConfig = {
      mode: "hosted",
      ollamaModel: options.ollamaModel,
      maxUploadBytes: options.maxUploadBytes,
    };
    res.json(config);
  });

  /**
   * Runs the analyzer against a prepared directory and registers the session.
   * `prepare` returns the directory actually holding the project, which may be
   * a level below the session dir for zips wrapped in a single folder.
   */
  async function ingest(
    res: Response,
    origin: string,
    prepare: (sessionDir: string) => Promise<string> | string,
  ): Promise<void> {
    const { id, dir } = createSessionDir();
    try {
      const projectDir = await prepare(dir);
      const graph = buildFileGraph(projectDir, { maxFiles: options.maxFiles });

      if (graph.stats.fileCount === 0) {
        throw new IngestError("No JS/TS source files found — there is nothing to visualize.");
      }

      const session = registerSession(id, dir, projectDir, graph, origin);
      console.log(
        `session ${id} ready (${origin}): ${graph.stats.fileCount} files, ` +
          `${graph.stats.edgeCount} edges`,
      );
      const body: SessionResponse = {
        sessionId: session.id,
        graph: scrubGraphForClient(graph),
      };
      res.json(body);
    } catch (err) {
      removeDir(dir);
      sendIngestError(res, err);
    }
  }

  app.post(
    "/api/upload",
    ingestLimiter,
    express.raw({ type: "application/zip", limit: options.maxUploadBytes }),
    async (req, res) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({
          error: "Send the zip as the raw request body with Content-Type: application/zip.",
        });
        return;
      }
      await ingest(res, "upload", (tempDir) => {
        extractZipToDir(body, tempDir, {
          maxFiles: options.maxFiles,
          maxUncompressedBytes: options.maxRepoBytes,
        });
        return unwrapSingleRoot(tempDir);
      });
    },
  );

  app.post("/api/clone", ingestLimiter, async (req, res) => {
    const url = (req.body as { url?: unknown })?.url;
    if (typeof url !== "string" || url.trim().length === 0) {
      res.status(400).json({ error: 'body must be { url: "https://github.com/owner/repo" }' });
      return;
    }
    await ingest(res, `clone ${url}`, (tempDir) =>
      cloneRepoToDir(url, tempDir, {
        timeoutMs: options.cloneTimeoutMs,
        maxBytes: options.maxRepoBytes,
      }),
    );
  });

  /** Resolves :sessionId, answering 404 for unknown or swept-away sessions. */
  function withSession(req: Request, res: Response): Session | undefined {
    const session = getSession(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found or expired. Upload the project again." });
      return undefined;
    }
    return session;
  }

  app.get("/api/sessions/:sessionId/graph", (req, res) => {
    const session = withSession(req, res);
    if (!session) return;
    res.json(scrubGraphForClient(session.graph));
  });

  app.get("/api/sessions/:sessionId/symbols", (req, res) => {
    const session = withSession(req, res);
    if (!session) return;

    const file = req.query.file;
    if (typeof file !== "string" || file.length === 0) {
      res.status(400).json({ error: "missing ?file= query parameter" });
      return;
    }
    // Guards path traversal as a side effect: only ids the analyzer produced
    // are accepted, so `file` can never be an arbitrary path.
    if (!session.graph.nodes.some((n) => n.id === file)) {
      res.status(404).json({ error: `unknown file: ${file}` });
      return;
    }
    try {
      res.json(buildSymbolGraph(session.projectDir, file));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Assembles the prompt but does not call Ollama — the model runs on the
  // user's machine, which only their browser can reach.
  app.post("/api/sessions/:sessionId/explain-context", (req, res) => {
    const session = withSession(req, res);
    if (!session) return;

    const target = parseExplainTarget(req.body);
    if (!target) {
      res.status(400).json({ error: EXPLAIN_TARGET_SHAPE });
      return;
    }

    const built = buildPrompt(session.graph, target);
    if ("error" in built) {
      res.status(404).json(built);
      return;
    }

    const body: ExplainContextResponse = {
      prompt: built.prompt,
      system: SYSTEM_PROMPT,
      cacheKey: built.cacheKey,
      suggestedModel: options.ollamaModel,
    };
    res.json(body);
  });

  app.delete("/api/sessions/:sessionId", (req, res) => {
    deleteSession(req.params.sessionId);
    res.status(204).end();
  });

  // Same static-file setup as the local server, so one web/dist build serves
  // both and the API stays same-origin (no CORS needed anywhere).
  const webDist = path.resolve(__dirname, "../web/dist");
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });

  // Body-parser rejections (oversized upload, malformed JSON) would otherwise
  // reach Express's default handler, which renders an HTML page containing a
  // stack trace and absolute server paths.
  app.use((err: unknown, _req: Request, res: Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = typeof (err as { status?: unknown })?.status === "number"
      ? (err as { status: number }).status
      : 500;
    if (status === 413) {
      res.status(413).json({
        error: `Upload is larger than ${formatBytes(options.maxUploadBytes)}.`,
      });
      return;
    }
    if (status === 400) {
      res.status(400).json({ error: "Malformed request body." });
      return;
    }
    console.error("unhandled error:", err);
    res.status(500).json({ error: "Internal server error." });
  });

  startCleanupSweep(5 * 60_000, options.sessionTtlMs);

  return new Promise((resolve, reject) => {
    const server = app.listen(options.port, () => {
      resolve(`http://localhost:${options.port}`);
    });
    server.on("error", reject);
  });
}
