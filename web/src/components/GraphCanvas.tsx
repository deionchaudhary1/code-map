import { useEffect, useMemo, useRef } from "react";
import ForceGraph2D, { type NodeObject, type LinkObject } from "react-force-graph-2d";
import { forceCollide } from "d3-force-3d";
import type { FileNode, ImportEdge } from "../types";
import { colorForFolder } from "../palette";

interface GraphCanvasProps {
  nodes: FileNode[];
  edges: ImportEdge[];
  width: number;
  height: number;
  search: string;
  selectedId: string | null;
  neighborIds: Set<string>;
  onSelectNode: (node: FileNode | null) => void;
}

type Box = { w: number; h: number };
type PositionedNode = FileNode & { x: number; y: number; __box?: Box };

const BASENAME_FONT = 4.5; // graph units, not divided by globalScale so boxes scale with zoom
const DIR_FONT = 3;
const LINE_GAP = 1;
const PAD_X = 6;
const PAD_Y = 3;
const CORNER_RADIUS = 2.5;
const ARROW_LENGTH = 4;
const DEFAULT_BOX: Box = { w: 24, h: 10 };

const COLOR_BG = "#1d212a";
const COLOR_BG_SELECTED = "#262c38";
const COLOR_BORDER_SELECTED = "#e8eaed";
const COLOR_LABEL = "#e8eaed";
const COLOR_LABEL_DIR = "#8a8f98";
const COLOR_EDGE_DEFAULT = "#4a4f58";
const COLOR_EDGE_CYCLE = "#d65b5b";

function nodeRadius(sizeBytes: number): number {
  const r = 3 + Math.log2(sizeBytes + 1) * 1.1;
  return Math.min(Math.max(r, 3), 22);
}

/** Splits a repo-relative path into its directory prefix (with trailing
 * slash, empty for root-level files) and basename. */
function splitPath(id: string): { dir: string; base: string } {
  const idx = id.lastIndexOf("/");
  if (idx === -1) return { dir: "", base: id };
  return { dir: id.slice(0, idx + 1), base: id.slice(idx + 1) };
}

