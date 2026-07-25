# Layered Box-and-Arrow Layout

## Goal

Replace the force-directed graph with a deterministic **layered flowchart**: boxes arranged in rows, arrows drawn as right-angle polylines, flow reading top-to-bottom — the shape of a hand-drawn architecture diagram.

The force simulation gives an organic blob that looks different every reload, drifts while you read it, and routes edges as curves that cross each other at arbitrary angles. For a dependency graph — which is a DAG plus a handful of cycles — a layered layout is strictly more legible: entry points sit at the top, leaf utilities at the bottom, and "what depends on what" is readable as vertical position instead of having to trace a curve.

Decided with the request: **geometry changes, the dark theme stays.** Boxes keep their folder-colored borders, rounded corners, and the `#14161a` canvas. And the force layout is **removed entirely** — not kept behind a toggle.

## Approach

### Layout engine: ELK (`elkjs`)

The layout must do two separable things: assign nodes to layers/columns (Sugiyama), and route edges as orthogonal polylines with proper lane separation so parallel runs don't overlap. Almost every library does the first; few do the second well.

| | **elkjs** (chosen) | dagre | hand-rolled Sugiyama |
|---|---|---|---|
| Layered node placement | Yes | Yes | Yes, with effort |
| True orthogonal edge routing | Yes — `edgeRouting: ORTHOGONAL`, returns bend points | Polyline through spline points; right angles must be faked | Would have to write lane assignment by hand |
| Parallel-edge separation | Built in | Manual | Manual |
| Cycle handling | Breaks and re-reverses internally | Breaks internally | Manual |
| Bundle size | ~500 KB gzipped | ~60 KB | 0 |
| Maintenance | Actively maintained, Eclipse project | Effectively unmaintained (`dagre` archived; `@dagrejs/dagre` is the live fork) | All ours |

ELK's orthogonal routing is the whole reason the reference diagram reads well — those long right-angle runs with clean lane separation are exactly what `ORTHOGONAL` produces and what we would otherwise spend a week reimplementing badly. The bundle cost is real but this is a locally-served dev tool, not a page with a load-time budget; it loads once from `localhost`.

Configuration:

```ts
{
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "60",
  "elk.spacing.nodeNode": "28",
  "elk.spacing.edgeNode": "16",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",   // straightens long chains
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES" // stable across reloads
}
```

Run it in a **web worker** (`elkjs/lib/elk-worker.js`) so a 400-file graph doesn't freeze the UI mid-layout.

### Keeping `react-force-graph-2d` as the viewport

The simulation goes away, but pan, zoom, canvas sizing, click hit-testing, and the pointer-area painting are all machinery we'd otherwise rebuild. So: keep `ForceGraph2D` as a dumb canvas host, feed each node ELK's coordinates as `fx`/`fy` (pinned — the simulation has nothing left to solve), set `cooldownTicks={0}` and `enableNodeDrag={false}`.

Dragging must be off: a dragged node would leave its orthogonal routes pointing at where it used to be, and re-running ELK per mouse-move is not viable. Losing drag is an acceptable trade — in a deterministic layout there's no tangle to manually untangle, which was the main reason to drag.

