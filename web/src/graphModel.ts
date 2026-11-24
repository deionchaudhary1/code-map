// Unifies the two node kinds (source files, HTTP endpoints) and the two link
// kinds (imports, API calls) the canvas has to draw, so the force simulation
// can treat them as one graph while rendering stays discriminated by `kind`.

import type { ApiCallEdge, EndpointNode, FileNode, ImportEdge, TopicNode } from "./types";

export type GraphNode =
  | ({ kind: "file" } & FileNode)
  | ({ kind: "endpoint" } & EndpointNode)
  | ({ kind: "topic" } & TopicNode);

/** Topic -> member file. Carries no analyzer data; it exists to draw. */
export interface MembershipLink {
  kind: "membership";
  linkId: string;
  /** TopicNode.id */
  source: string;
  /** FileNode.id */
  target: string;
}

export type GraphLink =
  | ({ kind: "import"; linkId: string } & ImportEdge)
  | ({ kind: "api"; linkId: string } & ApiCallEdge)
  | MembershipLink;

export function importLinkId(edge: ImportEdge): string {
  return `import::${edge.source}::${edge.target}`;
}

export function toTopicNodes(topics: TopicNode[]): GraphNode[] {
  return topics.map((t) => ({ kind: "topic" as const, ...t }));
}

/** One link per member, restricted to files that survived the filters. */
export function toMembershipLinks(topics: TopicNode[], visibleFileIds: Set<string>): GraphLink[] {
  const links: GraphLink[] = [];
  for (const topic of topics) {
    for (const member of topic.members) {
      if (!visibleFileIds.has(member)) continue;
      links.push({
        kind: "membership",
        linkId: `membership::${topic.id}::${member}`,
        source: topic.id,
        target: member,
      });
    }
  }
  return links;
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

/** Display label for a node of any kind. */
export function nodeLabel(node: GraphNode): string {
  if (node.kind === "file") return node.id;
  if (node.kind === "topic") return node.name;
  return `${node.method} ${node.url}`;
}
