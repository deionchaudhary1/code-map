// d3-force-3d ships no bundled types and there is no @types package for it.
// We only use forceCollide, so declare the minimal shape we need.
declare module "d3-force-3d" {
  export interface ForceCollide<NodeDatum> {
    (alpha: number): void;
    initialize(nodes: NodeDatum[], random?: () => number): void;
    radius(radius: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number)): ForceCollide<NodeDatum>;
    strength(strength: number): ForceCollide<NodeDatum>;
    iterations(iterations: number): ForceCollide<NodeDatum>;
  }

  export function forceCollide<NodeDatum = unknown>(
    radius?: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number)
  ): ForceCollide<NodeDatum>;
}
