import { parentPort } from "node:worker_threads";
import { buildFileGraph, buildSymbolGraph } from "../../src/analyzer/index.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

if (!parentPort) throw new Error("Code Map analysis must run in a worker.");

parentPort.on("message", (request: WorkerRequest) => {
  let response: WorkerResponse;
  try {
    const graph = request.type === "analyze"
      ? buildFileGraph(request.rootDir, { maxFiles: request.maxFiles })
      : buildSymbolGraph(request.rootDir, request.fileId);
    response = { id: request.id, type: "result", graph };
  } catch (error) {
    response = { id: request.id, type: "error", message: error instanceof Error ? error.message : String(error) };
  }
  parentPort!.postMessage(response);
});
