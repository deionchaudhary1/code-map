# Code Map

## Overview
Code Map is a local CLI tool that scans a JavaScript/TypeScript codebase, extracts its import/export relationships (and, on drill-down, function-level call relationships within a file), and renders the result as an interactive graph in a browser-based UI. It's for developers who inherit or maintain a codebase and want an accurate, explorable picture of how its pieces connect — instead of guessing from folder structure or grepping for imports by hand.

## Core Features (MVP)
1. Point the CLI at a local project folder; it walks the file tree and parses all `.js`/`.ts`/`.jsx`/`.tsx` files.
2. Build a file-level dependency graph: nodes = files, edges = import/require relationships (including resolving relative paths and `index` files).
3. Serve an interactive graph UI in the browser (force-directed layout) showing all files and their import edges.
4. Click a file node to "expand" it: parse that file's internal functions/classes and show a symbol-level call graph (who calls whom inside that file, plus which imported symbols it uses).
5. Interactive controls: zoom/pan, drag nodes, search-by-filename, filter by folder/glob, filter by file extension, toggle "show only files connected to selection" (highlight upstream/downstream neighbors).
6. Click a node to see a side panel with file path, size, list of imports/exports, and (if expanded) its function list.
7. Detect and visually flag cycles (circular imports) since these are a common real-world pain point.

## Architecture & Tech Stack
- **CLI**: Node.js script (`npx code-map <path>` or `code-map ./src`) using `commander` for args.
- **Parsing**: `ts-morph` (wraps the TypeScript compiler API) to parse both JS and TS files, resolve imports, and extract exported/declared functions and their call expressions. This avoids needing a separate JS-only parser.
- **Graph build step**: CLI walks the target directory (respecting `.gitignore` via the `ignore` package), builds a JSON graph:
  - `nodes`: files (with metadata: path, size, extension, exported symbols)
  - `edges`: import relationships (file → file)
  - `symbolGraph` (per file, computed lazily on expand): functions/classes as nodes, call expressions as edges
- **Serving**: CLI starts a small local Express (or plain Node `http`) server on `localhost`, serves a static frontend bundle and the generated graph JSON via a `/api/graph` endpoint. Opens the browser automatically.
- **Frontend**: Vite + React + TypeScript, using `react-force-graph` (or `d3-force` directly) for the graph rendering, since it handles large node counts with WebGL/canvas rendering.
- **No backend hosting, no database** — everything runs locally, one process, output graph JSON can optionally be saved to disk (`code-map.json`) for reuse/sharing.

Flow:
```
user runs `code-map ./my-project`
        │
        ▼
CLI walks files → ts-morph parses imports/exports
        │
        ▼
graph.json (nodes + edges) written to memory
        │
        ▼
local server starts → opens http://localhost:4280
        │
        ▼
React app fetches /api/graph → renders force-directed graph
        │
        ▼
user clicks a node → frontend calls /api/graph/symbols?file=... → 
        CLI parses that single file's function-call graph on demand → returns JSON
```

## Data Model
**FileNode**
- `id` (absolute or repo-relative path)
- `extension`
- `sizeBytes`
- `exports`: string[] (exported symbol names)
- `isEntryPoint`: boolean (heuristic: referenced by package.json "main"/"module" or not imported by anything)

**ImportEdge**
- `source`: FileNode id
- `target`: FileNode id
- `importedSymbols`: string[]
- `isTypeOnly`: boolean (TS `import type`)

**SymbolNode** (per-file, computed on expand)
- `id` (`filePath#functionName`)
- `kind`: `function` | `class` | `method` | `const-arrow-fn`
- `startLine` / `endLine`

**CallEdge** (per-file)
- `source`: SymbolNode id
- `target`: SymbolNode id or external import reference
- `isExternalCall`: boolean (calls into an imported module vs. local symbol)

**CycleFlag**
- list of file id chains that form circular import loops (computed via DFS/Tarjan's SCC on the file graph)

## Pages / UI
- **Main Graph View** (single page app, no routing needed for MVP)
  - Full-screen force-directed graph canvas
  - Top bar: search box (filter/highlight by filename), folder filter dropdown, extension filter checkboxes, "show cycles only" toggle
  - Side panel (slides in on node click): file path, size, exports list, import/export counts, "Expand into functions" button
  - Expanded symbol view: replaces or overlays the clicked file's node with its internal function-call subgraph (breadcrumb to collapse back to file view)
  - Legend: node color by folder/type, edge color for type-only vs. value imports, red highlight for cyclic edges
  - Bottom-corner stats: total files, total edges, cycle count

## Cost Breakdown
Entirely local — $0 to run.
- No hosting: it's a CLI + localhost server, not a deployed web app.
- No database: graph is computed in-memory per run (optionally cached to a JSON file).
- No paid APIs: `ts-morph`, `react-force-graph`, `express`, `commander`, `ignore` are all open-source, free npm packages.
- Only cost is optional: publishing to npm registry (free) if distributing as `npx code-map`.

## Build Phases
**Phase 1 (MVP)**
- CLI scaffold + directory walker + `.gitignore` respect
- ts-morph-based import/export extraction → file-level graph JSON
- Local server + static frontend serving the graph JSON
- Basic force-directed graph rendering (nodes + edges, zoom/pan/drag)
- Node click → side panel with file metadata

**Phase 2**
- Symbol-level expand-on-click (function/class call graph within a file)
- Search, folder/extension filters, upstream/downstream highlight-on-select
- Cycle detection (Tarjan's SCC) + visual flagging

**Phase 3**
- Save/share graph snapshots (export JSON, export PNG/SVG of current view)
- Python support (via a second parser + shared intermediate graph schema)
- Cross-file symbol-level graph (not just per-file) for "who calls this exported function anywhere in the repo"
- VS Code extension wrapper that reuses the same graph-build core, rendered inline in the editor

## Open Questions
- Should function/class call-graph parsing use static analysis only (fast, some false negatives with dynamic calls) or attempt more advanced call resolution? MVP should stay static-only.
- How to handle very large codebases (10k+ files) in the force-directed layout without it becoming unreadable/slow — likely needs clustering by folder or a "load top N most-connected files" default view.
- Should the tool support monorepos (multiple `package.json`s) as one graph or separate graphs per package?
