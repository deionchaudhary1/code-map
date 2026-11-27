import { Worker } from "node:worker_threads";
import type { FileGraph, SymbolGraph } from "../../src/types.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

export class AnalysisClient {
  private worker: Worker;
  private nextId = 0;
  private closed = false;
  private pending = new Map<number, { resolve: (value: FileGraph | SymbolGraph) => void; reject: (error: Error) => void }>();

  constructor(filename: string) {
    this.worker = new Worker(filename);
    this.worker.on("message", (message: WorkerResponse) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.type === "error") request.reject(new Error(message.message));
      else request.resolve(message.graph);
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", () => this.fail(new Error("Code Map analysis worker stopped. Reopen the map to restart it.")));
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private request(message: Omit<Extract<WorkerRequest, { type: "analyze" }>, "id"> | Omit<Extract<WorkerRequest, { type: "symbols" }>, "id">): Promise<FileGraph | SymbolGraph> {
    if (this.closed) return Promise.reject(new Error("Code Map analysis worker is closed. Reopen the map to restart it."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
    });
  }

  async analyze(rootDir: string, maxFiles: number): Promise<FileGraph> {
    return await this.request({ type: "analyze", rootDir, maxFiles }) as FileGraph;
  }

  async symbols(rootDir: string, fileId: string): Promise<SymbolGraph> {
    return await this.request({ type: "symbols", rootDir, fileId }) as SymbolGraph;
  }

  dispose(): void {
    this.fail(new Error("Code Map was closed."));
    void this.worker.terminate();
  }
}
