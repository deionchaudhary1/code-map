import { useEffect, useMemo, useState } from "react";
import type { FileGraph } from "./types";
import { fetchFileGraph } from "./api";
import { toGraphLinks, toGraphNodes, type GraphLink, type GraphNode } from "./graphModel";
import TopBar from "./components/TopBar";
import StatsOverlay from "./components/StatsOverlay";
import SidePanel from "./components/SidePanel";
import GraphCanvas from "./components/GraphCanvas";

export default function App() {
  const [graph, setGraph] = useState<FileGraph | null>(null);
  const [search, setSearch] = useState("");
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [selectedExtensions, setSelectedExtensions] = useState<Set<string>>(new Set());
  const [cyclesOnly, setCyclesOnly] = useState(false);
  const [apiOnly, setApiOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    fetchFileGraph().then(setGraph);
  }, []);

  useEffect(() => {
    function handleResize() {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const folders = useMemo(
    () => (graph ? Array.from(new Set(graph.nodes.map((n) => n.folder))).sort() : []),
    [graph]
  );
  const extensions = useMemo(
    () => (graph ? Array.from(new Set(graph.nodes.map((n) => n.extension))).sort() : []),
    [graph]
  );

  const cycleNodeIds = useMemo(() => {
    if (!graph) return new Set<string>();
    return new Set(graph.cycles.flat());
  }, [graph]);

  /** Files that either make or serve an API call — used by the "API only" filter. */
  const apiNodeIds = useMemo(() => {
    if (!graph) return new Set<string>();
    const ids = new Set<string>();
    for (const call of graph.apiCalls) {
      ids.add(call.source);
      ids.add(call.target);
    }
    return ids;
  }, [graph]);

  function toggleFolder(folder: string) {
    setSelectedFolders((prev) => {
      const next = new Set(prev);
      if (next.size === 0) {
        // starting from "all selected" state: select everything except this one
        folders.forEach((f) => next.add(f));
      }
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }

  function toggleExtension(extension: string) {
    setSelectedExtensions((prev) => {
      const next = new Set(prev);
      if (next.size === 0) {
        extensions.forEach((e) => next.add(e));
      }
      if (next.has(extension)) next.delete(extension);
      else next.add(extension);
      return next;
    });
  }

  const filteredFiles = useMemo(() => {
    if (!graph) return [];
    return graph.nodes.filter((n) => {
      if (selectedFolders.size > 0 && !selectedFolders.has(n.folder)) return false;
      if (selectedExtensions.size > 0 && !selectedExtensions.has(n.extension)) return false;
      if (cyclesOnly && !cycleNodeIds.has(n.id)) return false;
      if (apiOnly && !apiNodeIds.has(n.id)) return false;
      return true;
    });
  }, [graph, selectedFolders, selectedExtensions, cyclesOnly, cycleNodeIds, apiOnly, apiNodeIds]);

  const fileIdSet = useMemo(() => new Set(filteredFiles.map((n) => n.id)), [filteredFiles]);

  // Only keep endpoints still reachable from a visible caller, so filtering
  // files doesn't strand orphan endpoint bubbles on the canvas.
  const filteredApiCalls = useMemo(() => {
    if (!graph) return [];
    if (cyclesOnly) return [];
    return graph.apiCalls.filter((c) => fileIdSet.has(c.source));
  }, [graph, fileIdSet, cyclesOnly]);

  const filteredEndpoints = useMemo(() => {
    if (!graph) return [];
    const referenced = new Set(filteredApiCalls.map((c) => c.target));
    return graph.endpoints.filter((e) => referenced.has(e.id));
  }, [graph, filteredApiCalls]);

  const filteredImports = useMemo(() => {
    if (!graph) return [];
    if (apiOnly) return [];
    return graph.edges.filter((e) => {
      if (!fileIdSet.has(e.source) || !fileIdSet.has(e.target)) return false;
      if (cyclesOnly && !e.inCycle) return false;
      return true;
    });
  }, [graph, fileIdSet, cyclesOnly, apiOnly]);

  // An API call can target a file that the current filters hid; drop those so
  // every link has both endpoints present in the node set.
  const visibleNodes = useMemo(
    () => toGraphNodes(filteredFiles, filteredEndpoints),
    [filteredFiles, filteredEndpoints]
  );
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const visibleLinks = useMemo(
    () =>
      toGraphLinks(
        filteredImports,
        filteredApiCalls.filter((c) => visibleNodeIds.has(c.target))
      ),
    [filteredImports, filteredApiCalls, visibleNodeIds]
  );

  const selectedNode = useMemo(
    () => (selectedId ? visibleNodes.find((n) => n.id === selectedId) ?? null : null),
    [selectedId, visibleNodes]
  );
  const selectedLink = useMemo(
    () => (selectedLinkId ? visibleLinks.find((l) => l.linkId === selectedLinkId) ?? null : null),
    [selectedLinkId, visibleLinks]
  );

  const neighborIds = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const ids = new Set<string>();
    visibleLinks.forEach((l) => {
      if (l.source === selectedId) ids.add(l.target);
      if (l.target === selectedId) ids.add(l.source);
    });
    return ids;
  }, [selectedId, visibleLinks]);

  const incomingCount = useMemo(
    () => (selectedId ? visibleLinks.filter((l) => l.target === selectedId).length : 0),
    [visibleLinks, selectedId]
  );
  const outgoingCount = useMemo(
    () => (selectedId ? visibleLinks.filter((l) => l.source === selectedId).length : 0),
    [visibleLinks, selectedId]
  );

  function handleSelectNode(node: GraphNode | null) {
    setSelectedId(node ? node.id : null);
    setSelectedLinkId(null);
  }

  function handleSelectLink(link: GraphLink | null) {
    setSelectedLinkId(link ? link.linkId : null);
    setSelectedId(null);
  }

  if (!graph) {
    return <div className="empty-state">Loading graph...</div>;
  }

  return (
    <div className="app">
      <TopBar
        search={search}
        onSearchChange={setSearch}
        folders={folders}
        selectedFolders={selectedFolders}
        onToggleFolder={toggleFolder}
        extensions={extensions}
        selectedExtensions={selectedExtensions}
        onToggleExtension={toggleExtension}
        cyclesOnly={cyclesOnly}
        onToggleCyclesOnly={() => {
          setCyclesOnly((v) => !v);
          setApiOnly(false);
        }}
        apiOnly={apiOnly}
        onToggleApiOnly={() => {
          setApiOnly((v) => !v);
          setCyclesOnly(false);
        }}
      />

      <div className="canvas-layer">
        <GraphCanvas
          nodes={visibleNodes}
          links={visibleLinks}
          width={viewport.width}
          height={viewport.height}
          search={search}
          selectedId={selectedId}
          selectedLinkId={selectedLinkId}
          neighborIds={neighborIds}
          onSelectNode={handleSelectNode}
          onSelectLink={handleSelectLink}
        />
      </div>

      <StatsOverlay stats={graph.stats} folders={folders} />

      {(selectedNode || selectedLink) && (
        <SidePanel
          key={selectedNode ? selectedNode.id : selectedLink!.linkId}
          node={selectedNode}
          link={selectedLink}
          incomingCount={incomingCount}
          outgoingCount={outgoingCount}
        />
      )}
    </div>
  );
}
