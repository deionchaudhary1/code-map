import { listProjects } from "./services/project-service.mjs";
import { formatSummary } from "./frontend/format.mjs";

console.log(formatSummary(listProjects()));
