# Architecture demo fixture

This is synthetic code for exploring code-map, not a deployed application. `node main.mjs` runs the project listing and formatting path without packages or network requests. The unused frontend and route registrar demonstrate how static HTTP edges connect files that have no import between them. The unused legacy pair deliberately contains a circular import.

From the code-map repository root, after building:

```sh
npm run demo
```

Expect 10 files, nine imports, one cycle, two API calls, and two routes. The runtime overlay shows the five files executed by `node main.mjs`. Select `services/project-service.mjs` to inspect the called `listProjects` and the uncalled `findProject` function. **Cycles only** isolates the unused legacy pair; **API calls only** shows the client-to-server links. No LLM is required.
