import type { HostMessage, WebviewRequest } from "../../../extension/src/protocol";

interface ViewSettings {
  followEditor: boolean;
}

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewRequest): void;
  getState(): ViewSettings | undefined;
  setState(state: ViewSettings): void;
};

const vscode = acquireVsCodeApi();

export function post(message: WebviewRequest): void {
  vscode.postMessage(message);
}

export function subscribe(receive: (message: HostMessage) => void): () => void {
  function onMessage(event: MessageEvent<HostMessage>) {
    if (event.data && typeof event.data === "object") receive(event.data);
  }

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

export function getFollowEditor(): boolean {
  return vscode.getState()?.followEditor ?? true;
}

export function setFollowEditor(followEditor: boolean): void {
  vscode.setState({ followEditor });
}
