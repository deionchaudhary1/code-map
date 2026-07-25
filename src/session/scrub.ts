import type { FileGraph } from "../types.js";

/**
 * Strips the server-side temp path from a graph before it goes to a browser.
 * Server code keeps the real `root` on the stored session because
 * `buildSymbolGraph` and the explain prompt builder resolve files against it;
 * the client never uses the field and has no business knowing the path.
 */
export function scrubGraphForClient(graph: FileGraph): FileGraph {
  return { ...graph, root: "" };
}
