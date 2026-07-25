import { useState } from "react";
import type { ExplainTarget, SymbolGraph } from "../types";
import type { GraphLink, GraphNode } from "../graphModel";
import {
  fetchExplainContext,
  fetchExplanation,
  fetchSymbolGraph,
  humanFileSize,
  type ApiPrefix,
} from "../api";
import { generate, OllamaError } from "../ollamaClient";
import { useOllamaConfig } from "../OllamaConfigContext";

interface SidePanelProps {
  node: GraphNode | null;
  link: GraphLink | null;
  incomingCount: number;
  outgoingCount: number;
  prefix: ApiPrefix;
  hosted: boolean;
  onOpenSettings: () => void;
}

/**
 * Hosted mode has no server-side explanation cache — the server never sees the
 * generated text. Keyed the same way the server keys its own cache, using the
 * cacheKey it hands back, so the two stay consistent.
 */
const explanationCache = new Map<string, string>();

/** The thing currently selected, expressed as an /api/explain request body. */
function explainTargetFor(node: GraphNode | null, link: GraphLink | null): ExplainTarget | null {
  if (link) {
    if (link.kind === "api") return { kind: "apiCall", id: link.id };
    return { kind: "import", source: link.source, target: link.target };
  }
  if (node && node.kind === "file") return { kind: "node", id: node.id };
  return null;
}

