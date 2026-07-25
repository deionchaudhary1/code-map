import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphLink, GraphNode } from "../graphModel";
import { layoutGraph, type LayoutOptions, type LayoutResult } from "./elk";

export interface LayoutState {
  status: "pending" | "ready" | "failed";
  /** The last successful layout — kept while a new one computes, so the
   * canvas keeps showing the old diagram instead of blanking. */
  result: LayoutResult | null;
  error: string | null;
}

const MAX_CACHED_LAYOUTS = 12;

/**
 * Layout depends only on which nodes and links are visible plus the layout
 * options — not on selection, search or hover, which are draw-time concerns.
 */
function layoutKey(nodes: GraphNode[], links: GraphLink[], options: LayoutOptions): string {
  return [
    options.direction,
    options.uniformWidth ? "uniform" : "fit",
    nodes.map((n) => n.id).join(","),
    links.map((l) => l.linkId).join(","),
  ].join("|");
}

export function useLayout(
  nodes: GraphNode[],
  links: GraphLink[],
  options: LayoutOptions
): LayoutState {
  const key = useMemo(() => layoutKey(nodes, links, options), [nodes, links, options]);
  const cache = useRef(new Map<string, LayoutResult>());
  const currentKey = useRef(key);

  const [state, setState] = useState<LayoutState>({
    status: "pending",
    result: null,
    error: null,
  });

  useEffect(() => {
    currentKey.current = key;

    const cached = cache.current.get(key);
    if (cached) {
      setState({ status: "ready", result: cached, error: null });
      return;
    }

    setState((prev) => ({ status: "pending", result: prev.result, error: null }));

    layoutGraph(nodes, links, options).then(
      (result) => {
        cache.current.set(key, result);
        if (cache.current.size > MAX_CACHED_LAYOUTS) {
          cache.current.delete(cache.current.keys().next().value as string);
        }
        if (currentKey.current !== key) return; // a newer layout superseded this one
        setState({ status: "ready", result, error: null });
      },
      (err: unknown) => {
        if (currentKey.current !== key) return;
        setState((prev) => ({
          status: "failed",
          result: prev.result,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    );
    // `nodes`/`links`/`options` are fully described by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
