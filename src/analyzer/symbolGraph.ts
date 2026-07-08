import fs from "node:fs";
import path from "node:path";
import {
  Project,
  SyntaxKind,
  Node,
  type SourceFile,
  type FunctionDeclaration,
  type VariableStatement,
  type ClassDeclaration,
  type MethodDeclaration,
} from "ts-morph";
import type { CallEdge, SymbolGraph, SymbolKind, SymbolNode } from "../types.js";
import { SOURCE_EXTENSIONS } from "./walk.js";

interface LocalSymbol {
  node: SymbolNode;
  bodyNode: Node;
  className?: string; // set for methods, used to resolve this.method() calls
}

function resolveModuleTarget(fromDir: string, specifier: string, rootDirAbs: string): string {
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
    // external package - keep the raw specifier as the target namespace
    return specifier;
  }

  const basePath = path.resolve(fromDir, specifier);
  const candidates: string[] = [basePath];
  for (const ext of SOURCE_EXTENSIONS) candidates.push(basePath + ext);
  for (const ext of SOURCE_EXTENSIONS) candidates.push(path.join(basePath, "index" + ext));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(rootDirAbs, candidate).split(path.sep).join("/");
    }
  }
  // couldn't resolve on disk; fall back to the raw specifier
  return specifier;
}

export function buildSymbolGraph(rootDir: string, fileId: string): SymbolGraph {
  const rootDirAbs = path.resolve(rootDir);
  const absoluteFilePath = path.join(rootDirAbs, fileId);

  if (!fs.existsSync(absoluteFilePath) || !fs.statSync(absoluteFilePath).isFile()) {
    throw new Error(`buildSymbolGraph: file not found: ${fileId} (resolved to ${absoluteFilePath})`);
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile: SourceFile = project.addSourceFileAtPath(absoluteFilePath);

  const symbols: LocalSymbol[] = [];
  const nameToSymbolId = new Map<string, string>(); // top-level function / const-arrow-fn names

  // top-level function declarations
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const id = `${fileId}#${name}`;
    const node: SymbolNode = {
      id,
      name,
      kind: "function",
      startLine: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
      isExported: fn.isExported(),
    };
    symbols.push({ node, bodyNode: fn });
    nameToSymbolId.set(name, id);
  }

  // classes + their methods
  const classMethodIds = new Map<string, Map<string, string>>(); // className -> methodName -> id
  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName();
    if (!className) continue;
    const classId = `${fileId}#${className}`;
    symbols.push({
      node: {
        id: classId,
        name: className,
        kind: "class",
        startLine: cls.getStartLineNumber(),
        endLine: cls.getEndLineNumber(),
        isExported: cls.isExported(),
      },
      bodyNode: cls,
    });

    const methodMap = new Map<string, string>();
    for (const method of cls.getMethods()) {
      const methodName = method.getName();
      const methodId = `${fileId}#${className}.${methodName}`;
      symbols.push({
        node: {
          id: methodId,
          name: methodName,
          kind: "method",
          startLine: method.getStartLineNumber(),
          endLine: method.getEndLineNumber(),
          isExported: cls.isExported(),
        },
        bodyNode: method,
        className,
      });
      methodMap.set(methodName, methodId);
    }
    classMethodIds.set(className, methodMap);
  }

  // top-level const arrow functions / function expressions
  for (const varStatement of sourceFile.getVariableStatements()) {
    if (varStatement.getParent() !== sourceFile) continue; // only top-level
    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;
      const kind = initializer.getKind();
      if (kind !== SyntaxKind.ArrowFunction && kind !== SyntaxKind.FunctionExpression) continue;

      const name = decl.getName();
      const id = `${fileId}#${name}`;
      symbols.push({
        node: {
          id,
          name,
          kind: "const-arrow-fn",
          startLine: varStatement.getStartLineNumber(),
          endLine: varStatement.getEndLineNumber(),
          isExported: varStatement.isExported(),
        },
        bodyNode: initializer,
      });
      nameToSymbolId.set(name, id);
    }
  }

  // imported identifier -> resolved target file id (or external module specifier)
  const importedNameToModule = new Map<string, string>();
  const fromDir = path.dirname(absoluteFilePath);
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const specifier = importDecl.getModuleSpecifierValue();
    const resolvedSourceFile = importDecl.getModuleSpecifierSourceFile();
    const moduleTarget = resolvedSourceFile
      ? path.relative(rootDirAbs, resolvedSourceFile.getFilePath()).split(path.sep).join("/")
      : resolveModuleTarget(fromDir, specifier, rootDirAbs);

    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) importedNameToModule.set(defaultImport.getText(), moduleTarget);
    const namespaceImport = importDecl.getNamespaceImport();
    if (namespaceImport) importedNameToModule.set(namespaceImport.getText(), moduleTarget);
    for (const named of importDecl.getNamedImports()) {
      const localName = named.getAliasNode()?.getText() ?? named.getName();
      importedNameToModule.set(localName, moduleTarget);
    }
  }

  const edgeKeys = new Set<string>();
  const edges: CallEdge[] = [];

  function addEdge(source: string, target: string, isExternalCall: boolean): void {
    const key = `${source}->${target}->${isExternalCall}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target, isExternalCall });
  }

  for (const symbol of symbols) {
    if (symbol.node.kind === "class") continue; // classes have no callable body of their own
    const callerId = symbol.node.id;
    const callExpressions = symbol.bodyNode.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const callExpr of callExpressions) {
      const callee = callExpr.getExpression();

      if (Node.isIdentifier(callee)) {
        const name = callee.getText();
        if (name === "require") continue;

        const localId = nameToSymbolId.get(name);
        if (localId && localId !== callerId) {
          addEdge(callerId, localId, false);
          continue;
        }

        const moduleTarget = importedNameToModule.get(name);
        if (moduleTarget) {
          addEdge(callerId, `${moduleTarget}#${name}`, true);
        }
        continue;
      }

      if (Node.isPropertyAccessExpression(callee)) {
        const objectExpr = callee.getExpression();
        const propertyName = callee.getName();

        if (objectExpr.getKind() === SyntaxKind.ThisKeyword && symbol.className) {
          const methodMap = classMethodIds.get(symbol.className);
          const methodId = methodMap?.get(propertyName);
          if (methodId && methodId !== callerId) {
            addEdge(callerId, methodId, false);
          }
          continue;
        }

        if (Node.isIdentifier(objectExpr)) {
          const objectName = objectExpr.getText();
          const moduleTarget = importedNameToModule.get(objectName);
          if (moduleTarget) {
            addEdge(callerId, `${moduleTarget}#${propertyName}`, true);
          }
        }
      }
    }
  }

  return {
    file: fileId,
    nodes: symbols.map((s) => s.node),
    edges,
  };
}
