import { SyntaxKind, type SourceFile, type CallExpression } from "ts-morph";
import type { HttpMethod, RouteDefinition } from "../types.js";

const ROUTE_METHODS = new Set(["get", "post", "put", "delete", "patch", "all"]);

/**
 * Receiver names treated as route registrars. Express apps are conventionally
 * named `app` or `router`; anything else would need type resolution to confirm,
 * which is more machinery than this heuristic warrants.
 */
const ROUTE_RECEIVERS = new Set(["app", "router", "server", "api"]);

function literalPath(call: CallExpression): string | undefined {
  const [first] = call.getArguments();
  if (!first) return undefined;
  if (
    first.getKind() === SyntaxKind.StringLiteral ||
    first.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return first.getText().slice(1, -1);
  }
  return undefined;
}

/**
 * Finds Express-style route registrations: `app.get("/users", handler)`,
 * `router.post("/users/:id", handler)`. Only literal paths on conventionally
 * named receivers are collected — see ROUTE_RECEIVERS.
 */
export function collectRoutes(sourceFile: SourceFile, fileId: string): RouteDefinition[] {
  const routes: RouteDefinition[] = [];

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;

    const access = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const methodName = access.getName().toLowerCase();
    if (!ROUTE_METHODS.has(methodName)) continue;

    const receiver = access.getExpression().getText();
    const receiverTail = receiver.split(".").pop() ?? receiver;
    if (!ROUTE_RECEIVERS.has(receiverTail)) continue;

    const routePath = literalPath(call);
    if (routePath === undefined || !routePath.startsWith("/")) continue;

    // A route needs a handler argument; `app.get(name)` is Express's config getter.
    if (call.getArguments().length < 2) continue;

    routes.push({
      file: fileId,
      method: (methodName === "all" ? "unknown" : methodName.toUpperCase()) as HttpMethod,
      path: routePath,
      line: call.getStartLineNumber(),
    });
  }

  return routes;
}

/** Splits a URL path into segments, ignoring query string and trailing slash. */
function pathSegments(url: string): string[] {
  const withoutQuery = url.split("?")[0].split("#")[0];
  return withoutQuery.split("/").filter((s) => s.length > 0);
}

/**
 * True when a called URL matches a registered route path, treating `:param`
 * segments in the route (and normalized `:param` segments in the call) as
 * wildcards. Express wildcards (`*`) match any single segment here.
 */
export function routeMatchesUrl(routePath: string, url: string): boolean {
  const routeParts = pathSegments(routePath);
  const urlParts = pathSegments(url);
  if (routeParts.length !== urlParts.length) return false;

  return routeParts.every((routePart, i) => {
    if (routePart.startsWith(":") || routePart === "*") return true;
    const urlPart = urlParts[i];
    if (urlPart.startsWith(":")) return true; // normalized template placeholder
    return routePart === urlPart;
  });
}
