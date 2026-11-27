import { useEffect, useMemo, useRef } from "react";
import ForceGraph2D, { type NodeObject, type LinkObject } from "react-force-graph-2d";
import { nodeLabel, type GraphLink, type GraphNode } from "../graphModel";
import type { LayoutResult, Point } from "../layout/elk";
import {
  METHOD_FONT,
  LINE_GAP,
  PAD_Y,
  type NodeBox,
} from "../layout/measure";
import { colorForFolder } from "../palette";
import { topicColorForFile, type TopicIndex } from "../topics";

interface GraphCanvasProps {
  nodes: GraphNode[];
  links: GraphLink[];
  layout: LayoutResult;
  width: number;
  height: number;
  /** Fit after each layout update. Disable to fit once and then on demand. */
  autoFit?: boolean;
  fitVersion?: number;
  search: string;
  selectedId: string | null;
  selectedLinkId: string | null;
  neighborIds: Set<string>;
  onSelectNode: (node: GraphNode | null) => void;
  onSelectLink: (link: GraphLink | null) => void;
  /** When true, nodes are styled by whether they executed at runtime. */
  runtimeMode: boolean;
  executedIds: Set<string>;
  fileHits: Record<string, number>;
  /** Null unless topics have been generated and topic mode is on. */
  topicIndex: TopicIndex | null;
}

type PositionedNode = GraphNode & { x: number; y: number };

const CORNER_RADIUS = 2.5;
const ARROW_LENGTH = 4;
const NODE_REL_SIZE = 4;
const DEFAULT_BOX: NodeBox = {
  w: 24,
  h: 10,
  top: "",
  bottom: "",
  topFont: 3,
  bottomFont: 4.5,
};

const COLOR_BG = "#1d212a";
const COLOR_BG_SELECTED = "#262c38";
const COLOR_BORDER_SELECTED = "#e8eaed";
const COLOR_LABEL = "#e8eaed";
const COLOR_LABEL_DIR = "#8a8f98";
const COLOR_EDGE_DEFAULT = "#4a4f58";
const COLOR_EDGE_CYCLE = "#d65b5b";
const COLOR_API = "#e0883a";
const COLOR_ENDPOINT_BG = "#241d14";
const COLOR_UNEXECUTED = "#3a3f47";
const COLOR_HOT = "#5bbf8a";

/**
 * Hit counts are extremely long-tailed — an inner helper can run thousands of
 * times more than an entry point — so intensity is scaled logarithmically
 * against the busiest file rather than linearly.
 */
