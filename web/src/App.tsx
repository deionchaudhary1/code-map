import { useEffect, useMemo, useState } from "react";
import type { FileGraph, FileNode } from "./types";
import { fetchFileGraph } from "./api";
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const filteredNodes = useMemo(() => {
    if (!graph) return [];
    return graph.nodes.filter((n) => {
      if (selectedFolders.size > 0 && !selectedFolders.has(n.folder)) return false;
      if (selectedExtensions.size > 0 && !selectedExtensions.has(n.extension)) return false;
      if (cyclesOnly && !cycleNodeIds.has(n.id)) return false;
      return true;
    });
  }, [graph, selectedFolders, selectedExtensions, cyclesOnly, cycleNodeIds]);

  const filteredNodeIdSet = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);

  const filteredEdges = useMemo(() => {
    if (!graph) return [];
    return graph.edges.filter((e) => {
      if (!filteredNodeIdSet.has(e.source) || !filteredNodeIdSet.has(e.target)) return false;
      if (cyclesOnly && !e.inCycle) return false;
      return true;
    });
  }, [graph, filteredNodeIdSet, cyclesOnly]);

  const selectedNode = useMemo(
    () => (selectedId ? graph?.nodes.find((n) => n.id === selectedId) ?? null : null),
    [selectedId, graph]
  );

  const neighborIds = useMemo(() => {
    if (!selectedId || !graph) return new Set<string>();
    const ids = new Set<string>();
    graph.edges.forEach((e) => {
      if (e.source === selectedId) ids.add(e.target);
      if (e.target === selectedId) ids.add(e.source);
    });
    return ids;
  }, [selectedId, graph]);

  const incomingCount = useMemo(
    () => (graph && selectedId ? graph.edges.filter((e) => e.target === selectedId).length : 0),
    [graph, selectedId]
  );
  const outgoingCount = useMemo(
    () => (graph && selectedId ? graph.edges.filter((e) => e.source === selectedId).length : 0),
    [graph, selectedId]
  );

  function handleSelectNode(node: FileNode | null) {
    setSelectedId(node ? node.id : null);
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
        onToggleCyclesOnly={() => setCyclesOnly((v) => !v)}
      />

      <div className="canvas-layer">
        <GraphCanvas
          nodes={filteredNodes}
          edges={filteredEdges}
          width={viewport.width}
          height={viewport.height}
          search={search}
          selectedId={selectedId}
          neighborIds={neighborIds}
          onSelectNode={handleSelectNode}
        />
      </div>

      <StatsOverlay stats={graph.stats} folders={folders} />

      {selectedNode && (
        <SidePanel
          key={selectedNode.id}
          node={selectedNode}
          incomingCount={incomingCount}
          outgoingCount={outgoingCount}
        />
      )}
    </div>
  );
}
