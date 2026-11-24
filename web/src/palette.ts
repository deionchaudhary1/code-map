// Categorical palette for folder coloring, ordered so consecutive entries
// are maximally distinct. Colors are assigned sequentially per first-seen
// folder; node order from the server is stable, so assignment is stable
// within a session and the first few folders always get far-apart hues.

const PALETTE = [
  "#5b8dd6", // blue
  "#5bbf8a", // green
  "#d68f5b", // orange
  "#b06fd6", // purple
  "#d65b7a", // rose
  "#5bc2c2", // teal
  "#c2b25b", // olive
  "#8a8ad6", // indigo
  "#d65b5b", // red
  "#5bd6b0", // mint
  "#a3a3a3", // gray (overflow)
];

/**
 * Topics get their own ramp rather than reusing the folder one. There are only
 * ever 4-5 of them and they replace folder colors on screen, so they are pushed
 * brighter and further apart — a topic must not read as "some folder".
 */
const TOPIC_PALETTE = [
  "#4f9cf5", // bright blue
  "#48c78e", // bright green
  "#f5a03c", // amber
  "#c07ff0", // violet
  "#f56a86", // coral
  "#3fd0d0", // cyan (only reached if the 5-topic clamp is ever raised)
];

/** Files the model could not place, and that no import neighbour resolved. */
export const UNASSIGNED_COLOR = "#5a5f68";

const cache = new Map<string, string>();

export function colorForFolder(folder: string): string {
  const cached = cache.get(folder);
  if (cached) return cached;
  const color = PALETTE[Math.min(cache.size, PALETTE.length - 1)];
  cache.set(folder, color);
  return color;
}

export function allAssignedColors(folders: string[]): Array<{ folder: string; color: string }> {
  return folders.map((folder) => ({ folder, color: colorForFolder(folder) }));
}

/**
 * Colors are assigned by position in the TopicSet, not by a growing cache:
 * regenerating topics replaces the whole set, and a cache keyed on name would
 * hand the new set leftover colors from the old one.
 */
export function colorForTopicIndex(index: number): string {
  return TOPIC_PALETTE[index % TOPIC_PALETTE.length];
}
