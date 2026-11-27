import * as vscode from "vscode";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { MapState, SourceLocation } from "../src/protocol.js";

interface ExtensionApi {
  getState(): MapState | null;
  refresh(): Promise<void>;
  navigate(location: SourceLocation): Promise<void>;
  dispose(): void;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, description: string): Promise<void> {
  for (let i = 0; i < 160; i++) { if (check()) return; await delay(100); }
  throw new Error(`Timed out: ${description}`);
}

export async function run(): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, "../../package.json"), "utf8"));
  const extension = vscode.extensions.getExtension<ExtensionApi>(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension, "extension should be installed in the development host");
  const api = await extension.activate();
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder);
  await vscode.commands.executeCommand("codeMap.open");
  await until(() => !!api.getState()?.graph, "initial workspace analysis");
  const base = api.getState()!;
  assert.equal(base.graph!.stats.fileCount, 10);
  assert.ok(base.graph!.edges.every((edge) => Number.isInteger(edge.line)));
  console.log("PASS initial worker-backed graph and import locations");

  await api.navigate({ fileId: "services/project-service.mjs", line: 4 });
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, vscode.Uri.joinPath(folder.uri, "services/project-service.mjs").fsPath);
  assert.equal(vscode.window.activeTextEditor?.selection.start.line, 3);
  await until(() => api.getState()?.activeFileId === "services/project-service.mjs", "active editor synchronization");
  await assert.rejects(api.navigate({ fileId: "../outside.ts" }), /current code map/);
  console.log("PASS native source navigation, exact line, active editor, and path rejection");

  const added = vscode.Uri.joinPath(folder.uri, "live-test.ts");
  await vscode.workspace.fs.writeFile(added, Buffer.from("export function created() { return 1; }\n"));
  await until(() => !!api.getState()?.graph?.nodes.some((node) => node.id === "live-test.ts"), "new file watcher");
  const document = await vscode.workspace.openTextDocument(added);
  const editor = await vscode.window.showTextDocument(document);
  const revision = api.getState()!.revision;
  await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'import { projects } from "./storage/projects.mjs";\n'));
  await until(() => api.getState()?.dirty === true, "unsaved buffer state");
  assert.equal(api.getState()!.revision, revision, "unsaved typing must not masquerade as a disk refresh");
  assert.equal(await document.save(), true);
  await until(() => !!api.getState()?.graph?.edges.some((edge) => edge.source === "live-test.ts" && edge.target === "storage/projects.mjs"), "saved import change");
  assert.equal(api.getState()!.dirty, false);
  console.log("PASS file creation, unsaved-edit notice, save refresh, and new import");

  const renamed = vscode.Uri.joinPath(folder.uri, "renamed-test.ts");
  await vscode.workspace.fs.rename(added, renamed);
  await until(() => !!api.getState()?.graph?.nodes.some((node) => node.id === "renamed-test.ts") && !api.getState()?.graph?.nodes.some((node) => node.id === "live-test.ts"), "file rename watcher");
  await vscode.workspace.fs.delete(renamed);
  await until(() => !api.getState()?.graph?.nodes.some((node) => node.id === "renamed-test.ts"), "file deletion watcher");
  console.log("PASS rename/delete refresh without stale nodes");

  const config = vscode.Uri.joinPath(folder.uri, "tsconfig.json");
  const lastGood = api.getState()!.graph!.stats.fileCount;
  await vscode.workspace.fs.writeFile(config, Buffer.from("{"));
  await until(() => !!api.getState()?.error, "configuration error");
  assert.equal(api.getState()!.graph!.stats.fileCount, lastGood, "error must retain last successful graph");
  await vscode.workspace.fs.delete(config);
  await until(() => !api.getState()?.error && !api.getState()?.refreshing, "error recovery");
  console.log("PASS config error retains graph and recovers");

  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  api.dispose();
  assert.equal(api.getState(), null);
  await vscode.commands.executeCommand("codeMap.open");
  await until(() => !!api.getState()?.graph, "reopening disposed map");
  assert.equal(api.getState()!.graph!.stats.fileCount, 10);
  api.dispose();
  console.log("PASS dispose/reopen lifecycle");

  const evidence = { passed: 6, actualVsCodeHost: vscode.version, checks: ["initial graph", "native navigation", "active editor", "save/create/rename/delete", "last-good error recovery", "dispose/reopen"] };
  const evidenceRoot = process.env.CODE_MAP_TEST_ROOT ?? path.join(os.tmpdir(), "code-map-vscode");
  await fs.mkdir(evidenceRoot, { recursive: true });
  await fs.writeFile(path.join(evidenceRoot, "integration-results.json"), JSON.stringify(evidence, null, 2));
}
