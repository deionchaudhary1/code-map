import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileGraph, RuntimeSymbol, SymbolNode } from "../types.js";
import { buildSymbolGraph } from "../analyzer/index.js";

/** The subset of V8's coverage JSON this needs. */
interface V8Range {
  startOffset: number;
  endOffset: number;
  count: number;
}
interface V8Function {
  functionName: string;
  ranges: V8Range[];
  isBlockCoverage: boolean;
}
interface V8Script {
  scriptId: string;
  url: string;
  functions: V8Function[];
}

/** Per-function totals keyed by "<absolute file>::<startOffset>". */
interface FunctionHit {
  file: string;
  name: string;
  startOffset: number;
  count: number;
}

export interface CoverageResult {
  executedFiles: string[];
  fileHits: Record<string, number>;
  symbols: RuntimeSymbol[];
  unmappedFiles: string[];
}

/**
 * Reads every coverage-*.json in `coverageDir` and sums counts per function.
 *
 * Summing across files is required, not optional: NODE_V8_COVERAGE writes one
 * file per Node process, so `npm test` produces one for npm, one for the test
 * runner, and one per worker. Reading a single file reports whichever process
 * happened to be read last.
 */
function readMergedCoverage(coverageDir: string, rootDir: string): {
  hits: Map<string, FunctionHit>;
  files: Set<string>;
} {
  const hits = new Map<string, FunctionHit>();
  const files = new Set<string>();

  let entries: string[];
  try {
    entries = fs.readdirSync(coverageDir).filter((f) => f.endsWith(".json"));
  } catch {
    return { hits, files };
  }

  const rootPrefix = path.resolve(rootDir) + path.sep;

  for (const entry of entries) {
    let parsed: { result?: V8Script[] };
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(coverageDir, entry), "utf8"));
    } catch {
      continue; // a process killed mid-write leaves truncated JSON
    }

    for (const script of parsed.result ?? []) {
      if (!script.url.startsWith("file:")) continue; // node: internals, eval, wasm

      let absolute: string;
      try {
        absolute = fileURLToPath(script.url);
      } catch {
        continue;
      }

      // Everything outside the analyzed project is noise: node internals,
      // dependencies, and the test runner itself.
      if (!absolute.startsWith(rootPrefix)) continue;
      if (absolute.includes(`${path.sep}node_modules${path.sep}`)) continue;

      files.add(absolute);

      for (const fn of script.functions) {
        const range = fn.ranges[0];
        if (!range) continue;
        const key = `${absolute}::${range.startOffset}`;
        const existing = hits.get(key);
        if (existing) {
          existing.count += range.count;
        } else {
          hits.set(key, {
            file: absolute,
            name: fn.functionName,
            startOffset: range.startOffset,
            count: range.count,
          });
        }
      }
    }
  }

  return { hits, files };
}

/** Byte offset → 1-indexed line. V8 reports offsets; SymbolNode records lines. */
function offsetToLine(source: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Matches a coverage entry to a static symbol, by name first.
 *
 * Name has to lead, not offset. V8 reports byte offsets into whatever the
 * runtime actually evaluated, which for a TypeScript project is transpiled
 * output — a `.ts` file that is 7 965 bytes on disk is ~4 700 bytes once tsx
 * strips the types, so every offset lands in the wrong place. Matching
 * `buildFileGraph` by offset put it 36 lines earlier, inside a different
 * function, silently attributing its count to that one. `functionName`
 * survives transpilation; offsets do not.
 *
 * Line containment is kept only to disambiguate same-named symbols (a method
 * and a free function sharing a name), where it is a tiebreak rather than the
 * primary key.
 */
function matchSymbol(
  symbols: SymbolNode[],
  line: number,
  name: string,
): SymbolNode | undefined {
  // The module's top-level scope, or an anonymous callback: not a declaration
  // anyone can point at in the UI.
  if (!name) return undefined;

  // Methods are recorded as "Class.method"; V8 may report either form.
  const candidates = symbols.filter(
    (s) => s.name === name || s.id.endsWith(`#${name}`) || s.id.endsWith(`.${name}`),
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return candidates.find((s) => line >= s.startLine && line <= s.endLine) ?? candidates[0];
  }
  return undefined;
}

/**
 * Folds a coverage directory into per-file and per-symbol hit counts.
 *
 * Symbols that exist statically but never ran are emitted with `calls: 0`
 * rather than omitted — "present but dead" is the whole point of the feature,
 * and it can't be distinguished from "not analyzed" if the entry is missing.
 *
 * That only holds for files V8 actually evaluated. A file that was never
 * imported produces no coverage entry at all, so its functions are absent from
 * `symbols` entirely rather than present with `calls: 0`. Dead *files* are
 * still fully reported via `executedFiles`; building symbol graphs for every
 * unexecuted file to fill the gap would mean a ts-morph parse per file across
 * the whole repo, which is not worth it for a count.
 */
export function mapCoverage(
  coverageDir: string,
  graph: FileGraph,
  rootDir: string,
): CoverageResult {
  const { hits, files } = readMergedCoverage(coverageDir, rootDir);
  const rootAbs = path.resolve(rootDir);

  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const toFileId = (absolute: string) =>
    path.relative(rootAbs, absolute).split(path.sep).join("/");

  const fileHits: Record<string, number> = {};
  const executedFiles = new Set<string>();
  const unmappedFiles = new Set<string>();

  // Group hits by file so each file's symbol graph is built at most once.
  const hitsByFile = new Map<string, FunctionHit[]>();
  for (const hit of hits.values()) {
    const fileId = toFileId(hit.file);
    if (!nodeIds.has(fileId)) {
      unmappedFiles.add(fileId);
      continue;
    }
    const list = hitsByFile.get(fileId);
    if (list) list.push(hit);
    else hitsByFile.set(fileId, [hit]);
  }

  for (const absolute of files) {
    const fileId = toFileId(absolute);
    if (nodeIds.has(fileId)) executedFiles.add(fileId);
  }

  const symbols: RuntimeSymbol[] = [];

  for (const [fileId, fileHitList] of hitsByFile) {
    let source: string;
    let staticSymbols: SymbolNode[];
    try {
      source = fs.readFileSync(path.join(rootAbs, fileId), "utf8");
      staticSymbols = buildSymbolGraph(rootAbs, fileId).nodes;
    } catch {
      // A file that parses for coverage but not for ts-morph still counts as
      // executed; it just can't be broken down per symbol.
      continue;
    }

    const counts = new Map<string, number>();
    let fileTotal = 0;

    for (const hit of fileHitList) {
      // The empty-named function is the module's top-level scope: it tells us
      // the file was evaluated, but it is not a symbol anyone declared.
      if (hit.name === "") {
        fileTotal += hit.count;
        continue;
      }
      const line = offsetToLine(source, hit.startOffset);
      const matched = matchSymbol(staticSymbols, line, hit.name);
      if (!matched) continue;
      counts.set(matched.id, (counts.get(matched.id) ?? 0) + hit.count);
      fileTotal += hit.count;
    }

    fileHits[fileId] = fileTotal;

    for (const symbol of staticSymbols) {
      symbols.push({
        id: symbol.id,
        file: fileId,
        calls: counts.get(symbol.id) ?? 0,
        totalMs: 0,
        params: [],
        throwCount: 0,
        samples: [],
      });
    }
  }

  return {
    executedFiles: [...executedFiles].sort(),
    fileHits,
    symbols,
    unmappedFiles: [...unmappedFiles].sort(),
  };
}
