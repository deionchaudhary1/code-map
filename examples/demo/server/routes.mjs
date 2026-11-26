import { listProjects, findProject } from "../services/project-service.mjs";

export function registerRoutes(app) {
  app.get("/api/projects", (_request, response) => response.json(listProjects()));
  app.get("/api/projects/:id", (request, response) => response.json(findProject(request.params.id)));
}
