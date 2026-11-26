import { projects } from "../storage/projects.mjs";
import { isActive } from "../domain/project.mjs";

export function listProjects() {
  return projects.filter(isActive);
}

export function findProject(id) {
  return projects.find((project) => project.id === id);
}
