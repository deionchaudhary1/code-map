export async function loadProjects() {
  const response = await fetch("/api/projects");
  return response.json();
}

export async function loadProject(id) {
  const response = await fetch(`/api/projects/${id}`);
  return response.json();
}
