export function formatSummary(projects) {
  return `${projects.length} active projects: ${projects.map((project) => project.name).join(", ")}`;
}
