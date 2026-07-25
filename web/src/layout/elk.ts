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

  const nodeIds = new Set(nodes.map((n) => n.id));
  const request: ElkNode = {
    id: "root",
    layoutOptions: { ...LAYOUT_OPTIONS, "elk.direction": options.direction },
    children: nodes.map((node) => {
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

  // Layer index isn't reported, but every node in a layer shares its position
  // along the flow axis, so counting distinct values recovers the depth.
  const axis = new Set<number>();
  for (const child of laid.children ?? []) {
    axis.add(Math.round((options.direction === "DOWN" ? child.y : child.x) ?? 0));
  }

  return { positions, routes, boxes, layerCount: axis.size };
}