If `ForceGraph2D` fights the pinned positions in practice (it shouldn't — `fx`/`fy` are honored), the fallback is a bare `<canvas>` with `d3-zoom` for the transform and manual hit-testing. Noted as a risk, not planned work. Either way `d3-force-3d` and `forceCollide` are deleted.

### Measuring boxes before layout, not during draw

Today `computeNodeText` (`web/src/components/GraphCanvas.tsx:67`) measures each box *inside* `nodeCanvasObject`, stashing the result on `node.__box` for the edge code to read afterwards. That's fine when a simulation supplies positions, but ELK needs real widths and heights as *input*. So `computeNodeText` moves out of the component into a new `web/src/layout/measure.ts` and runs against an offscreen `document.createElement("canvas").getContext("2d")` before layout. The draw path then just reads the measured box. This is the one refactor the whole feature depends on.

**Uniform widths:** the reference diagram gets much of its tidiness from boxes of similar width. After measuring, snap every box to the max width within its layer (capped, with long paths ellipsized in the middle: `src/analyzer/…/fileGraph.ts`). Behind a `--uniform-width`-style UI toggle so long-path repos can opt out.

### Cycles and back-edges

ELK breaks cycles internally by reversing edges, then restores them, so a cyclic import graph lays out fine. What matters visually is that the reversed edge reads as a *feedback* line — the long upward route in the reference. Two rules:

1. Draw the arrowhead at the end of the polyline nearest the edge's **true** `target`, not at the last bend point ELK emitted. ELK may hand back the sections in reversed order for a back-edge; keying off the true target makes direction correct regardless.
2. `inCycle` edges keep the existing red (`COLOR_EDGE_CYCLE`) and slightly heavier stroke, so a back-edge is legible as a cycle, not as a routing accident.

### What the edge renderer becomes

The current `linkCanvasObject` computes a quadratic curve through a fanned control point (`bundleOffset`, `pairKey`, `boxBoundaryPoint`). All of it is deleted — ELK returns each edge as `sections[].startPoint / bendPoints[] / endPoint`, already clipped to node boundaries and already separated from parallel edges. The new renderer is a `moveTo` + a run of `lineTo`s + an arrowhead, with the angle taken from the final segment.

Retained: dash patterns (dash-dot for API calls, dashed for `import type`), the cycle/API/selection colors, dimming on focus, and the HTTP method badge — now placed at the midpoint of the edge's **longest horizontal segment** rather than a curve midpoint, so it sits on a straight run and stays readable.

`linkPointerAreaPaint` traces the same polyline with a fat stroke — simpler and more accurate than the current curve-retracing version, which had to duplicate the control-point math to stay in sync.

### Relayout triggers

Layout is now async and non-trivial, so it must run only when the *set* of visible nodes/edges changes — folder filter, extension filter, cycles-only toggle, graph load. Not on selection, search, or hover, which only affect styling. Implement as a `useLayout(nodes, links)` hook in `web/src/layout/useLayout.ts` keyed on a hash of the visible ids, with an in-memory cache so toggling a filter back is instant and a "laying out…" state for the first pass.

## Changes Required

**New dependency:** `elkjs` (^0.9) in `web/package.json`. Removed: `d3-force-3d` (and its `web/src/d3-force-3d.d.ts` shim). `react-force-graph-2d` stays.

**New: `web/src/layout/`**
- `measure.ts` — `measureNode(node): { w, h, top, bottom, topFont, bottomFont }`, hoisted from `GraphCanvas.computeNodeText`, plus the per-layer uniform-width pass and middle-ellipsis for long paths.
- `elk.ts` — builds the ELK graph JSON from `GraphNode[]` / `GraphLink[]` + measured boxes, runs the worker, maps results back to `{ positions: Map<string, {x,y}>, routes: Map<linkId, Point[]> }`. Converts ELK's top-left origin to the centre-origin coordinates the canvas draws in.
- `useLayout.ts` — the async hook: cache, debounce, `laying-out` / `ready` / `failed` states.

**Modified: `web/src/components/GraphCanvas.tsx`** — the bulk of the work. Delete the `useEffect` installing `forceCollide`/link-distance/charge (lines 174–191), `pairKey`, `bundleOffset`, and the curve math in `linkCanvasObject` / `linkPointerAreaPaint`. Accept `positions` and `routes` as props. Add `cooldownTicks={0}`, `enableNodeDrag={false}`, and set `fx`/`fy` when building `graphData`. `boxBoundaryPoint` stays as a fallback for any edge ELK returns without sections.

**Modified: `web/src/App.tsx`** — call `useLayout`, pass results down, render the layout-pending state.

**Modified: `web/src/components/TopBar.tsx`** — direction toggle (**Down** / **Right**; `elk.direction`) and a "uniform box width" checkbox. Both are pure layout options and force a relayout.

**Modified: `web/src/components/StatsOverlay.tsx`** — show layer count / graph depth, which is meaningful now that depth is real.

**Unchanged:** everything under `src/` (the analyzer and server are untouched — this is a pure frontend change), `web/src/types.ts`, `web/src/palette.ts`, `SidePanel.tsx`.

## Cost & Services

Free. `elkjs` is EPL-2.0, an npm package with no service behind it, running entirely in the browser — nothing new to host, no API, no key. The only cost is ~500 KB gzipped added to a bundle served from `localhost`, and CPU for layout (hundreds of ms for a few hundred nodes, in a worker, off the main thread).

## Steps

1. **Measure pass.** Extract `computeNodeText` into `web/src/layout/measure.ts` against an offscreen 2D context; have `GraphCanvas` consume the pre-measured box instead of computing it during draw. Pure refactor — the force graph still renders identically. Verify nothing shifts.
2. **ELK integration, straight edges.** Add `elkjs`, write `layout/elk.ts` + `useLayout.ts`, pin `fx`/`fy`, `cooldownTicks={0}`, drop node drag and the force `useEffect`. Keep the existing straight/curved edge renderer for now. **First visible payoff — the graph becomes a stable layered diagram.**
3. **Orthogonal routing.** Switch on `edgeRouting: ORTHOGONAL`, consume `sections[]`, rewrite `linkCanvasObject` and `linkPointerAreaPaint` as polylines, fix the arrowhead angle to the final segment, delete `pairKey`/`bundleOffset`. This is the step that produces the reference look.
4. **Back-edges and cycles.** Arrowhead-at-true-target rule, red back-edge styling, test against a repo with a known import cycle (code-map's own `src/` if one exists, otherwise a fixture).
5. **Polish.** Uniform per-layer widths + middle-ellipsis, method badge on the longest horizontal segment, direction toggle and width toggle in `TopBar`, depth in `StatsOverlay`.
6. **Cleanup + tuning.** Remove `d3-force-3d` and its `.d.ts`, tune spacing constants against a large real repo (300+ files), confirm layout time is acceptable and the worker keeps the UI responsive. Update the README (the "force-directed" wording and `docs/screenshot.png` are both now wrong).

## Interaction with other plans

`plans/RUNTIME.md` step 4 calls for scaling executed nodes by hit count in `GraphCanvas.tsx`. Under a fixed layout, node size is a **layout input**, not a draw-time flourish — hit-count sizing must feed `measure.ts` so ELK reserves the space, or boxes will overlap. If runtime tracing lands first, expect to redo that sizing during step 1 here; if this plan lands first, RUNTIME step 4 gets simpler. No contradiction, just an ordering dependency worth knowing.

## Out of Scope

- **Light/flat "printed diagram" theme.** The white background, square corners, and black arrows of the reference are explicitly not adopted — dark theme with folder colors stays. A theme toggle is a separate, easy follow-up once the geometry is in.
- **Keeping force-directed as an option.** Removed outright, per decision. If dense unstructured graphs turn out to be unreadable when layered, that's a new plan, not a rollback.
- **Manual node repositioning and saved layouts.** No dragging, no persisted arrangement, no per-project layout file.
- **Folder grouping / compound nodes.** ELK supports nested containers, and drawing a labeled box around each top-level folder would suit this style well — deliberately deferred; it changes the data model the canvas consumes.
- **SVG / PNG export.** Tempting now that the layout is deterministic and print-worthy, but a separate feature.
- **Layered layout for the symbol drill-down** in `SidePanel.tsx` — stays as-is.
- **Incremental / animated relayout.** Filter changes snap to the new layout; no transitions between arrangements.
