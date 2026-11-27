import { useEffect, useMemo, useRef, useState } from "react";
import type { MapState, SourceLocation } from "../../../extension/src/protocol";
import GraphCanvas from "../components/GraphCanvas";
import { toGraphLinks, toGraphNodes, type GraphLink, type GraphNode } from "../graphModel";
import type { LayoutOptions } from "../layout/elk";
import { useLayout } from "../layout/useLayout";
import Inspector from "./Inspector";
import { getFollowEditor, post, setFollowEditor, subscribe } from "./vscode";

const LAYOUT_OPTIONS: LayoutOptions = { direction: "DOWN", uniformWidth: false };
const NO_EXECUTED_FILES = new Set<string>();
const NO_FILE_HITS: Record<string, number> = {};

type Selection = { kind: "node" | "link"; id: string } | null;

function preserveSnapshot(previous: MapState | null, incoming: MapState): MapState {
  if (!previous?.graph || previous.workspaceId !== incoming.workspaceId) return incoming;
  if (incoming.graph && previous.revision !== incoming.revision) return incoming;
  return { ...incoming, graph: previous.graph, revision: previous.revision };
}

export default function App() {
  const [state, setState] = useState<MapState | null>(null);
  const [followEditor, updateFollowEditor] = useState(getFollowEditor);
  const [navigationError, setNavigationError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      switch (message.type) {
        case "state":
          setState((previous) => preserveSnapshot(previous, message.state));
          break;
        case "navigationError":
          setNavigationError(message.message);
          break;
      }
    });
    post({ type: "ready" });
    return unsubscribe;
  }, []);

  function openSource(fileId: string, line?: number, preserveFocus = false) {
    setNavigationError(null);
    const location: SourceLocation = { fileId, line, preserveFocus };
    post({ type: "open", location });
  }

  if (!state) return <main className="center-state" role="status">Connecting to VS Code…</main>;

  return (
    <Workspace
      key={state.workspaceId}
      state={state}
      followEditor={followEditor}
      setFollow={(value) => {
        updateFollowEditor(value);
        setFollowEditor(value);
      }}
      navigationError={navigationError}
      dismissNavigationError={() => setNavigationError(null)}
      openSource={openSource}
    />
  );
}

interface WorkspaceProps {
  state: MapState;
  followEditor: boolean;
  setFollow: (value: boolean) => void;
  navigationError: string | null;
  dismissNavigationError: () => void;
  openSource: (fileId: string, line?: number, preserveFocus?: boolean) => void;
}

