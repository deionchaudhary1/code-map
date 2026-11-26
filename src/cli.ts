#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import open from "open";
import { buildFileGraph } from "./analyzer/index.js";
import { startServer } from "./server.js";
import { checkAvailability } from "./llm/ollama.js";
import { runTrace } from "./trace/runner.js";

const program = new Command();

program
  .name("code-map")
  .description("Visualize a JS/TS codebase as an interactive dependency graph")
  .argument("[dir]", "project directory to analyze", ".")
  .option("-p, --port <port>", "port for the local server", "4280")
  .option("-o, --out <file>", "also write the graph JSON to a file")
  .option("--no-open", "do not open the browser automatically")
  .option("--ollama-model <name>", "Ollama model for AI explanations", "llama3.1:8b")
  .option("--no-ai", "disable AI explanations (skips the Ollama check)")
  .option("--run <command>", "run this command and overlay which code actually executed")
  .option("--trace-timeout <sec>", "kill the traced command after this long", "300")
  .action(
    async (
      dir: string,
      opts: {
        port: string;
        out?: string;
        open: boolean;
        ollamaModel: string;
        ai: boolean;
        run?: string;
        traceTimeout: string;
      },
    ) => {
    const rootDir = path.resolve(dir);
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
      console.error(`error: not a directory: ${rootDir}`);
      process.exit(1);
    }

      console.log(`Analyzing ${rootDir} ...`);
      const started = Date.now();
      const graph = buildFileGraph(rootDir);
      const { fileCount, edgeCount, cycleCount, skippedFiles, apiCallCount, routeCount } = graph.stats;
      console.log(
        `Found ${fileCount} files, ${edgeCount} import edges, ${cycleCount} cycles, ` +
          `${apiCallCount} API calls, ${routeCount} routes` +
          (skippedFiles ? `, ${skippedFiles} files skipped (parse errors)` : "") +
          ` in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );

      if (fileCount === 0) {
        console.error("error: no JS/TS files found — nothing to visualize");
        process.exit(1);
      }

      if (opts.run) {
        const timeoutSec = Number(opts.traceTimeout);
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
          console.error(`error: --trace-timeout must be a positive number, got "${opts.traceTimeout}"`);
          process.exit(1);
        }

        console.log(`\nRunning: ${opts.run}\n`);
        const trace = await runTrace(graph, {
          command: opts.run,
          rootDir,
          timeoutMs: timeoutSec * 1000,
        });
        graph.runtime = trace;

        const executed = trace.executedFiles.length;
        const ranSymbols = trace.symbols.filter((s) => s.calls > 0).length;
        // Functions are counted only within files that actually loaded: V8
        // never reports a file it didn't evaluate, so functions in dead files
        // have no coverage entry at all. Files are the complete measure.
        console.log(
          `\n${executed} of ${fileCount} files executed, ${fileCount - executed} never ran ` +
            `(${(trace.durationMs / 1000).toFixed(1)}s)`,
        );
        console.log(
          `Within those files, ${ranSymbols} of ${trace.symbols.length} functions were called`,
        );
        if (trace.unmappedFiles.length > 0) {
          console.log(`Couldn't map ${trace.unmappedFiles.length} covered file(s) to the graph`);
        }
        if (trace.warning) console.log(`Note: ${trace.warning}`);
      }

      if (opts.out) {
        fs.writeFileSync(opts.out, JSON.stringify(graph, null, 2));
        console.log(`Graph written to ${opts.out}`);
      }

      if (opts.ai) {
        const status = await checkAvailability(opts.ollamaModel);
        console.log(
          status.ok
            ? `AI explanations: ${status.message}`
            : `AI explanations unavailable: ${status.message}`,
        );
      } else {
        console.log("AI explanations: disabled (--no-ai)");
      }

      const port = Number(opts.port);
      let url: string;
      try {
        url = await startServer(rootDir, graph, port, {
          aiEnabled: opts.ai,
          ollamaModel: opts.ollamaModel,
        });
      } catch (err) {
        // Bare "EADDRINUSE" leaves the user guessing; the usual cause is an
        // earlier code-map still holding the port in the background.
        if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
          console.error(
            `Port ${port} is already in use — another code-map (or hosted server) may still be running.\n` +
              `  Stop it:            lsof -ti:${port} | xargs kill\n` +
              `  Or use another:     --port ${port + 1}`,
          );
          process.exit(1);
        }
        throw err;
      }
      console.log(`code-map running at ${url}  (Ctrl+C to stop)`);
      if (opts.open) {
        await open(url);
      }
    },
  );

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  const code = (err as NodeJS.ErrnoException)?.code;
  process.exit(code === "SIGINT" ? 130 : code === "SIGTERM" ? 143 : 1);
});