function ExplainSection({
  target,
  prefix,
  hosted,
  onOpenSettings,
}: {
  target: ExplainTarget;
  prefix: ApiPrefix;
  hosted: boolean;
  onOpenSettings: () => void;
}) {
  const { host, model } = useOllamaConfig();
  const [explanation, setExplanation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOriginHelp, setShowOriginHelp] = useState(false);

  async function handleExplain() {
    setLoading(true);
    setError(null);
    setShowOriginHelp(false);
    try {
      if (!hosted) {
        const result = await fetchExplanation(prefix, target);
        setExplanation(result.explanation);
        return;
      }

      // Hosted: the server builds the prompt, this browser runs the model.
      const context = await fetchExplainContext(prefix, target);
      const cacheKey = `${model}::${context.cacheKey}`;
      const hit = explanationCache.get(cacheKey);
      if (hit) {
        setExplanation(hit);
        return;
      }

      const text = await generate({
        host,
        model,
        prompt: context.prompt,
        system: context.system,
      });
      explanationCache.set(cacheKey, text);
      setExplanation(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate explanation");
      if (err instanceof OllamaError && err.likelyCors) setShowOriginHelp(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {!explanation && (
        <button className="expand-btn explain" onClick={handleExplain} disabled={loading}>
          {loading ? "Asking the model…" : "Explain this connection"}
        </button>
      )}
      {error && <div className="explain-error">{error}</div>}
      {showOriginHelp && (
        <button className="expand-btn" onClick={onOpenSettings}>
          Check Ollama settings
        </button>
      )}
      {explanation && (
        <>
          <div className="section-label">Explanation</div>
          <div className="explanation">{explanation}</div>
        </>
      )}
    </>
  );
}

function LinkDetails({ link }: { link: GraphLink }) {
  if (link.kind === "api") {
    const isExternal = link.target.startsWith("endpoint::");
    return (
      <>
        <h2>
          {link.method} {link.url}
        </h2>
        <div className="row">
          <span>Type</span>
          <span>API call</span>
        </div>
        <div className="row">
          <span>Client</span>
          <span>{link.client}</span>
        </div>
        <div className="row">
          <span>From</span>
          <span className="mono">
            {link.source}:{link.line}
          </span>
        </div>
        <div className="row">
          <span>Handled by</span>
          <span className="mono">{isExternal ? "not in this repo" : link.target}</span>
        </div>
        {link.isDynamic && (
          <div className="row">
            <span>URL</span>
            <span>built at runtime</span>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <h2>
        {link.source} → {link.target}
      </h2>
      <div className="row">
        <span>Type</span>
        <span>{link.isTypeOnly ? "type-only import" : "import"}</span>
      </div>
      <div className="row">
        <span>In cycle</span>
        <span>{link.inCycle ? "yes" : "no"}</span>
      </div>
      <div className="section-label">Imported symbols ({link.importedSymbols.length})</div>
      {link.importedSymbols.length > 0 ? (
        <ul className="exports-list">
          {link.importedSymbols.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : (
        <div style={{ color: "#7d7d7d" }}>none recorded</div>
      )}
    </>
  );
}

function EndpointDetails({ node }: { node: Extract<GraphNode, { kind: "endpoint" }> }) {
  return (
    <>
      <h2>
        {node.method} {node.url}
      </h2>
      <div className="row">
        <span>Type</span>
        <span>HTTP endpoint</span>
      </div>
      <div className="row">
        <span>Handler</span>
        <span>not found in this repo</span>
      </div>
      <p className="hint">
        No route registration matched this URL, so it likely belongs to an external service or a
        server outside this project.
      </p>
    </>
  );
}

function FileDetails({
  node,
  incomingCount,
  outgoingCount,
  prefix,
}: {
  node: Extract<GraphNode, { kind: "file" }>;
  incomingCount: number;
  outgoingCount: number;
  prefix: ApiPrefix;
}) {
  const [symbolGraph, setSymbolGraph] = useState<SymbolGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExpand() {
    setLoading(true);
    setError(null);
    try {
      setSymbolGraph(await fetchSymbolGraph(prefix, node.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load symbols");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h2>{node.id}</h2>

      <div className="row">
        <span>Size</span>
        <span>{humanFileSize(node.sizeBytes)}</span>
      </div>
      <div className="row">
        <span>Extension</span>
        <span>{node.extension}</span>
      </div>
      <div className="row">
        <span>Folder</span>
        <span>{node.folder}</span>
      </div>
      <div className="row">
        <span>Entry point</span>
        <span>{node.isEntryPoint ? "yes" : "no"}</span>
      </div>
      <div className="row">
        <span>Incoming</span>
        <span>{incomingCount}</span>
      </div>
      <div className="row">
        <span>Outgoing</span>
        <span>{outgoingCount}</span>
      </div>

      <div className="section-label">Exports ({node.exports.length})</div>
      {node.exports.length > 0 ? (
        <ul className="exports-list">
          {node.exports.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : (
        <div style={{ color: "#7d7d7d" }}>none</div>
      )}

      {!symbolGraph && (
        <button className="expand-btn" onClick={handleExpand} disabled={loading}>
          {loading ? "Loading..." : "Expand into functions"}
        </button>
      )}

      {error && <div className="explain-error">{error}</div>}

      {symbolGraph && (
        <>
          <div className="section-label">Symbols ({symbolGraph.nodes.length})</div>
          <div className="symbol-list">
            {symbolGraph.nodes.map((sym) => {
              const localCalls = symbolGraph.edges
                .filter((e) => e.source === sym.id && !e.isExternalCall)
                .map((e) => symbolGraph.nodes.find((n) => n.id === e.target)?.name ?? e.target);
              const externalCalls = symbolGraph.edges
                .filter((e) => e.source === sym.id && e.isExternalCall)
                .map((e) => e.target);

              return (
                <div className="symbol-item" key={sym.id}>
                  <span className="name">{sym.name}</span>
                  <span className="kind">{sym.kind}</span>
                  {sym.isExported && <span className="kind">exported</span>}
                  {localCalls.length > 0 && <div className="calls">calls: {localCalls.join(", ")}</div>}
                  {externalCalls.length > 0 && (
                    <div className="calls">external: {externalCalls.join(", ")}</div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

export default function SidePanel({
  node,
  link,
  incomingCount,
  outgoingCount,
  prefix,
  hosted,
  onOpenSettings,
}: SidePanelProps) {
  const explainTarget = explainTargetFor(node, link);

  return (
    <div className="side-panel">
      {link && <LinkDetails link={link} />}
      {!link && node?.kind === "file" && (
        <FileDetails
          node={node}
          incomingCount={incomingCount}
          outgoingCount={outgoingCount}
          prefix={prefix}
        />
      )}
      {!link && node?.kind === "endpoint" && <EndpointDetails node={node} />}

      {explainTarget && (
        <ExplainSection
          target={explainTarget}
          prefix={prefix}
          hosted={hosted}
          onOpenSettings={onOpenSettings}
        />
      )}
    </div>
  );
}