function Workspace({
  state,
  followEditor,
  setFollow,
  navigationError,
  dismissNavigationError,
  openSource,
}: WorkspaceProps) {
  const { graph } = state;
  const [selection, setSelection] = useState<Selection>(null);
  const [search, setSearch] = useState("");
  const [fitVersion, setFitVersion] = useState(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const canvas = useRef<HTMLDivElement>(null);

  const { nodes, links, nodeById, linkById, fileIds } = useMemo(() => {
    const nodes = toGraphNodes(graph?.nodes ?? [], graph?.endpoints ?? []);
    const occurrences = new Map<string, number>();
    const links = toGraphLinks(graph?.edges ?? [], graph?.apiCalls ?? []).map((link) => {
      // Repeated imports and HTTP calls share an analyzer key. Keep each
      // occurrence selectable so each source line remains available.
      const occurrence = (occurrences.get(link.linkId) ?? 0) + 1;
      occurrences.set(link.linkId, occurrence);
      return { ...link, linkId: JSON.stringify([link.linkId, occurrence]) };
    });
    return {
      nodes,
      links,
      nodeById: new Map(nodes.map((node) => [node.id, node])),
      linkById: new Map(links.map((link) => [link.linkId, link])),
      fileIds: (graph?.nodes ?? []).map((node) => node.id).sort(),
    };
  }, [graph]);
  const layout = useLayout(nodes, links, LAYOUT_OPTIONS);
  const selectedNode = selection?.kind === "node" ? nodeById.get(selection.id) : undefined;
  const selectedLink = selection?.kind === "link" ? linkById.get(selection.id) : undefined;
  const activeFileId = state.activeFileId && nodeById.get(state.activeFileId)?.kind === "file"
    ? state.activeFileId
    : null;
  const selectedFileId = selectedNode?.kind === "file" ? selectedNode.id : "";
  const searchText = search.trim().toLowerCase();
  const matchingFiles = useMemo(
    () => fileIds.filter((id) => id.toLowerCase().includes(searchText)),
    [fileIds, searchText],
  );
  const fileOptions = selectedFileId && !matchingFiles.includes(selectedFileId)
    ? [selectedFileId, ...matchingFiles]
    : matchingFiles;

  const neighborIds = useMemo(() => {
    const neighbors = new Set<string>();
    if (!selectedNode) return neighbors;
    for (const { source, target } of links) {
      if (source === selectedNode.id) neighbors.add(target);
      if (target === selectedNode.id) neighbors.add(source);
    }
    return neighbors;
  }, [links, selectedNode]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      setViewport((current) => current.width === width && current.height === height
        ? current
        : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (followEditor && activeFileId) setSelection({ kind: "node", id: activeFileId });
  }, [activeFileId, followEditor]);

  useEffect(() => {
    if (selection && !selectedNode && !selectedLink) setSelection(null);
  }, [selection, selectedNode, selectedLink]);

  function inspectNode(node: GraphNode | null) {
    setSelection(node ? { kind: "node", id: node.id } : null);
    if (node?.kind === "file") openSource(node.id, undefined, true);
  }

  function inspectLink(link: GraphLink | null) {
    setSelection(link ? { kind: "link", id: link.linkId } : null);
  }

  const hasFiles = fileIds.length > 0;
  const hasCanvas = hasFiles && layout.result && viewport.width > 0 && viewport.height > 0;
  const counts = graph && hasFiles
    ? `${fileIds.length} ${fileIds.length === 1 ? "file" : "files"} · ${links.length} ${links.length === 1 ? "connection" : "connections"}`
    : null;

  return (
    <div className="editor-map">
      <header className="map-header">
        <div className="workspace-row">
          <h1 title={state.workspaceName}>{state.workspaceName || "Code Map"}</h1>
          {counts && <span className="map-counts">{counts}</span>}
          <div className="map-actions">
            <button type="button" onClick={() => post({ type: "chooseWorkspace" })}>Switch workspace</button>
            <button type="button" disabled={state.refreshing} onClick={() => post({ type: "refresh" })}>Refresh</button>
            <button type="button" disabled={!hasCanvas || layout.status === "pending"} onClick={() => setFitVersion((v) => v + 1)}>Fit</button>
          </div>
        </div>
        <div className="control-row">
          <label className="field">
            <span>Search</span>
            <input
              type="search"
              value={search}
              placeholder="File path"
              onChange={(event) => setSearch(event.target.value)}
              disabled={!hasFiles}
            />
          </label>
          <label className="field file-field">
            <span>File</span>
            <select
              value={selectedFileId}
              onChange={(event) => setSelection(event.target.value ? { kind: "node", id: event.target.value } : null)}
              disabled={!hasFiles}
            >
              <option value="">{searchText && matchingFiles.length === 0 ? "No matching files" : "Select a file"}</option>
              {fileOptions.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <button type="button" disabled={!selection} onClick={() => setSelection(null)}>Clear selection</button>
          <label className="follow-control">
            <input type="checkbox" checked={followEditor} onChange={(event) => setFollow(event.target.checked)} />
            Follow active editor
          </label>
        </div>
      </header>

      {state.error && (
        <div className="notice notice-error" role="alert">
          <span>{state.error}{graph ? " Showing the last saved snapshot." : ""}</span>
          <button type="button" disabled={state.refreshing} onClick={() => post({ type: "refresh" })}>Retry</button>
        </div>
      )}
      {navigationError && (
        <div className="notice notice-error" role="alert">
          <span>{navigationError}</span>
          <button type="button" onClick={dismissNavigationError}>Dismiss</button>
        </div>
      )}
      {(state.refreshing || state.dirty) && (
        <div className="notice" role="status">
          {state.refreshing && <span>{graph ? "Refreshing saved files…" : "Analyzing workspace…"}</span>}
          {state.dirty && <span>Unsaved changes. The map uses saved files.</span>}
        </div>
      )}

      <main className="map-body">
        <section className="map-pane" aria-label="Dependency graph">
          <div className="canvas-viewport" ref={canvas} aria-hidden="true">
            {hasCanvas && layout.result && (
              <GraphCanvas
                nodes={nodes}
                links={links}
                layout={layout.result}
                width={viewport.width}
                height={viewport.height}
                autoFit={false}
                fitVersion={fitVersion}
                search={search}
                selectedId={selectedNode?.id ?? null}
                selectedLinkId={selectedLink?.linkId ?? null}
                neighborIds={neighborIds}
                onSelectNode={inspectNode}
                onSelectLink={inspectLink}
                runtimeMode={false}
                executedIds={NO_EXECUTED_FILES}
                fileHits={NO_FILE_HITS}
                topicIndex={null}
              />
            )}
          </div>
          {!hasFiles && (
            <div className="center-state" role="status">
              {graph ? "No supported JavaScript or TypeScript files found." :
                state.error ? "The map is unavailable." :
                state.refreshing ? "Building the dependency graph…" : "Waiting for a workspace."}
            </div>
          )}
          {hasFiles && layout.status === "pending" && (
            <div className="canvas-status" role="status">Laying out graph…</div>
          )}
          {hasFiles && layout.status === "failed" && (
            <div className="canvas-status notice-error" role="alert">Could not lay out the graph. {layout.error}</div>
          )}
        </section>
        {graph && hasFiles && (
          <Inspector
            node={selectedNode}
            link={selectedLink}
            nodeById={nodeById}
            links={links}
            routes={graph.routes}
            revision={state.revision}
            openSource={openSource}
            inspectLink={inspectLink}
          />
        )}
      </main>
    </div>
  );
}