function heatFraction(hits: number, maxHits: number): number {
  if (hits <= 0 || maxHits <= 0) return 0;
  return Math.log10(1 + hits) / Math.log10(1 + maxHits);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Point where the ray from (cx,cy) toward (tx,ty) crosses the boundary of
 * the axis-aligned box of size `box` centered at (cx,cy). Only used for the
 * straight-line fallback when ELK returned no route for an edge. */
function boxBoundaryPoint(cx: number, cy: number, tx: number, ty: number, box: NodeBox): Point {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const halfW = box.w / 2;
  const halfH = box.h / 2;
  const scaleX = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  angle: number,
  length: number,
  color: string
) {
  const spread = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - length * Math.cos(angle - spread), tipY - length * Math.sin(angle - spread));
  ctx.lineTo(tipX - length * Math.cos(angle + spread), tipY - length * Math.sin(angle + spread));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** Midpoint of the longest segment — the only place on an orthogonal route
 * with room for a label. */
function longestSegmentMidpoint(points: Point[]): Point {
  let best = { x: points[0].x, y: points[0].y };
  let bestLength = -1;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > bestLength) {
      bestLength = length;
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return best;
}

function nodeBorderColor(node: GraphNode, topicIndex: TopicIndex | null): string {
  if (node.kind === "endpoint") return COLOR_API;
  if (node.kind === "topic") {
    return topicIndex?.byTopicId.get(node.id)?.color ?? COLOR_LABEL;
  }
  return topicIndex ? topicColorForFile(topicIndex, node.id) : colorForFolder(node.folder);
}

/** Membership lines sit under the import graph rather than competing with it —
 * 5 hubs times 60 members is a haystack at full strength. */
const MEMBERSHIP_ALPHA = 0.3;
const MEMBERSHIP_ALPHA_FOCUSED = 0.9;

/**
 * force-graph replaces a link's `source`/`target` strings with references to
 * the node objects once it ingests the data, so every read of them inside a
 * draw callback has to tolerate both forms. Import and API links happened to
 * survive this because they are drawn from an ELK route keyed by `linkId`;
 * membership links, which fall back to a straight line computed from the
 * endpoints, did not — they silently drew nothing.
 */
function endpointId(value: unknown): string {
  if (typeof value === "string") return value;
  return String((value as { id?: unknown })?.id ?? "");
}

/** Tints a #rrggbb toward transparency for hub fills. */
function withAlpha(hex: string, alpha: number): string {
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function GraphCanvas({
  nodes,
  links,
  layout,
  width,
  height,
  autoFit = true,
  fitVersion = 0,
  search,
  selectedId,
  selectedLinkId,
  neighborIds,
  onSelectNode,
  onSelectLink,
  runtimeMode,
  executedIds,
  fileHits,
  topicIndex,
}: GraphCanvasProps) {
  const fgRef = useRef<any>(null);
  const lastFitVersion = useRef<number | null>(null);
  const { positions, routes, boxes } = layout;
  const fitNodeValue = useMemo(() => (node: NodeObject<GraphNode>) => {
    const box = boxes.get(String(node.id)) ?? DEFAULT_BOX;
    // zoomToFit uses circular node bounds. Include the drawn box's width and
    // height so a small graph can fit without clipping its outermost labels.
    return (Math.max(box.w, box.h) / (2 * NODE_REL_SIZE)) ** 2;
  }, [boxes]);

  // A layout is always one render behind a filter change, so drop anything it
  // hasn't placed yet rather than drawing it at the origin.
  const graphData = useMemo(() => {
    const placed = nodes.filter((n) => positions.has(n.id));
    const placedIds = new Set(placed.map((n) => n.id));
    return {
      nodes: placed.map((n) => {
        const { x, y } = positions.get(n.id)!;
        // fx/fy pin the node: the simulation has nothing left to solve.
        return { ...n, x, y, fx: x, fy: y } as NodeObject<GraphNode>;
      }),
      links: links
        .filter((l) => placedIds.has(l.source) && placedIds.has(l.target))
        .map((l) => ({ ...l })) as LinkObject<GraphNode, GraphLink>[],
    };
  }, [nodes, links, positions]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || graphData.nodes.length === 0) return;
    if (!autoFit && lastFitVersion.current === fitVersion) return;
    // Positions are final as soon as they arrive, but zoomToFit reads them off
    // the rendered graph — so it has to run after this commit paints.
    const timer = setTimeout(() => {
      lastFitVersion.current = fitVersion;
      const duration = !autoFit && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 400;
      fg.zoomToFit(duration, 40);
    }, 0);
    return () => clearTimeout(timer);
  }, [autoFit, fitVersion, graphData]);

  const searchLower = search.trim().toLowerCase();
  const hasFocus = selectedId !== null || selectedLinkId !== null || searchLower.length > 0;

  const selectedLink = useMemo(
    () => (selectedLinkId ? links.find((l) => l.linkId === selectedLinkId) ?? null : null),
    [selectedLinkId, links]
  );

  // Edge drawing needs both endpoints' nodes on every frame; a linear scan
  // there would be O(nodes × links) per repaint.
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  /** Busiest visible file, used as the top of the heat scale. */
  const maxHits = useMemo(() => {
    if (!runtimeMode) return 0;
    let max = 0;
    for (const node of nodes) {
      const hits = fileHits[node.id] ?? 0;
      if (hits > max) max = hits;
    }
    return max;
  }, [runtimeMode, nodes, fileHits]);

  function isNodeDimmed(node: GraphNode): boolean {
    if (selectedLink) {
      return node.id !== selectedLink.source && node.id !== selectedLink.target;
    }
    if (selectedId) {
      return node.id !== selectedId && !neighborIds.has(node.id);
    }
    if (searchLower) {
      return !nodeLabel(node).toLowerCase().includes(searchLower);
    }
    return false;
  }

  /**
   * The drawn polyline for a link, oriented so it always ends at the link's
   * true target — ELK may emit a reversed section for a back-edge, and the
   * arrowhead has to point at the dependency regardless.
   */
  function routeFor(link: GraphLink): Point[] | null {
    const sourceId = endpointId(link.source);
    const targetId = endpointId(link.target);
    const route = routes.get(link.linkId);
    if (route && route.length >= 2) {
      const targetPos = positions.get(targetId);
      if (targetPos) {
        const head = route[0];
        const tail = route[route.length - 1];
        const distHead = Math.hypot(head.x - targetPos.x, head.y - targetPos.y);
        const distTail = Math.hypot(tail.x - targetPos.x, tail.y - targetPos.y);
        if (distHead < distTail) return [...route].reverse();
      }
      return route;
    }

    const source = positions.get(sourceId);
    const target = positions.get(targetId);
    if (!source || !target) return null;
    const sourceBox = boxes.get(sourceId) ?? DEFAULT_BOX;
    const targetBox = boxes.get(targetId) ?? DEFAULT_BOX;
    return [
      boxBoundaryPoint(source.x, source.y, target.x, target.y, sourceBox),
      boxBoundaryPoint(target.x, target.y, source.x, source.y, targetBox),
    ];
  }

  return (
    <ForceGraph2D
      ref={fgRef}
      graphData={graphData}
      width={width}
      height={height}
      backgroundColor="#14161a"
      nodeRelSize={NODE_REL_SIZE}
      {...(!autoFit && { nodeVal: fitNodeValue })}
      // Layout is precomputed; dragging a node would strand its orthogonal
      // routes at the old position.
      enableNodeDrag={false}
      cooldownTicks={0}
      warmupTicks={0}
      // force-graph's default tooltip accessor reads `name`, which only topic
      // hubs have — so hovering one repeated the label already drawn in the
      // box. Show the summary there instead, and nothing for other kinds.
      nodeLabel={(n) => {
        const node = n as unknown as GraphNode;
        return node.kind === "topic" ? node.summary : "";
      }}
      onNodeClick={(n) => onSelectNode(n as unknown as GraphNode)}
      onLinkClick={(l) => onSelectLink(l as unknown as GraphLink)}
      onBackgroundClick={() => {
        onSelectNode(null);
        onSelectLink(null);
      }}
      nodeCanvasObject={(n, ctx) => {
        const node = n as unknown as PositionedNode;
        const dimmed = hasFocus && isNodeDimmed(node);
        const selected = node.id === selectedId;
        const isEndpoint = node.kind === "endpoint";
        const isTopic = node.kind === "topic";

        const { w, h, top, bottom, topFont, bottomFont } = boxes.get(node.id) ?? DEFAULT_BOX;
        const x = node.x - w / 2;
        const y = node.y - h / 2;

        // Hubs are labels for a region, not members of the flowchart, so they
        // are filled with their own color rather than the shared box color.
        if (isTopic) {
          const color = nodeBorderColor(node, topicIndex);
          ctx.globalAlpha = dimmed ? 0.2 : 1;
          roundRectPath(ctx, x, y, w, h, CORNER_RADIUS * 2);
          ctx.fillStyle = withAlpha(color, selected ? 0.32 : 0.18);
          ctx.fill();
          ctx.lineWidth = selected ? 2.4 : 1.6;
          ctx.strokeStyle = color;
          ctx.stroke();

          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.font = `${topFont}px sans-serif`;
          ctx.fillStyle = color;
          ctx.fillText(top, node.x, y + PAD_Y);
          ctx.font = `600 ${bottomFont}px sans-serif`;
          ctx.fillStyle = COLOR_LABEL;
          ctx.fillText(bottom, node.x, y + PAD_Y + topFont + LINE_GAP);
          ctx.globalAlpha = 1;
          return;
        }

        // In runtime mode, code that never ran is the signal — render it hollow
        // and faded so live code reads as the foreground.
        const unexecuted = runtimeMode && node.kind === "file" && !executedIds.has(node.id);
        const heat = runtimeMode && node.kind === "file"
          ? heatFraction(fileHits[node.id] ?? 0, maxHits)
          : 0;

        ctx.globalAlpha = dimmed ? 0.15 : unexecuted ? 0.4 : 1;

        // Endpoints get a stadium outline so they read as "not a file" at a glance.
        roundRectPath(ctx, x, y, w, h, isEndpoint ? h / 2 : CORNER_RADIUS);
        ctx.fillStyle = unexecuted
          ? "transparent"
          : selected
            ? COLOR_BG_SELECTED
            : isEndpoint
              ? COLOR_ENDPOINT_BG
              : COLOR_BG;
        if (!unexecuted) ctx.fill();
        // Box geometry comes from ELK, so hit intensity is carried by border
        // weight and colour rather than size, which would fight the layout.
        ctx.lineWidth = selected ? 2 : unexecuted ? 0.8 : 1.2 + heat * 1.6;
        ctx.strokeStyle = selected
          ? COLOR_BORDER_SELECTED
          : unexecuted
            ? COLOR_UNEXECUTED
            : heat > 0
              ? COLOR_HOT
              : nodeBorderColor(node, topicIndex);
        ctx.setLineDash(isEndpoint ? [2, 1.5] : unexecuted ? [1.5, 1.5] : []);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        if (top) {
          ctx.font = `${topFont}px sans-serif`;
          ctx.fillStyle = isEndpoint ? COLOR_API : COLOR_LABEL_DIR;
          ctx.fillText(top, node.x, y + PAD_Y);
          ctx.font = `${bottomFont}px sans-serif`;
          ctx.fillStyle = COLOR_LABEL;
          ctx.fillText(bottom, node.x, y + PAD_Y + topFont + LINE_GAP);
        } else {
          ctx.font = `${bottomFont}px sans-serif`;
          ctx.fillStyle = COLOR_LABEL;
          ctx.fillText(bottom, node.x, y + PAD_Y);
        }

        ctx.globalAlpha = 1;
      }}
      nodePointerAreaPaint={(n, color, ctx) => {
        const node = n as unknown as PositionedNode;
        const box = boxes.get(node.id) ?? DEFAULT_BOX;
        ctx.fillStyle = color;
        roundRectPath(ctx, node.x - box.w / 2, node.y - box.h / 2, box.w, box.h, CORNER_RADIUS);
        ctx.fill();
      }}
      linkCanvasObjectMode={() => "replace"}
      linkCanvasObject={(l, ctx) => {
        const link = l as unknown as GraphLink;
        const points = routeFor(link);
        if (!points) return;

        // Membership lines are a different class of mark: no arrowhead (a file
        // does not "depend on" its topic) and near-invisible until the topic or
        // one of its files is in focus.
        if (link.kind === "membership") {
          const topicId = endpointId(link.source);
          const color = topicIndex?.byTopicId.get(topicId)?.color ?? COLOR_EDGE_DEFAULT;
          const focused =
            link.linkId === selectedLinkId ||
            topicId === selectedId ||
            endpointId(link.target) === selectedId;

          ctx.save();
          ctx.globalAlpha = focused ? MEMBERSHIP_ALPHA_FOCUSED : MEMBERSHIP_ALPHA;
          ctx.strokeStyle = color;
          ctx.lineWidth = focused ? 1.4 : 0.9;
          ctx.beginPath();
          ctx.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
          ctx.stroke();
          ctx.restore();
          return;
        }

        const isApi = link.kind === "api";
        const selected = link.linkId === selectedLinkId;
        const sourceNode = nodeById.get(endpointId(link.source));
        const targetNode = nodeById.get(endpointId(link.target));
        const dimmed =
          hasFocus &&
          !selected &&
          ((sourceNode ? isNodeDimmed(sourceNode) : false) ||
            (targetNode ? isNodeDimmed(targetNode) : false));

        let color = COLOR_EDGE_DEFAULT;
        if (isApi) color = COLOR_API;
        else if (link.inCycle) color = COLOR_EDGE_CYCLE;
        else if (link.isTypeOnly) color = "#7a7f8a";
        if (selected) color = COLOR_BORDER_SELECTED;

        const end = points[points.length - 1];
        const beforeEnd = points[points.length - 2];
        const angle = Math.atan2(end.y - beforeEnd.y, end.x - beforeEnd.x);

        ctx.save();
        ctx.globalAlpha = dimmed ? 0.1 : 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = selected ? 2 : isApi || (link.kind === "import" && link.inCycle) ? 1.6 : 1;
        if (isApi) ctx.setLineDash([5, 2, 1.5, 2]); // dash-dot distinguishes calls from imports
        else ctx.setLineDash(link.kind === "import" && link.isTypeOnly ? [3, 2] : []);

        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length - 1; i++) ctx.lineTo(points[i].x, points[i].y);
        // Stop short of the tip so the line doesn't show through the arrowhead.
        ctx.lineTo(end.x - ARROW_LENGTH * Math.cos(angle), end.y - ARROW_LENGTH * Math.sin(angle));
        ctx.stroke();

        ctx.setLineDash([]);
        drawArrowHead(ctx, end.x, end.y, angle, ARROW_LENGTH, color);

        // Method badge on the route's longest run, so an API edge reads as
        // "POST" without having to open the side panel.
        if (isApi && !dimmed) {
          const { x: labelX, y: labelY } = longestSegmentMidpoint(points);
          ctx.font = `${METHOD_FONT}px sans-serif`;
          const label = link.method;
          const labelWidth = ctx.measureText(label).width;
          ctx.fillStyle = "#14161a";
          roundRectPath(
            ctx,
            labelX - labelWidth / 2 - 1.5,
            labelY - METHOD_FONT / 2 - 1.2,
            labelWidth + 3,
            METHOD_FONT + 2.4,
            1.2
          );
          ctx.fill();
          ctx.fillStyle = color;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, labelX, labelY);
        }

        ctx.restore();
      }}
      linkPointerAreaPaint={(l, color, ctx) => {
        const link = l as unknown as GraphLink;
        const points = routeFor(link);
        if (!points) return;

        ctx.strokeStyle = color;
        ctx.lineWidth = 5; // fat hit area — edges are 1-2px and hard to click precisely
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();
      }}
    />
  );
}
