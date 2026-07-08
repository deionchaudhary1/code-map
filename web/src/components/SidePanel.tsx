import { useState } from "react";
import type { FileNode, SymbolGraph } from "../types";
import { fetchSymbolGraph, humanFileSize } from "../api";

interface SidePanelProps {
  node: FileNode;
  incomingCount: number;
  outgoingCount: number;
}

export default function SidePanel({ node, incomingCount, outgoingCount }: SidePanelProps) {
  const [symbolGraph, setSymbolGraph] = useState<SymbolGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExpand() {
    setLoading(true);
    setError(null);
    try {
      const graph = await fetchSymbolGraph(node.id);
      setSymbolGraph(graph);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load symbols");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="side-panel">
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
        <span>Incoming imports</span>
        <span>{incomingCount}</span>
      </div>
      <div className="row">
        <span>Outgoing imports</span>
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

      {error && <div style={{ color: "#d65b5b", marginTop: 8 }}>{error}</div>}

      {symbolGraph && (
        <>
          <div className="section-label">
            Symbols ({symbolGraph.nodes.length})
          </div>
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
                  {localCalls.length > 0 && (
                    <div className="calls">calls: {localCalls.join(", ")}</div>
                  )}
                  {externalCalls.length > 0 && (
                    <div className="calls">external: {externalCalls.join(", ")}</div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
