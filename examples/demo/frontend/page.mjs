import { loadProjects } from "./api.mjs";
import { formatSummary } from "./format.mjs";

export async function renderPage() {
  return formatSummary(await loadProjects());
}