function computeBox(ctx: CanvasRenderingContext2D, node: FileNode): Box & { dir: string; base: string } {
  const { dir, base } = splitPath(node.id);
  ctx.font = `${BASENAME_FONT}px sans-serif`;
  const baseWidth = ctx.measureText(base).width;
  let width = baseWidth;
  if (dir) {
    ctx.font = `${DIR_FONT}px sans-serif`;
    const dirWidth = ctx.measureText(dir).width;
    width = Math.max(baseWidth, dirWidth);
  }
  const w = width + PAD_X * 2;
  const h = (dir ? BASENAME_FONT + LINE_GAP + DIR_FONT : BASENAME_FONT) + PAD_Y * 2;
  return { w, h, dir, base };
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
 * the axis-aligned box of size `box` centered at (cx,cy). Used to clip
 * edges to the node boxes instead of drawing from/to their centers. */
function boxBoundaryPoint(cx: number, cy: number, tx: number, ty: number, box: Box): { x: number; y: number } {
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

function isResolvedNode(v: PositionedNode | string): v is PositionedNode {
  return typeof v === "object" && v !== null && typeof (v as PositionedNode).x === "number";
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

export default function GraphCanvas({
  nodes,
  edges,
  width,
  height,
  search,
  selectedId,
  neighborIds,
  onSelectNode,
}: GraphCanvasProps) {
  const fgRef = useRef<any>(null);

  const graphData = useMemo(
    () => ({
      nodes: nodes.map((n) => ({ ...n })) as NodeObject<FileNode>[],
      links: edges.map((e) => ({ ...e })) as LinkObject<FileNode, ImportEdge>[],
    }),
    [nodes, edges]
  );

  // Boxes are wider than circles, so give the simulation a collision force
  // to keep them from overlapping, and open up link distance/charge so the
  // layout has room to breathe.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force(
      "collide",
      forceCollide<PositionedNode>((node) => {
        const box = node.__box ?? DEFAULT_BOX;
        return Math.sqrt(box.w * box.w + box.h * box.h) / 2 + 2;
      })
    );
    const linkForce = fg.d3Force("link");
    if (linkForce && typeof linkForce.distance === "function") linkForce.distance(60);
    const chargeForce = fg.d3Force("charge");
    if (chargeForce && typeof chargeForce.strength === "function") chargeForce.strength(-140);
  }, [graphData]);

  const searchLower = search.trim().toLowerCase();
  const hasFocus = selectedId !== null || searchLower.length > 0;

  function isNodeDimmed(node: FileNode): boolean {
    if (selectedId) {
      return node.id !== selectedId && !neighborIds.has(node.id);
    }
    if (searchLower) {
      return !node.id.toLowerCase().includes(searchLower);
    }
    return false;
  }

  return (
    <ForceGraph2D
      ref={fgRef}
      graphData={graphData}
      width={width}
      height={height}
      backgroundColor="#14161a"
      nodeRelSize={4}
      nodeVal={(n) => nodeRadius((n as unknown as FileNode).sizeBytes)}
      onNodeClick={(n) => onSelectNode(n as unknown as FileNode)}
      onBackgroundClick={() => onSelectNode(null)}
      nodeCanvasObject={(n, ctx) => {
        const node = n as unknown as PositionedNode;
        const dimmed = hasFocus && isNodeDimmed(node);
        const color = colorForFolder(node.folder);
        const selected = node.id === selectedId;

        const { w, h, dir, base } = computeBox(ctx, node);
        node.__box = { w, h };
        const x = node.x - w / 2;
        const y = node.y - h / 2;

        ctx.globalAlpha = dimmed ? 0.15 : 1;

        roundRectPath(ctx, x, y, w, h, CORNER_RADIUS);
        ctx.fillStyle = selected ? COLOR_BG_SELECTED : COLOR_BG;
        ctx.fill();
        ctx.lineWidth = selected ? 2 : 1.2;
        ctx.strokeStyle = selected ? COLOR_BORDER_SELECTED : color;
        ctx.stroke();

        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        if (dir) {
          ctx.font = `${DIR_FONT}px sans-serif`;
          ctx.fillStyle = COLOR_LABEL_DIR;
          ctx.fillText(dir, node.x, y + PAD_Y);
          ctx.font = `${BASENAME_FONT}px sans-serif`;
          ctx.fillStyle = COLOR_LABEL;
          ctx.fillText(base, node.x, y + PAD_Y + DIR_FONT + LINE_GAP);
        } else {
          ctx.font = `${BASENAME_FONT}px sans-serif`;
          ctx.fillStyle = COLOR_LABEL;
          ctx.fillText(base, node.x, y + PAD_Y);
        }

        ctx.globalAlpha = 1;
      }}
      nodePointerAreaPaint={(n, color, ctx) => {
        const node = n as unknown as PositionedNode;
        const box = node.__box ?? computeBox(ctx, node);
        ctx.fillStyle = color;
        roundRectPath(ctx, node.x - box.w / 2, node.y - box.h / 2, box.w, box.h, CORNER_RADIUS);
        ctx.fill();
      }}
      linkCanvasObjectMode={() => "replace"}
      linkCanvasObject={(l, ctx) => {
        const link = l as unknown as ImportEdge & { source: PositionedNode | string; target: PositionedNode | string };
        if (!isResolvedNode(link.source) || !isResolvedNode(link.target)) return;
        const source = link.source;
        const target = link.target;

        const sourceBox = source.__box ?? DEFAULT_BOX;
        const targetBox = target.__box ?? DEFAULT_BOX;

        const start = boxBoundaryPoint(source.x, source.y, target.x, target.y, sourceBox);
        const end = boxBoundaryPoint(target.x, target.y, source.x, source.y, targetBox);

        const dimmed = hasFocus && (isNodeDimmed(source) || isNodeDimmed(target));

        let color = COLOR_EDGE_DEFAULT;
        if (link.inCycle) color = COLOR_EDGE_CYCLE;
        else if (link.isTypeOnly) color = "#7a7f8a";

        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const lineEndX = end.x - ARROW_LENGTH * Math.cos(angle);
        const lineEndY = end.y - ARROW_LENGTH * Math.sin(angle);

        ctx.save();
        ctx.globalAlpha = dimmed ? 0.1 : 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = link.inCycle ? 1.6 : 1;
        ctx.setLineDash(link.isTypeOnly ? [3, 2] : []);

        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(lineEndX, lineEndY);
        ctx.stroke();

        ctx.setLineDash([]);
        drawArrowHead(ctx, end.x, end.y, angle, ARROW_LENGTH, color);
        ctx.restore();
      }}
      cooldownTicks={100}
    />
  );
}
