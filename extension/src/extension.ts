import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { AnalysisClient } from "./analysisClient.js";
import { affectsGraph, parseRequest, RefreshQueue, sourcePath } from "./helpers.js";
import type { HostMessage, MapState, SourceLocation } from "./protocol.js";

let current: MapController | undefined;

function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(24).toString("hex");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", "graph.js"));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", "graph.css"));
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; style-src-attr 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; worker-src blob:; connect-src 'none';">
<link rel="stylesheet" href="${css}"><title>Code Map</title></head>
<body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

async function chooseFolder(preferActive = false): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    void vscode.window.showInformationMessage("Open a project folder in VS Code before opening Code Map.");
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  if (preferActive && vscode.window.activeTextEditor) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
    if (folder) return folder;
  }
  const choice = await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })), {
    title: "Choose a workspace folder for Code Map",
  });
  return choice?.folder;
}

class MapController implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly worker: AnalysisClient;
  private readonly queue: RefreshQueue;
  private readonly subscriptions: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposed = false;
  private generation = 0;
  private sourceColumn: vscode.ViewColumn;
  private folder: vscode.WorkspaceFolder | undefined;
  private state: MapState;

  constructor(private readonly context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder) {
    this.folder = folder;
    this.sourceColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    this.state = {
      workspaceName: folder.name, workspaceId: folder.uri.toString(), graph: null,
      revision: 0, refreshing: false, dirty: false, error: null, activeFileId: null,
    };
    this.worker = new AnalysisClient(path.join(context.extensionPath, "dist", "analysisWorker.cjs"));
    this.queue = new RefreshQueue(() => this.analyze(), (error) => {
      if (this.disposed) return;
      this.state = { ...this.state, refreshing: false, error: error instanceof Error ? error.message : String(error) };
      this.postState();
    });
    this.panel = vscode.window.createWebviewPanel("codeMap.graph", "Code Map", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
    });
    this.panel.webview.html = webviewHtml(this.panel.webview, context.extensionUri);
    this.subscriptions.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handleRequest(message).catch((error) => {
          this.post({ type: "navigationError", message: error instanceof Error ? error.message : String(error) });
        });
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.viewColumn) this.sourceColumn = editor.viewColumn;
        this.updateEditorState();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.folder && affectsGraph(this.folder.uri.fsPath, event.document.uri.fsPath)) this.updateEditorState();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.updateEditorState();
        if (this.folder && affectsGraph(this.folder.uri.fsPath, document.uri.fsPath)) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("codeMap")) void this.refresh();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (this.folder && !vscode.workspace.workspaceFolders?.some((entry) => entry.uri.toString() === this.folder!.uri.toString())) {
          this.setFolder(vscode.workspace.workspaceFolders?.[0]);
        }
      }),
    );
    this.watchFolder();
  }

  private watchFolder(): void {
    this.watcher?.dispose();
    if (!this.folder) return;
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, "**/*"));
    const changed = (uri: vscode.Uri) => {
      if (this.folder && affectsGraph(this.folder.uri.fsPath, uri.fsPath)) this.schedule();
    };
    this.watcher.onDidChange(changed);
    this.watcher.onDidCreate(changed);
    this.watcher.onDidDelete(changed);
  }

  private schedule(): void {
    if (this.folder && vscode.workspace.getConfiguration("codeMap", this.folder.uri).get("autoRefresh", true)) void this.queue.request();
  }

  private async analyze(): Promise<void> {
    const folder = this.folder;
    if (!folder || this.disposed) return;
    const generation = this.generation;
    const configuredLimit = vscode.workspace.getConfiguration("codeMap", folder.uri).get<number>("maxFiles", 5000);
    const maxFiles = Number.isFinite(configuredLimit) ? Math.max(1, Math.min(20000, Math.floor(configuredLimit))) : 5000;
    this.state = { ...this.state, refreshing: true, error: null };
    this.postState();
    try {
      const graph = await this.worker.analyze(folder.uri.fsPath, maxFiles);
      if (this.disposed || generation !== this.generation) return;
      this.state = { ...this.state, graph, revision: this.state.revision + 1, refreshing: false, error: null };
      this.updateEditorState(true);
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.state = { ...this.state, refreshing: false, error: error instanceof Error ? error.message : String(error) };
      this.postState();
    }
  }

  private updateEditorState(force = false): void {
    if (this.disposed) return;
    const folder = this.folder;
    const editor = vscode.window.activeTextEditor;
    const relative = folder && editor ? path.relative(folder.uri.fsPath, editor.document.uri.fsPath).split(path.sep).join("/") : null;
    const activeFileId = this.state.graph?.nodes.some((node) => node.id === relative) ? relative : null;
    const dirty = !!folder && vscode.workspace.textDocuments.some((document) => document.isDirty && affectsGraph(folder.uri.fsPath, document.uri.fsPath));
    const changed = activeFileId !== this.state.activeFileId || dirty !== this.state.dirty;
    this.state = { ...this.state, activeFileId, dirty };
    // Text-change events arrive per keystroke; resend the large graph only
    // when the editor state changes or a new analysis snapshot is ready.
    if (force || changed) this.postState();
  }

  private post(message: HostMessage): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  private postState(): void { this.post({ type: "state", state: this.state }); }

  private async handleRequest(raw: unknown): Promise<void> {
    if (this.disposed) return;
    const message = parseRequest(raw);
    if (!message) return;
    if (message.type === "ready") { this.postState(); return; }
    if (message.type === "refresh") { await this.refresh(); return; }
    if (message.type === "chooseWorkspace") { await this.chooseWorkspace(); return; }
    if (message.type === "open") { await this.navigate(message.location); return; }
    const revision = this.state.revision;
    const generation = this.generation;
    try {
      if (!this.folder) throw new Error("Open a workspace folder first.");
      sourcePath(this.folder.uri.fsPath, this.state.graph, { fileId: message.fileId });
      const graph = await this.worker.symbols(this.folder.uri.fsPath, message.fileId);
      if (this.disposed || generation !== this.generation || revision !== this.state.revision) return;
      this.post({ type: "symbols", fileId: message.fileId, requestId: message.requestId, revision, graph, error: null });
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      this.post({ type: "symbols", fileId: message.fileId, requestId: message.requestId, revision, graph: null, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async navigate(location: SourceLocation): Promise<void> {
    const request = parseRequest({ type: "open", location });
    if (!request || request.type !== "open" || !this.folder || this.disposed) throw new Error("Invalid source location.");
    sourcePath(this.folder.uri.fsPath, this.state.graph, request.location);
    const uri = vscode.Uri.joinPath(this.folder.uri, ...location.fileId.split("/"));
    const document = await vscode.workspace.openTextDocument(uri);
    const line = Math.min((location.line ?? 1) - 1, Math.max(0, document.lineCount - 1));
    const range = new vscode.Range(line, 0, line, 0);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: this.sourceColumn, selection: range, preview: true, preserveFocus: location.preserveFocus ?? false,
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.updateEditorState();
  }

  private setFolder(folder: vscode.WorkspaceFolder | undefined): void {
    this.generation++;
    this.folder = folder;
    this.state = {
      workspaceName: folder?.name ?? "No workspace", workspaceId: folder?.uri.toString() ?? "",
      graph: null, revision: 0, refreshing: false, dirty: false,
      error: folder ? null : "Open a project folder to map its code.", activeFileId: null,
    };
    this.watchFolder();
    this.postState();
    if (folder) void this.refresh();
  }

  async chooseWorkspace(): Promise<void> {
    const folder = await chooseFolder();
    if (folder && folder.uri.toString() !== this.folder?.uri.toString()) this.setFolder(folder);
  }

  reveal(): void { this.panel.reveal(vscode.ViewColumn.Beside); }
  refresh(): Promise<void> { return this.queue.request(true); }
  getState(): MapState { return structuredClone(this.state); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.dispose();
    this.watcher?.dispose();
    this.worker.dispose();
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.panel.dispose();
    if (current === this) current = undefined;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const api = {
    getState: () => current?.getState() ?? null,
    refresh: () => current?.refresh() ?? Promise.resolve(),
    navigate: async (location: SourceLocation) => {
      if (!current) throw new Error("Open Code Map first.");
      await current.navigate(location);
    },
    dispose: () => current?.dispose(),
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("codeMap.open", async () => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showInformationMessage("Trust this workspace before opening Code Map.");
        return undefined;
      }
      if (current) { current.reveal(); return api; }
      const folder = await chooseFolder(true);
      if (!folder) return undefined;
      current = new MapController(context, folder);
      await current.refresh();
      return api;
    }),
    vscode.commands.registerCommand("codeMap.refresh", () => api.refresh()),
    vscode.commands.registerCommand("codeMap.chooseWorkspace", () => current?.chooseWorkspace()),
    new vscode.Disposable(() => current?.dispose()),
  );
  return api;
}

export function deactivate(): void { current?.dispose(); }
