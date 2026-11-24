// Builds the ELK layout request from the visible graph, runs it in a worker,
// and converts the result into the coordinate space the canvas draws in.

import ELKBundle from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkInstance, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { GraphLink, GraphNode } from "../graphModel";
import { measureNodes, type NodeBox } from "./measure";

// elk.bundled.js bundles ELK together with its worker and, on the main thread,
// spins up that worker itself from an inline blob — so layout still runs off
// the main thread without us nesting it inside a second worker (which fails:
// the inner Worker constructor isn't available in that context).
// The bundle reassigns module.exports after setting __esModule, so the default
// interop can land the namespace object rather than the constructor.
const ELK = ((ELKBundle as unknown as { default?: unknown }).default ??
  ELKBundle) as new () => ElkInstance;

let elkInstance: ElkInstance | null = null;
function getElk(): ElkInstance {
  if (!elkInstance) elkInstance = new ELK();
  return elkInstance;
}

export type Direction = "DOWN" | "RIGHT";

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  direction: Direction;
  uniformWidth: boolean;
}

export interface LayoutResult {
  /** Node id -> box *centre*, since the canvas draws nodes centred. */
  positions: Map<string, Point>;
  /** linkId -> orthogonal polyline from source boundary to target boundary. */
  routes: Map<string, Point[]>;
  boxes: Map<string, NodeBox>;
  /** Number of distinct rows (or columns, laid out sideways). */
  layerCount: number;
}

const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "34",
  "elk.spacing.nodeNode": "14",
  "elk.spacing.edgeNode": "8",
  "elk.spacing.edgeEdge": "6",
  "elk.layered.spacing.edgeNodeBetweenLayers": "8",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  // Without this, equivalent graphs can lay out differently between runs.
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
};

/** Gap between a hub and the member box it is nudged away from. */
const HUB_CLEARANCE = 6;

/**
 * Places topic hubs after ELK has run, at the centroid of their members.
 *
 * Feeding membership edges to ELK instead is the obvious implementation and it
 * ruins the diagram: the layered algorithm pulls every hub into the first layer
 * and every file into the second, collapsing the import hierarchy that is the
 * graph's whole point. Placing hubs afterwards leaves ELK's input byte-identical
 * to what it was before topics existed, so toggling topic mode cannot change the
 * import layout at all.
 */
function placeTopicHubs(
  topicNodes: GraphNode[],
  boxes: Map<string, NodeBox>,
  positions: Map<string, Point>,
): void {
  // Starts as the file/endpoint boxes ELK placed; each hub is appended once it
  // settles, so later hubs also avoid earlier ones. Without that, topics whose
  // members share a region land on the same spot and render as one unreadable
  // stack of overlapping labels.
  const occupied = [...positions.entries()].map(([id, point]) => ({
    point,
    box: boxes.get(id)!,
  }));

  for (const node of topicNodes) {
    if (node.kind !== "topic") continue;
    const memberPoints = node.members
      .map((id) => positions.get(id))
      .filter((p): p is Point => p !== undefined);
    if (memberPoints.length === 0) continue;

    const centroid = {
      x: memberPoints.reduce((sum, p) => sum + p.x, 0) / memberPoints.length,
      y: memberPoints.reduce((sum, p) => sum + p.y, 0) / memberPoints.length,
    };

    // A centroid almost always lands on top of a member. Lift the hub above the
    // topic's own highest member instead, which also reads as a heading.
    const hubBox = boxes.get(node.id)!;
    const topMost = Math.min(...memberPoints.map((p) => p.y));
    let y = topMost - hubBox.h - HUB_CLEARANCE;

    // Then walk upward until nothing overlaps — cheap, and bounded because
    // each step clears at least one box height.
    for (let attempt = 0; attempt < 40; attempt++) {
      const collision = occupied.find(
        ({ point, box }) =>
          Math.abs(point.x - centroid.x) < (box.w + hubBox.w) / 2 + HUB_CLEARANCE &&
          Math.abs(point.y - y) < (box.h + hubBox.h) / 2 + HUB_CLEARANCE,
      );
      if (!collision) break;
      y = collision.point.y - collision.box.h / 2 - hubBox.h / 2 - HUB_CLEARANCE;
    }

    const placed = { x: centroid.x, y };
    positions.set(node.id, placed);
    occupied.push({ point: placed, box: hubBox });
  }
}

/** Concatenates an edge's sections into a single polyline. */
function sectionsToPolyline(edge: ElkExtendedEdge): Point[] {
  const points: Point[] = [];
  for (const section of edge.sections ?? []) {
    const segment = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    for (const point of segment) {
      const last = points[points.length - 1];
      if (last && last.x === point.x && last.y === point.y) continue;
      points.push({ x: point.x, y: point.y });
    }
  }
  return points;
}

export async function layoutGraph(
  nodes: GraphNode[],
  links: GraphLink[],
  options: LayoutOptions
): Promise<LayoutResult> {
  const boxes = measureNodes(nodes, options.uniformWidth);
  if (nodes.length === 0) {
    return { positions: new Map(), routes: new Map(), boxes, layerCount: 0 };
  }

  // Topic hubs and their membership edges are held back from ELK entirely and
  // positioned afterwards — see placeTopicHubs.
  const laidOutNodes = nodes.filter((n) => n.kind !== "topic");
  const topicNodes = nodes.filter((n) => n.kind === "topic");
  const nodeIds = new Set(laidOutNodes.map((n) => n.id));
  const request: ElkNode = {
    id: "root",
    layoutOptions: { ...LAYOUT_OPTIONS, "elk.direction": options.direction },
    children: laidOutNodes.map((node) => {
      const box = boxes.get(node.id)!;
      return { id: node.id, width: box.w, height: box.h };
    }),
    edges: links
      // A link whose endpoints aren't both visible would make ELK throw.
      .filter((link) => nodeIds.has(link.source) && nodeIds.has(link.target))
      .map((link) => ({
        id: link.linkId,
        sources: [link.source],
        targets: [link.target],
      })),
  };

  const laid = await getElk().layout(request);

  // ELK works in a positive quadrant with top-left node origins; the canvas
  // draws centred boxes, and keeping coordinates around 0 plays better with
  // the force-graph viewport.
  const shiftX = (laid.width ?? 0) / 2;
  const shiftY = (laid.height ?? 0) / 2;

  const positions = new Map<string, Point>();
  for (const child of laid.children ?? []) {
    const box = boxes.get(child.id);
    if (!box) continue;
    positions.set(child.id, {
      x: (child.x ?? 0) + box.w / 2 - shiftX,
      y: (child.y ?? 0) + box.h / 2 - shiftY,
    });
  }

  const routes = new Map<string, Point[]>();
  for (const edge of (laid.edges ?? []) as ElkExtendedEdge[]) {
    const polyline = sectionsToPolyline(edge);
    if (polyline.length < 2) continue;
    routes.set(
      edge.id,
      polyline.map((p) => ({ x: p.x - shiftX, y: p.y - shiftY }))
    );
  }

  // Hubs must be placed after member positions are known. Membership links need
  // no routes: the canvas already falls back to a straight boundary-to-boundary
  // line for any link ELK did not route, which is exactly what they want.
  placeTopicHubs(topicNodes, boxes, positions);

  // Layer index isn't reported, but every node in a layer shares its position
  // along the flow axis, so counting distinct values recovers the depth.
  const axis = new Set<number>();
  for (const child of laid.children ?? []) {
    axis.add(Math.round((options.direction === "DOWN" ? child.y : child.x) ?? 0));
  }

  return { positions, routes, boxes, layerCount: axis.size };
}
