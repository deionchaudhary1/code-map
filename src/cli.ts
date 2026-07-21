#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import open from "open";
import { buildFileGraph } from "./analyzer/index.js";
import { startServer } from "./server.js";
import { checkAvailability } from "./llm/ollama.js";

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
  .action(
    async (
      dir: string,
      opts: { port: string; out?: string; open: boolean; ollamaModel: string; ai: boolean },
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

      const url = await startServer(rootDir, graph, Number(opts.port), {
        aiEnabled: opts.ai,
        ollamaModel: opts.ollamaModel,
      });
      console.log(`code-map running at ${url}  (Ctrl+C to stop)`);
      if (opts.open) {
        await open(url);
      }
    },
  );

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
