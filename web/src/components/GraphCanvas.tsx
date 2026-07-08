import { useMemo, useRef } from "react";
import ForceGraph2D, { type NodeObject, type LinkObject } from "react-force-graph-2d";
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

function nodeRadius(sizeBytes: number): number {
  const r = 3 + Math.log2(sizeBytes + 1) * 1.1;
  return Math.min(Math.max(r, 3), 22);
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
      linkColor={(l) => {
        const link = l as unknown as ImportEdge;
        if (link.inCycle) return "#d65b5b";
        return link.isTypeOnly ? "rgba(180,180,180,0.35)" : "rgba(160,160,160,0.55)";
      }}
      linkWidth={(l) => ((l as unknown as ImportEdge).inCycle ? 1.6 : 1)}
      linkLineDash={(l) => ((l as unknown as ImportEdge).isTypeOnly ? [3, 2] : null)}
      linkDirectionalArrowLength={4}
      linkDirectionalArrowRelPos={1}
      onNodeClick={(n) => onSelectNode(n as unknown as FileNode)}
      onBackgroundClick={() => onSelectNode(null)}
      nodeCanvasObject={(n, ctx, globalScale) => {
        const node = n as unknown as FileNode & { x: number; y: number };
        const radius = nodeRadius(node.sizeBytes);
        const dimmed = hasFocus && isNodeDimmed(node);
        const color = colorForFolder(node.folder);

        ctx.globalAlpha = dimmed ? 0.15 : 1;
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
        ctx.fillStyle = color;
        ctx.fill();

        if (node.id === selectedId) {
          ctx.lineWidth = 2 / globalScale;
          ctx.strokeStyle = "#ffffff";
          ctx.stroke();
        }

        if (globalScale > 1.7 && !dimmed) {
          const label = node.id.split("/").pop() ?? node.id;
          const fontSize = 11 / globalScale;
          ctx.font = `${fontSize}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = "rgba(230,230,230,0.85)";
          ctx.fillText(label, node.x, node.y + radius + 1);
        }
        ctx.globalAlpha = 1;
      }}
      nodePointerAreaPaint={(n, color, ctx) => {
        const node = n as unknown as FileNode & { x: number; y: number };
        const radius = nodeRadius(node.sizeBytes);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
        ctx.fill();
      }}
      cooldownTicks={100}
    />
  );
}
