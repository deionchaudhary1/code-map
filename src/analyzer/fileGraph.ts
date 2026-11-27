import fs from "node:fs";
import path from "node:path";
import { Project, SyntaxKind, type SourceFile } from "ts-morph";
import type { FileGraph, FileNode, ImportEdge, RouteDefinition } from "../types.js";
import { walkSourceFiles, type WalkOptions } from "./walk.js";
import { createModuleResolver } from "./moduleResolver.js";
import { tarjanSCC } from "./scc.js";
import { collectRoutes } from "./routes.js";
import { collectApiCalls, resolveApiCalls } from "./apiCalls.js";

function toFileId(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

function toFolder(fileId: string): string {
  const slashIndex = fileId.indexOf("/");
  return slashIndex === -1 ? "." : fileId.slice(0, slashIndex);
}

function getExportedNames(sourceFile: SourceFile): string[] {
  const names = new Set<string>();
  for (const [name] of sourceFile.getExportedDeclarations()) {
    names.add(name);
  }
  return Array.from(names);
}

interface RawEdge {
  sourceFileAbs: string;
  targetFileAbs: string;
  importedSymbols: string[];
  isTypeOnly: boolean;
  line: number;
}

function collectEdgesForFile(
  sourceFile: SourceFile,
  fileAbsPath: string,
  walkedSet: Set<string>,
  resolveModule: ReturnType<typeof createModuleResolver>,
): RawEdge[] {
  const edges: RawEdge[] = [];

  function resolveTarget(specifier: string): string | undefined {
    const target = resolveModule(specifier, fileAbsPath);
    return target && walkedSet.has(target) ? target : undefined;
  }

  // import declarations
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const specifier = importDecl.getModuleSpecifierValue();
    const target = resolveTarget(specifier);
    if (!target) continue;

    const importedSymbols: string[] = [];
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) importedSymbols.push("default");
    const namespaceImport = importDecl.getNamespaceImport();
    if (namespaceImport) importedSymbols.push("*");
    for (const named of importDecl.getNamedImports()) {
      importedSymbols.push(named.getName());
    }

    edges.push({
      sourceFileAbs: fileAbsPath,
      targetFileAbs: target,
      line: importDecl.getStartLineNumber(),
      importedSymbols,
      isTypeOnly: importDecl.isTypeOnly() || (
        !defaultImport && !namespaceImport && importDecl.getNamedImports().length > 0 &&
        importDecl.getNamedImports().every((named) => named.isTypeOnly())
      ),
    });
  }

  // re-exports: export { x } from './y'; export * from './y'
  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const specifier = exportDecl.getModuleSpecifierValue();
    if (!specifier) continue; // local re-export, e.g. `export { x }`
    const target = resolveTarget(specifier);
    if (!target) continue;

    const importedSymbols: string[] = [];
    const namedExports = exportDecl.getNamedExports();
    if (namedExports.length === 0) {
      importedSymbols.push("*");
    } else {
      for (const named of namedExports) importedSymbols.push(named.getName());
    }

    edges.push({
      sourceFileAbs: fileAbsPath,
      targetFileAbs: target,
      line: exportDecl.getStartLineNumber(),
      importedSymbols,
      isTypeOnly: exportDecl.isTypeOnly() || (
        namedExports.length > 0 && namedExports.every((named) => named.isTypeOnly())
      ),
    });
  }

  // require('./x') calls
  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = callExpr.getExpression();
    if (expr.getKind() !== SyntaxKind.Identifier || expr.getText() !== "require") continue;
    const [arg] = callExpr.getArguments();
    if (!arg || arg.getKind() !== SyntaxKind.StringLiteral) continue;
    const specifier = arg.getText().slice(1, -1);
    const target = resolveTarget(specifier);
    if (!target) continue;

    edges.push({
      sourceFileAbs: fileAbsPath,
      targetFileAbs: target,
      line: callExpr.getStartLineNumber(),
      importedSymbols: ["*"],
      isTypeOnly: false,
    });
  }

  return edges;
}

export function buildFileGraph(rootDir: string, options: WalkOptions = {}): FileGraph {
  const absoluteRoot = path.resolve(rootDir);
  const filePaths = walkSourceFiles(absoluteRoot, options);
  const walkedSet = new Set(filePaths);
  const resolveModule = createModuleResolver(absoluteRoot);

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
    },
  });

  let skippedFiles = 0;
  const sourceFiles = new Map<string, SourceFile>();

  for (const filePath of filePaths) {
    try {
      const sf = project.addSourceFileAtPath(filePath);
      sourceFiles.set(filePath, sf);
    } catch {
      skippedFiles += 1;
    }
  }

  const nodes: FileNode[] = [];
  const rawEdges: RawEdge[] = [];
  const routes: RouteDefinition[] = [];
  const detectedCalls: Array<ReturnType<typeof collectApiCalls>[number] & { source: string }> = [];

  for (const filePath of filePaths) {
    const sourceFile = sourceFiles.get(filePath);
    if (!sourceFile) continue;
    // Config errors should reach the CLI instead of looking like missing edges.
    resolveModule.validateFile(filePath);

    const fileId = toFileId(absoluteRoot, filePath);
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(filePath).size;
    } catch {
      // leave as 0 if stat fails
    }

    let exportsList: string[] = [];
    try {
      exportsList = getExportedNames(sourceFile);
    } catch {
      // leave as empty on failure to compute exports
    }

    nodes.push({
      id: fileId,
      extension: path.extname(filePath),
      sizeBytes,
      exports: exportsList,
      isEntryPoint: true, // corrected below once edges are known
      folder: toFolder(fileId),
    });

    try {
      rawEdges.push(...collectEdgesForFile(sourceFile, filePath, walkedSet, resolveModule));
    } catch {
      // if edge collection throws for this file, treat as no edges from it
    }

    try {
      routes.push(...collectRoutes(sourceFile, fileId));
    } catch {
      // a file that fails route scanning simply contributes no routes
    }

    try {
      for (const call of collectApiCalls(sourceFile)) {
        detectedCalls.push({ ...call, source: fileId });
      }
    } catch {
      // a file that fails API-call scanning simply contributes no calls
    }
  }

  const edges: ImportEdge[] = rawEdges.map((raw) => ({
    source: toFileId(absoluteRoot, raw.sourceFileAbs),
    target: toFileId(absoluteRoot, raw.targetFileAbs),
    line: raw.line,
    importedSymbols: raw.importedSymbols,
    isTypeOnly: raw.isTypeOnly,
    inCycle: false,
  }));

  const importedTargets = new Set(edges.map((e) => e.target));
  for (const node of nodes) {
    node.isEntryPoint = !importedTargets.has(node.id);
  }

  const nodeIds = nodes.map((n) => n.id);
  const cycles = tarjanSCC(nodeIds, edges);
  const sccIndexById = new Map<string, number>();
  cycles.forEach((component, idx) => {
    for (const id of component) sccIndexById.set(id, idx);
  });

  for (const edge of edges) {
    const sourceScc = sccIndexById.get(edge.source);
    const targetScc = sccIndexById.get(edge.target);
    if (sourceScc !== undefined && sourceScc === targetScc) {
      edge.inCycle = true;
    }
  }

  const { apiCalls, endpoints } = resolveApiCalls(detectedCalls, routes);

  return {
    root: absoluteRoot,
    nodes,
    edges,
    apiCalls,
    endpoints,
    routes,
    cycles,
    stats: {
      fileCount: nodes.length,
      edgeCount: edges.length,
      cycleCount: cycles.length,
      skippedFiles,
      apiCallCount: apiCalls.length,
      routeCount: routes.length,
    },
  };
}
