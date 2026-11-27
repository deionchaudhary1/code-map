import { useEffect, useState } from "react";
import type { HostMessage } from "../../../extension/src/protocol";
import { nodeLabel, type GraphLink, type GraphNode } from "../graphModel";
import type { RouteDefinition, SymbolKind } from "../types";
import { post, subscribe } from "./vscode";

type OpenSource = (fileId: string, line?: number) => void;
type Connection = Exclude<GraphLink, { kind: "membership" }>;
type SymbolReply = Extract<HostMessage, { type: "symbols" }>;

const SYMBOL_LABELS: Record<SymbolKind, string> = {
  function: "Function",
  class: "Class",
  method: "Method",
  "const-arrow-fn": "Function",
};

let lastRequestId = 0;

function atLine(fileId: string, line?: number): string {
  return line === undefined ? fileId : `${fileId}:${line}`;
}

interface InspectorProps {
  node: GraphNode | undefined;
  link: GraphLink | undefined;
  nodeById: Map<string, GraphNode>;
  links: GraphLink[];
  routes: RouteDefinition[];
  revision: number;
  openSource: OpenSource;
  inspectLink: (link: GraphLink) => void;
}

export default function Inspector({
  node,
  link,
  nodeById,
  links,
  routes,
  revision,
  openSource,
  inspectLink,
}: InspectorProps) {
  return (
    <aside className="inspector" aria-label="Inspector" tabIndex={0}>
      <div className="inspector-heading"><h2>Inspector</h2></div>
      {link && link.kind !== "membership" ? (
        <ConnectionDetails link={link} nodeById={nodeById} routes={routes} openSource={openSource} />
      ) : node ? (
        <>
          <div className="inspector-title">
            <h3>{nodeLabel(node)}</h3>
            {node.kind === "file" && (
              <button type="button" onClick={() => openSource(node.id)}>Open file</button>
            )}
          </div>
          {node.kind === "file" && (
            <FileDetails
              key={node.id}
              fileId={node.id}
              routes={routes.filter((route) => route.file === node.id)}
              revision={revision}
              openSource={openSource}
            />
          )}
          <Connections nodeId={node.id} nodeById={nodeById} links={links} select={inspectLink} />
        </>
      ) : (
        <p className="inspector-idle">Select a file or connection to inspect its source.</p>
      )}
    </aside>
  );
}

function FileDetails({
  fileId,
  routes,
  revision,
  openSource,
}: {
  fileId: string;
  routes: RouteDefinition[];
  revision: number;
  openSource: OpenSource;
}) {
  const [reply, setReply] = useState<{ attempt: number; message: SymbolReply } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const requestId = ++lastRequestId;
    const unsubscribe = subscribe((message) => {
      if (message.type === "symbols" && message.fileId === fileId &&
        message.requestId === requestId && message.revision === revision) {
        setReply({ attempt, message });
      }
    });
    post({ type: "symbols", fileId, requestId });
    return unsubscribe;
  }, [attempt, fileId, revision]);

  const result = reply?.message.revision === revision && reply.attempt === attempt
    ? reply.message
    : null;

  return (
    <>
      {routes.length > 0 && (
        <section className="inspector-section">
          <h4>Routes</h4>
          <ul className="inspector-list">
            {routes.map((route, index) => (
              <li key={index}>
                <InspectorButton
                  title={`${route.method} ${route.path}`}
                  detail={`Line ${route.line}`}
                  onClick={() => openSource(fileId, route.line)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="inspector-section">
        <h4>Symbols</h4>
        {!result ? <p className="muted" role="status">Loading symbols…</p> : result.error ? (
          <>
            <p className="error-text" role="alert">{result.error}</p>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry symbols</button>
          </>
        ) : result.graph?.nodes.length ? (
          <ul className="inspector-list">
            {result.graph.nodes.map((symbol, index) => (
              <li key={`${symbol.id}:${symbol.startLine}:${index}`}>
                <InspectorButton
                  title={symbol.name}
                  detail={`${SYMBOL_LABELS[symbol.kind]} · Line ${symbol.startLine}`}
                  onClick={() => openSource(fileId, symbol.startLine)}
                />
              </li>
            ))}
          </ul>
        ) : <p className="muted">No functions, classes, or methods found.</p>}
      </section>
    </>
  );
}

function Connections({
  nodeId,
  nodeById,
  links,
  select,
}: {
  nodeId: string;
  nodeById: Map<string, GraphNode>;
  links: GraphLink[];
  select: (link: Connection) => void;
}) {
  const incoming: Connection[] = [];
  const outgoing: Connection[] = [];
  for (const link of links) {
    if (link.kind === "membership") continue;
    if (link.target === nodeId) incoming.push(link);
    if (link.source === nodeId) outgoing.push(link);
  }

  function connectionList(connections: Connection[], heading: string, otherEnd: "source" | "target") {
    if (connections.length === 0) return null;
    return (
      <section className="inspector-section">
        <h4>{heading}</h4>
        <ul className="inspector-list">
          {connections.map((link) => {
            const otherNode = nodeById.get(link[otherEnd]);
            const otherLabel = otherNode ? nodeLabel(otherNode) : link[otherEnd];
            const line = link.line === undefined ? "" : ` · Line ${link.line}`;
            const title = link.kind === "api" ? `${link.method} ${link.url}` : otherLabel;
            const detail = link.kind === "api"
              ? `HTTP call · ${otherNode?.kind === "endpoint" ? "External endpoint" : otherLabel}${line}`
              : `${link.isTypeOnly ? "Type import" : "Import"}${line}`;

            return (
              <li key={link.linkId}>
                <InspectorButton title={title} detail={detail} onClick={() => select(link)} />
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  return (
    <>
      {connectionList(outgoing, "Outgoing", "target")}
      {connectionList(incoming, "Incoming", "source")}
    </>
  );
}

function ConnectionDetails({
  link,
  nodeById,
  routes,
  openSource,
}: {
  link: Connection;
  nodeById: Map<string, GraphNode>;
  routes: RouteDefinition[];
  openSource: OpenSource;
}) {
  const target = nodeById.get(link.target);
  const targetLine = link.kind === "api" ? link.targetLine : undefined;
  const route = targetLine === undefined
    ? undefined
    : routes.find((item) => item.file === link.target && item.line === targetLine);
  const title = link.kind === "api" ? `${link.method} ${link.url}` : "Import";

  return (
    <>
      <div className="inspector-title"><h3>{title}</h3></div>
      <section className="inspector-section">
        <h4>Source</h4>
        <InspectorButton
          title={link.kind === "api" ? "Open call site" : "Open import"}
          detail={atLine(link.source, link.line)}
          onClick={() => openSource(link.source, link.line)}
        />
      </section>
      <section className="inspector-section">
        <h4>Target</h4>
        {target?.kind === "file" ? (
          <InspectorButton
            title={route ? `Open ${route.method} ${route.path} route` : "Open target file"}
            detail={atLine(target.id, targetLine)}
            onClick={() => openSource(target.id, targetLine)}
          />
        ) : (
          <p className="muted">{target ? nodeLabel(target) : link.target}</p>
        )}
      </section>
      {link.kind === "import" && link.importedSymbols.length > 0 && (
        <section className="inspector-section">
          <h4>Imported names</h4>
          <p className="source-text">{link.importedSymbols.join(", ")}</p>
        </section>
      )}
    </>
  );
}

function InspectorButton({
  title,
  detail,
  onClick,
}: {
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button className="inspector-button" type="button" onClick={onClick}>
      <span className="inspector-button-title">{title}</span>
      <span className="inspector-button-detail">{detail}</span>
    </button>
  );
}
