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
