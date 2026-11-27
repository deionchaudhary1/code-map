import { SyntaxKind, type Node, type SourceFile, type CallExpression } from "ts-morph";
import type { ApiCallEdge, EndpointNode, HttpMethod, RouteDefinition } from "../types.js";
import { routeMatchesUrl } from "./routes.js";

const AXIOS_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "request"]);

const DYNAMIC_URL = "<dynamic>";

function normalizeMethod(raw: string): HttpMethod {
  const upper = raw.toUpperCase();
  if (upper === "GET" || upper === "POST" || upper === "PUT" || upper === "DELETE" || upper === "PATCH") {
    return upper;
  }
  return "unknown";
}

/**
 * Reads a node as a URL string when it is statically knowable. Template literals
 * keep their literal spans and collapse each `${...}` to ":param", so
 * `` `/users/${id}` `` becomes "/users/:param" and can still match a route.
 */
function readUrl(node: Node | undefined): { url: string; isDynamic: boolean } {
  if (!node) return { url: DYNAMIC_URL, isDynamic: true };

  if (
    node.getKind() === SyntaxKind.StringLiteral ||
    node.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return { url: node.getText().slice(1, -1), isDynamic: false };
  }

  if (node.getKind() === SyntaxKind.TemplateExpression) {
    const template = node.asKindOrThrow(SyntaxKind.TemplateExpression);
    let url = template.getHead().getLiteralText();
    for (const span of template.getTemplateSpans()) {
      url += ":param" + span.getLiteral().getLiteralText();
    }
    return { url, isDynamic: false };
  }

  return { url: DYNAMIC_URL, isDynamic: true };
}

/** Reads `method` off an object literal argument, e.g. `{ method: "POST" }`. */
function readMethodFromOptions(node: Node | undefined): HttpMethod | undefined {
  if (!node || node.getKind() !== SyntaxKind.ObjectLiteralExpression) return undefined;
  const objectLiteral = node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);

  const methodProp = objectLiteral.getProperty("method");
  if (!methodProp || methodProp.getKind() !== SyntaxKind.PropertyAssignment) return undefined;

  const initializer = methodProp.asKindOrThrow(SyntaxKind.PropertyAssignment).getInitializer();
  if (!initializer) return undefined;
  if (
    initializer.getKind() !== SyntaxKind.StringLiteral &&
    initializer.getKind() !== SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return undefined;
  }
  return normalizeMethod(initializer.getText().slice(1, -1));
}

/** Reads `url` off an object literal argument, e.g. `axios({ url: "/x" })`. */
function readUrlFromOptions(node: Node | undefined): { url: string; isDynamic: boolean } | undefined {
  if (!node || node.getKind() !== SyntaxKind.ObjectLiteralExpression) return undefined;
  const objectLiteral = node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);

  const urlProp = objectLiteral.getProperty("url");
  if (!urlProp || urlProp.getKind() !== SyntaxKind.PropertyAssignment) return undefined;

  return readUrl(urlProp.asKindOrThrow(SyntaxKind.PropertyAssignment).getInitializer());
}

interface DetectedCall {
  method: HttpMethod;
  url: string;
  isDynamic: boolean;
  client: ApiCallEdge["client"];
  line: number;
}

function detectCall(call: CallExpression): DetectedCall | undefined {
  const expr = call.getExpression();
  const args = call.getArguments();
  const line = call.getStartLineNumber();

  // fetch(url, { method }) — bare fetch defaults to GET, per the fetch spec.
  if (expr.getKind() === SyntaxKind.Identifier && expr.getText() === "fetch") {
    const { url, isDynamic } = readUrl(args[0]);
    return {
      method: readMethodFromOptions(args[1]) ?? "GET",
      url,
      isDynamic,
      client: "fetch",
      line,
    };
  }

  // axios(url, { method }) / axios({ url, method })
  if (expr.getKind() === SyntaxKind.Identifier && expr.getText() === "axios") {
    const fromOptions = readUrlFromOptions(args[0]);
    if (fromOptions) {
      return {
        method: readMethodFromOptions(args[0]) ?? "GET",
        url: fromOptions.url,
        isDynamic: fromOptions.isDynamic,
        client: "axios",
        line,
      };
    }
    const { url, isDynamic } = readUrl(args[0]);
    return {
      method: readMethodFromOptions(args[1]) ?? "GET",
      url,
      isDynamic,
      client: "axios",
      line,
    };
  }

  // axios.get(url) / api.post(url, body) / client.delete(url)
  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const access = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const methodName = access.getName().toLowerCase();
    if (!AXIOS_METHODS.has(methodName)) return undefined;

    const receiverTail = access.getExpression().getText().split(".").pop() ?? "";
    // Only receivers that look like an HTTP client — otherwise every `foo.get(x)`
    // (Map.get, cache.get, …) would be misread as a network call.
    if (!/^(axios|api|client|http|request|instance)$/i.test(receiverTail)) return undefined;

    if (methodName === "request") {
      const fromOptions = readUrlFromOptions(args[0]);
      if (!fromOptions) return undefined;
      return {
        method: readMethodFromOptions(args[0]) ?? "GET",
        url: fromOptions.url,
        isDynamic: fromOptions.isDynamic,
        client: "axios",
        line,
      };
    }

    const { url, isDynamic } = readUrl(args[0]);
    return {
      method: normalizeMethod(methodName),
      url,
      isDynamic,
      client: "axios",
      line,
    };
  }

  return undefined;
}

export function collectApiCalls(sourceFile: SourceFile): DetectedCall[] {
  const calls: DetectedCall[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const detected = detectCall(call);
    if (detected) calls.push(detected);
  }
  return calls;
}

export function endpointId(method: HttpMethod, url: string): string {
  return `endpoint::${method} ${url}`;
}

/**
 * Resolves each detected call to either the file registering a matching route or
 * a synthetic endpoint node. Dynamic URLs never match a route — there is nothing
 * to compare — but are still emitted so the call site stays visible.
 */
export function resolveApiCalls(
  detected: Array<DetectedCall & { source: string }>,
  routes: RouteDefinition[],
): { apiCalls: ApiCallEdge[]; endpoints: EndpointNode[] } {
  const apiCalls: ApiCallEdge[] = [];
  const endpointsById = new Map<string, EndpointNode>();

  for (const call of detected) {
    let target: string | undefined;
    let targetLine: number | undefined;

    if (!call.isDynamic) {
      const match = routes.find(
        (route) =>
          (route.method === call.method || route.method === "unknown" || call.method === "unknown") &&
          routeMatchesUrl(route.path, call.url),
      );
      if (match) {
        target = match.file;
        targetLine = match.line;
      }
    }

    if (!target) {
      const id = endpointId(call.method, call.url);
      if (!endpointsById.has(id)) {
        endpointsById.set(id, { id, method: call.method, url: call.url });
      }
      target = id;
    }

    apiCalls.push({
      id: `${call.source}::${call.method}::${call.url}`,
      source: call.source,
      method: call.method,
      url: call.url,
      isDynamic: call.isDynamic,
      client: call.client,
      line: call.line,
      target,
      ...(targetLine !== undefined ? { targetLine } : {}),
    });
  }

  return { apiCalls, endpoints: Array.from(endpointsById.values()) };
}
