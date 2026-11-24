import { useEffect, useMemo, useState } from "react";
import type { AppConfig, FileGraph, SessionResponse, TopicSet } from "./types";
import {
  fetchConfig,
  fetchFileGraphOrMock,
  fetchTopicContext,
  fetchTopics,
  parseTopics,
  sessionPrefix,
  LOCAL_PREFIX,
  type ApiPrefix,
} from "./api";
import {
  toGraphLinks,
  toGraphNodes,
  toMembershipLinks,
  toTopicNodes,
  type GraphLink,
  type GraphNode,
} from "./graphModel";
import { buildTopicIndex } from "./topics";
import { generate } from "./ollamaClient";
import TopBar from "./components/TopBar";
import StatsOverlay from "./components/StatsOverlay";
import SidePanel from "./components/SidePanel";
import GraphCanvas from "./components/GraphCanvas";
import UploadScreen from "./components/UploadScreen";
import OllamaSettings from "./components/OllamaSettings";
import { OllamaConfigProvider } from "./OllamaConfigContext";
import { useLayout } from "./layout/useLayout";
import type { Direction } from "./layout/elk";

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [graph, setGraph] = useState<FileGraph | null>(null);
  const [search, setSearch] = useState("");
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [selectedExtensions, setSelectedExtensions] = useState<Set<string>>(new Set());
  const [cyclesOnly, setCyclesOnly] = useState(false);
  const [apiOnly, setApiOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [runtimeMode, setRuntimeMode] = useState(false);
  const [hideUnexecuted, setHideUnexecuted] = useState(false);
  const [topics, setTopics] = useState<TopicSet | null>(null);
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [topicsError, setTopicsError] = useState<string | null>(null);
  const [topicMode, setTopicMode] = useState(false);
  const [direction, setDirection] = useState<Direction>("DOWN");
  const [uniformWidth, setUniformWidth] = useState(true);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });

  // Which server this build is talking to is a runtime question, so that one
  // web/dist can be served by either the local CLI or the hosted server.
  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      // Treat an unreachable /api/config as local mode so `vite dev` against
      // the mock graph keeps working exactly as before.
      .catch((err) => {
        console.warn("Could not read /api/config, assuming local mode:", err);
        setConfig({ mode: "local", aiEnabled: true, ollamaModel: "llama3.1:8b" });
      });
  }, []);

  useEffect(() => {
    if (config?.mode !== "local") return;
    fetchFileGraphOrMock(LOCAL_PREFIX).then(setGraph);
  }, [config?.mode]);

  const apiPrefix: ApiPrefix | null = useMemo(() => {
    if (!config) return null;
    if (config.mode === "local") return LOCAL_PREFIX;
    return sessionId ? sessionPrefix(sessionId) : null;
  }, [config, sessionId]);

  function handleSessionReady(session: SessionResponse) {
    setSessionId(session.sessionId);
    setGraph(session.graph);
    setSelectedId(null);
    setSelectedLinkId(null);
  }

  /**
   * Local mode has the server run the model; hosted mode can only reach the
   * user's Ollama from this browser, so the server hands over the prompt and
   * takes the raw reply back for parsing. `host`/`model` come from TopBar,
   * which sits inside OllamaConfigProvider — App renders that provider and so
   * cannot read the context itself.
   */
  async function handleGenerateTopics(host: string, model: string) {
    if (!apiPrefix || topicsLoading) return;
    setTopicsLoading(true);
    setTopicsError(null);
    try {
      if (config?.mode !== "hosted") {
        setTopics(await fetchTopics(apiPrefix));
      } else {
        const context = await fetchTopicContext(apiPrefix);
        const raw = await generate({
          host,
          model,
          prompt: context.prompt,
          system: context.system,
          format: "json",
          numPredict: context.numPredict,
        });
        setTopics(await parseTopics(apiPrefix, raw, model));
      }
      setTopicMode(true);
      // Topic colors and runtime heat both own the node border; showing them
      // at once would make each unreadable.
      setRuntimeMode(false);
    } catch (err) {
      setTopicsError(err instanceof Error ? err.message : "Could not group files into topics");
    } finally {
      setTopicsLoading(false);
    }
  }

  function handleReset() {
    if (sessionId) {
      // Best-effort: frees the server's temp dir now instead of at TTL.
      void fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(
        () => {},
      );
    }
    setSessionId(null);
    setGraph(null);
    setSelectedId(null);
    setSelectedLinkId(null);
    // Topics describe the old project's files and mean nothing for the next one.
    setTopics(null);
    setTopicMode(false);
    setTopicsError(null);
  }

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

  const runtime = graph?.runtime ?? null;

  /** Turning runtime mode on by default would be surprising; opt in, but only offer it when a trace exists. */
  const executedIds = useMemo(
    () => new Set(runtime?.executedFiles ?? []),
    [runtime]
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
      if (runtimeMode && hideUnexecuted && !executedIds.has(n.id)) return false;
      return true;
    });
  }, [
    graph, selectedFolders, selectedExtensions, cyclesOnly, cycleNodeIds, apiOnly, apiNodeIds,
    runtimeMode, hideUnexecuted, executedIds,
  ]);

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

  const topicIndex = useMemo(
    () => (topicMode ? buildTopicIndex(topics) : null),
    [topicMode, topics]
  );

  /** Only topics with a member still on screen; the rest would be empty hubs. */
  const visibleTopics = useMemo(() => {
    if (!topicIndex) return [];
    return topicIndex.views
      .map((v) => v.topic)
      .filter((t) => t.members.some((m) => fileIdSet.has(m)));
  }, [topicIndex, fileIdSet]);

  // An API call can target a file that the current filters hid; drop those so
  // every link has both endpoints present in the node set.
  const visibleNodes = useMemo(
    () => [...toGraphNodes(filteredFiles, filteredEndpoints), ...toTopicNodes(visibleTopics)],
    [filteredFiles, filteredEndpoints, visibleTopics]
  );
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const visibleLinks = useMemo(
    () => [
      ...toGraphLinks(
        filteredImports,
        filteredApiCalls.filter((c) => visibleNodeIds.has(c.target))
      ),
      ...toMembershipLinks(visibleTopics, fileIdSet),
    ],
    [filteredImports, filteredApiCalls, visibleNodeIds, visibleTopics, fileIdSet]
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

  // Membership links are excluded: they are a drawing device, not a dependency,
  // and counting them would inflate every file's inbound count by one.
  const incomingCount = useMemo(
    () =>
      selectedId
        ? visibleLinks.filter((l) => l.kind !== "membership" && l.target === selectedId).length
        : 0,
    [visibleLinks, selectedId]
  );
  const outgoingCount = useMemo(
    () =>
      selectedId
        ? visibleLinks.filter((l) => l.kind !== "membership" && l.source === selectedId).length
        : 0,
    [visibleLinks, selectedId]
  );

  const layoutOptions = useMemo(() => ({ direction, uniformWidth }), [direction, uniformWidth]);
  const layout = useLayout(visibleNodes, visibleLinks, layoutOptions);

  function handleSelectNode(node: GraphNode | null) {
    setSelectedId(node ? node.id : null);
    setSelectedLinkId(null);
  }

  function handleSelectLink(link: GraphLink | null) {
    // A membership line has nothing of its own to say; clicking one is a
    // clumsy way of reaching for the topic it belongs to.
    if (link?.kind === "membership") {
      // force-graph hands back its own copy, whose `source` it has already
      // replaced with the node object.
      const source: unknown = link.source;
      setSelectedId(typeof source === "string" ? source : ((source as GraphNode)?.id ?? null));
      setSelectedLinkId(null);
      return;
    }
    setSelectedLinkId(link ? link.linkId : null);
    setSelectedId(null);
  }

  if (!config) {
    return <div className="empty-state">Starting…</div>;
  }

  if (config.mode === "hosted" && !graph) {
    return (
      <OllamaConfigProvider defaultModel={config.ollamaModel}>
        <UploadScreen maxUploadBytes={config.maxUploadBytes} onReady={handleSessionReady} />
      </OllamaConfigProvider>
    );
  }

  if (!graph || !apiPrefix) {
    return <div className="empty-state">Loading graph...</div>;
  }

  return (
    <OllamaConfigProvider defaultModel={config.ollamaModel}>
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
        direction={direction}
        onToggleDirection={() => setDirection((d) => (d === "DOWN" ? "RIGHT" : "DOWN"))}
        uniformWidth={uniformWidth}
        onToggleUniformWidth={() => setUniformWidth((v) => !v)}
        aiEnabled={config.mode === "hosted" || config.aiEnabled}
        hasTopics={topics !== null}
        topicMode={topicMode}
        topicsLoading={topicsLoading}
        topicsError={topicsError}
        onGenerateTopics={handleGenerateTopics}
        onToggleTopicMode={() => setTopicMode((v) => !v)}
        hasRuntime={runtime !== null}
        runtimeMode={runtimeMode}
        onToggleRuntimeMode={() => {
          setRuntimeMode((v) => !v);
          setTopicMode(false);
        }}
        hideUnexecuted={hideUnexecuted}
        onToggleHideUnexecuted={() => setHideUnexecuted((v) => !v)}
        hosted={config.mode === "hosted"}
        onOpenSettings={() => setShowSettings(true)}
        onReset={handleReset}
      />

      <div className="canvas-layer">
        {layout.result && (
        <GraphCanvas
          nodes={visibleNodes}
          links={visibleLinks}
          layout={layout.result}
          width={viewport.width}
          height={viewport.height}
          search={search}
          selectedId={selectedId}
          selectedLinkId={selectedLinkId}
          neighborIds={neighborIds}
          onSelectNode={handleSelectNode}
          onSelectLink={handleSelectLink}
          runtimeMode={runtimeMode}
          executedIds={executedIds}
          fileHits={runtime?.fileHits ?? {}}
          topicIndex={topicIndex}
        />
        )}
        {layout.status === "pending" && <div className="layout-status">Laying out…</div>}
        {layout.status === "failed" && (
          <div className="layout-status error">Layout failed: {layout.error}</div>
        )}
      </div>

      <StatsOverlay
        stats={graph.stats}
        folders={folders}
        layerCount={layout.result?.layerCount ?? 0}
        runtime={runtime}
        runtimeMode={runtimeMode}
        topicIndex={topicIndex}
        unassignedCount={topicMode ? (topics?.unassigned.length ?? 0) : 0}
      />

      {(selectedNode || selectedLink) && (
        <SidePanel
          key={selectedNode ? selectedNode.id : selectedLink!.linkId}
          node={selectedNode}
          link={selectedLink}
          incomingCount={incomingCount}
          outgoingCount={outgoingCount}
          prefix={apiPrefix}
          hosted={config.mode === "hosted"}
          onOpenSettings={() => setShowSettings(true)}
          runtime={runtime}
          topicIndex={topicIndex}
          onSelectFile={(id) => setSelectedId(id)}
        />
      )}

      {showSettings && <OllamaSettings onClose={() => setShowSettings(false)} />}
    </div>
    </OllamaConfigProvider>
  );
}
