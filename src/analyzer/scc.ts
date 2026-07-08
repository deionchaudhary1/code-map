// Tarjan's strongly-connected-components algorithm over a directed graph
// expressed as node ids + edges. Used to detect circular imports.

export interface GraphEdgeLike {
  source: string;
  target: string;
}

/**
 * Returns the list of strongly connected components (each an array of node
 * ids) for the graph formed by `nodeIds` and `edges`. Components of size 1
 * are only returned when that node has a self-edge (source === target),
 * since a lone node with no self-loop is not a cycle.
 */
export function tarjanSCC(nodeIds: string[], edges: GraphEdgeLike[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const edge of edges) {
    const list = adjacency.get(edge.source);
    if (list) list.push(edge.target);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];

  const selfEdgeNodes = new Set<string>();
  for (const edge of edges) {
    if (edge.source === edge.target) selfEdgeNodes.add(edge.source);
  }

  function strongConnect(v: string): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);

      if (component.length >= 2 || (component.length === 1 && selfEdgeNodes.has(component[0]))) {
        result.push(component);
      }
    }
  }

  for (const id of nodeIds) {
    if (!indices.has(id)) strongConnect(id);
  }

  return result;
}
