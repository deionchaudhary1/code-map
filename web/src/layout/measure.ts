// Box measurement for graph nodes. This runs *before* layout — ELK needs real
// widths and heights as input — so it can't live inside the canvas draw call.

import type { GraphNode } from "../graphModel";

export const BASENAME_FONT = 4.5; // graph units, not divided by globalScale so boxes scale with zoom
export const DIR_FONT = 3;
export const METHOD_FONT = 3.2;
export const LINE_GAP = 1;
export const PAD_X = 6;
export const PAD_Y = 3;

/** Widest a box may get before its label is ellipsized, in graph units. */
const MAX_BOX_WIDTH = 110;

export interface NodeBox {
  w: number;
  h: number;
  top: string;
  bottom: string;
  topFont: number;
  bottomFont: number;
}

/** Splits a repo-relative path into its directory prefix (with trailing
 * slash, empty for root-level files) and basename. */
export function splitPath(id: string): { dir: string; base: string } {
  const idx = id.lastIndexOf("/");
  if (idx === -1) return { dir: "", base: id };
  return { dir: id.slice(0, idx + 1), base: id.slice(idx + 1) };
}

/** Endpoint URLs can be long; keep the tail, which carries the route. */
function truncateUrl(url: string): string {
  const maxLength = 34;
  if (url.length <= maxLength) return url;
  return "…" + url.slice(url.length - maxLength + 1);
}

let sharedCtx: CanvasRenderingContext2D | null = null;

/** Offscreen 2D context used only for text metrics. */
function metricsContext(): CanvasRenderingContext2D {
  if (!sharedCtx) {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable — cannot measure node labels");
    sharedCtx = ctx;
  }
  return sharedCtx;
}

/** Drops characters from the middle until the text fits `maxWidth`. */
function middleEllipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let head = Math.ceil(text.length / 2);
  let tail = text.length - head;
  while (head + tail > 4) {
    if (head > tail) head--;
    else tail--;
    const candidate = `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
    if (ctx.measureText(candidate).width <= maxWidth) return candidate;
  }
  return text.slice(0, 3) + "…";
}

function measureOne(ctx: CanvasRenderingContext2D, node: GraphNode): NodeBox {
  const topFont = node.kind === "file" ? DIR_FONT : METHOD_FONT;
  const bottomFont = BASENAME_FONT;
  const maxTextWidth = MAX_BOX_WIDTH - PAD_X * 2;

  ctx.font = `${bottomFont}px sans-serif`;
  const bottom = middleEllipsis(
    ctx,
    node.kind === "file" ? splitPath(node.id).base : truncateUrl(node.url),
    maxTextWidth
  );
  let width = ctx.measureText(bottom).width;

  ctx.font = `${topFont}px sans-serif`;
  const rawTop = node.kind === "file" ? splitPath(node.id).dir : node.method;
  const top = rawTop ? middleEllipsis(ctx, rawTop, maxTextWidth) : "";
  if (top) width = Math.max(width, ctx.measureText(top).width);

  return {
    w: width + PAD_X * 2,
    h: (top ? bottomFont + LINE_GAP + topFont : bottomFont) + PAD_Y * 2,
    top,
    bottom,
    topFont,
    bottomFont,
  };
}

/**
 * Measures every node's box.
 *
 * With `uniformWidth`, all boxes are widened to the widest one — the tidiness
 * of a hand-drawn flowchart comes largely from columns of equal-width boxes.
 * Per-layer widths would look better still, but layer assignment only exists
 * after layout, and widths are an input to it; a second ELK pass isn't worth
 * the latency.
 */
export function measureNodes(nodes: GraphNode[], uniformWidth: boolean): Map<string, NodeBox> {
  const ctx = metricsContext();
  const boxes = new Map<string, NodeBox>();
  for (const node of nodes) boxes.set(node.id, measureOne(ctx, node));

  if (uniformWidth && boxes.size > 0) {
    let widest = 0;
    for (const box of boxes.values()) widest = Math.max(widest, box.w);
    for (const box of boxes.values()) box.w = widest;
  }
  return boxes;
}
