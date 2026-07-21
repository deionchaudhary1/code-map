// Unifies the two node kinds (source files, HTTP endpoints) and the two link
// kinds (imports, API calls) the canvas has to draw, so the force simulation
// can treat them as one graph while rendering stays discriminated by `kind`.

import type { ApiCallEdge, EndpointNode, FileNode, ImportEdge } from "./types";

export type GraphNode =
  | ({ kind: "file" } & FileNode)
  | ({ kind: "endpoint" } & EndpointNode);

export type GraphLink =
  | ({ kind: "import"; linkId: string } & ImportEdge)
  | ({ kind: "api"; linkId: string } & ApiCallEdge);

export function importLinkId(edge: ImportEdge): string {
  return `import::${edge.source}::${edge.target}`;
}

export function toGraphNodes(files: FileNode[], endpoints: EndpointNode[]): GraphNode[] {
  return [
    ...files.map((f) => ({ kind: "file" as const, ...f })),
    ...endpoints.map((e) => ({ kind: "endpoint" as const, ...e })),
  ];
}

export function toGraphLinks(imports: ImportEdge[], apiCalls: ApiCallEdge[]): GraphLink[] {
  return [
    ...imports.map((e) => ({ kind: "import" as const, linkId: importLinkId(e), ...e })),
    ...apiCalls.map((c) => ({ kind: "api" as const, linkId: c.id, ...c })),
  ];
}

/** Display label for a node of either kind. */
export function nodeLabel(node: GraphNode): string {
  return node.kind === "file" ? node.id : `${node.method} ${node.url}`;
}
