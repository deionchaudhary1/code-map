# Hosted Mode

## Goal

Today code-map only runs locally: `npx tsx src/cli.ts /path/to/project` walks a directory already on your disk, analyzes it in-process, and serves the graph from a single Express server that holds exactly one graph and one root directory for its whole lifetime. There's no way to point someone at a URL and have them get a code map without cloning the tool and running it themselves.

This adds a **hosted mode**: a web app where a user uploads a zip of their codebase or pastes a public GitHub URL, and gets the same interactive graph in their browser — no install. AI "explain this connection" keeps working the same way it does today (free, local, no API cost) by having the *browser* call the user's own Ollama instance directly at `localhost:11434`, rather than routing explanations through a cloud LLM or through the hosted backend.

This is additive. The local CLI path (`src/cli.ts`, `src/server.ts`, `src/llm/ollama.ts`, `src/llm/explain.ts`'s combined `explain()`) is not modified and must keep working exactly as it does now.

## Why this is feasible

The analyzer (`src/analyzer/*`) only does static parsing via ts-morph against `fs.readdirSync`/`readFileSync` on *some* local directory — it has no hard-coded assumption about *which* directory, so it runs unmodified against a freshly extracted zip or a freshly cloned repo. The graph schema (`FileGraph` in `src/types.ts`) is already plain JSON aside from one field (`root`, an absolute path) that needs scrubbing before being sent to a browser. The frontend (`GraphCanvas`, `graphModel.ts`, `elk.ts`) only ever consumes `FileGraph` JSON and doesn't care how it was produced.

The two things that don't carry over as-is: `server.ts` holds one graph/one root directory in module scope for the process's whole life (fine for "one CLI invocation," not fine for many concurrent hosted users), and `/api/explain` currently does prompt-assembly *and* the Ollama call server-side — hosted mode needs to split those, since only the browser can reach the user's local Ollama.

## Architecture

```
Browser (SPA served by the hosted backend itself — same origin)
  │
  ├─ GET /api/config ──────────────────► { mode: "hosted" | "local", ... }
  │      (runtime mode detection: ONE frontend build works for both servers)
  │
  ├─ upload zip / paste GitHub URL ──► Hosted backend
  │                                       │
  │                                       ├─ extract zip (guarded) or shallow git clone (guarded)
  │                                       │    → per-session temp dir
  │                                       ├─ buildFileGraph(tempDir)   [existing analyzer, unmodified]
  │                                       └─ store session { id, tempDir, graph }, return { sessionId, graph }
  │
  ├─ GET  /api/sessions/:id/graph
  ├─ GET  /api/sessions/:id/symbols?file=...     (existing buildSymbolGraph, unmodified)
  ├─ POST /api/sessions/:id/explain-context      (NEW — assembles prompt server-side, does NOT call Ollama)
  │
  └─ "Explain" click → fetch explain-context from backend → POST directly to
       http://localhost:11434/api/generate (user's own Ollama, browser → localhost, no backend involved)
```

Sessions are in-memory (`Map<string, Session>`), TTL-swept (default 30 min idle), each backed by a temp directory on disk that's deleted on expiry. No Redis/DB — matches the project's current "no external infra" posture; the tradeoff (sessions don't survive a backend restart, no horizontal scaling without a shared store) is fine for v1 and documented as a known limitation.

### Three simplifications over the obvious design

These are deliberate departures from the first draft of this plan, each removing a dependency or a build-time knob:

1. **The hosted backend serves the frontend itself**, exactly as `src/server.ts` already does via `express.static(web/dist)`. Frontend and API are therefore same-origin, which means **no CORS middleware, no `cors` dependency, and no `VITE_API_BASE_URL`**. Deployment is one Node container rather than a static host plus an API host — simpler, and reversible later if splitting is ever wanted.
2. **Mode is detected at runtime via `GET /api/config`, not at build time.** A build-time `VITE_HOSTED_MODE` flag would require two different `web/dist` builds from one directory, which `npm run build` can't produce. Runtime detection means one build works under either server, and `web/dist` stays a single artifact.
3. **No `multer` and no `simple-git`.** The zip upload is posted as a raw body (`Content-Type: application/zip`) and read with the built-in `express.raw({ limit })` — the browser can `fetch(url, { body: file })` a `File` directly, so multipart buys nothing here. The clone shells out through `child_process.execFile("git", [...])`, which takes an argument array (no shell, so no injection surface) and supports a native `timeout`. That leaves just two new dependencies: `adm-zip` and `express-rate-limit`.

## New backend surface

- **`src/session/store.ts`** — `createSession`, `getSession`, `touchSession`, `deleteSession`, `startCleanupSweep(intervalMs, ttlMs)`. Every route touches the session on entry so TTL tracks last activity, not creation time.
- **`src/session/scrub.ts`** — `scrubGraphForClient(graph)`: returns the graph with `root` blanked before it goes out over the wire. The *stored* session graph keeps the real temp-dir path, since `/symbols` and `/explain-context` still need to resolve files on disk; only outbound JSON is scrubbed.
- **`src/ingest/zip.ts`** — `extractZipToSession(buffer, session, { maxFiles, maxUncompressedBytes })` using `adm-zip`. Entries are iterated and written manually rather than via `extractAllTo`, since that helper is where adm-zip's historical traversal CVEs lived. Guards, enforced *while iterating entries* (not after full extraction):
  - zip-slip: resolve each entry path, reject if it escapes `session.tempDir`, reject absolute paths / `..` segments outright
  - zip-bomb: abort once cumulative uncompressed bytes or file count exceeds the cap
  - reject symlink entries entirely
- **`src/ingest/gitClone.ts`** — `validateGitHubUrl(url)` + `cloneToSession(url, session, { timeoutMs, depth: 1 })` using `child_process.execFile` (argument array, no shell, native timeout). Guards:
  - `https:` only, hostname must be exactly `github.com` (or an allowlist env var later), path must look like `/owner/repo`, no credentials/query/fragment in the URL
  - resolve the hostname's IP and reject private/loopback/link-local ranges before cloning (DNS-rebinding-resistant SSRF guard)
  - shallow clone (`--depth 1 --single-branch`), clone timeout, post-clone working-tree size check
  - `GIT_TERMINAL_PROMPT=0` in the child env so a private/nonexistent repo fails fast instead of blocking on a credential prompt
  - private repos are out of scope for v1 — surface a clear "public repos only" error rather than a generic failure
- **`src/hostedServer.ts`** — new Express app (separate from `src/server.ts`, which stays untouched for local mode). Serves `web/dist` statically like the local server, so everything is same-origin and no CORS middleware is required. `express-rate-limit` is applied specifically to `/upload` and `/clone` (the expensive, abuse-prone routes). Routes: `GET /api/config`, `POST /api/upload` (`express.raw`, size-capped), `POST /api/clone`, `GET /api/sessions/:id/graph`, `GET /api/sessions/:id/symbols`, `POST /api/sessions/:id/explain-context`, `DELETE /api/sessions/:id`.
- **`src/server.ts`** — gains exactly one route, `GET /api/config`, returning `{ mode: "local", aiEnabled, ollamaModel }`. This is the only change to local mode, and it's additive.
- **`src/llm/explain.ts`** — no behavior change; just export the already-private `SYSTEM_PROMPT` constant and reuse `buildPrompt` (already pure/disk-reading, already separate from the Ollama call) for the new `/explain-context` route. `parseExplainTarget` moves out of `src/server.ts` into a shared `src/llm/explainTarget.ts` so both servers import it instead of duplicating it.
- **`src/analyzer/walk.ts`** — add an optional `maxFiles` param to `walkSourceFiles` (default unchanged/unlimited, so local CLI behavior is untouched); hosted mode passes an explicit cap (e.g. 5000) and rejects outright rather than silently truncating.
- **`src/types.ts`** — add `ExplainContextResponse { prompt, system, cacheKey, suggestedModel }`, mirrored into `web/src/types.ts` per the existing copy convention, and documented alongside the other three routes in the API-contract comment block.

Known limitation to flag, not solve now: `buildFileGraph` is synchronous and CPU-bound, so a pathological repo can block the event loop for the whole process even with a request timeout wrapped around it. The file-count/size caps are the real mitigation; a worker-thread/child-process isolation is a reasonable follow-up, not v1 scope.

## Frontend changes

- **`web/src/api.ts`** — the existing `fetchFileGraph`/`fetchSymbolGraph` take an **API prefix** argument instead of hardcoding `/api`. Local mode passes `"/api"`; hosted mode passes `"/api/sessions/<id>"`. Because the route shapes below the prefix are identical in both modes, this single parameter removes what would otherwise be mode-branching in every data-fetching call site. Add `fetchConfig`, `uploadZip`, `cloneRepo`, and `fetchExplainContext`.
- **`web/src/ollamaClient.ts`** (new) — a near-verbatim browser port of `src/llm/ollama.ts`'s `generate`/`checkAvailability`, taking `host`/`model` as explicit params instead of reading `process.env.OLLAMA_HOST` (which doesn't exist in a browser).
- **`web/src/OllamaConfigContext.tsx`** (new) — `{ host, model }` state, defaulted to `localhost:11434` / `llama3.1:8b`, persisted to `localStorage`.
- **`web/src/components/OllamaSettings.tsx`** (new) — host/model inputs, a "test connection" button, and a persistent, visible note about `OLLAMA_ORIGINS` (Ollama enforces its own `Origin` allowlist independent of this app — a hosted frontend calling a user's `localhost:11434` needs the user to run `OLLAMA_ORIGINS=https://<hosted-domain> ollama serve`). Surface this inline when an explain call fails with a network/CORS-shaped error too, not just in settings — a bare CORS failure gives an unhelpful generic browser error otherwise.
- **`web/src/components/UploadScreen.tsx`** (new) — zip picker + GitHub URL field, shown before a session exists in hosted mode; on success stores `sessionId` and proceeds to the existing graph view unchanged.
- **`web/src/components/SidePanel.tsx`** — `ExplainSection` branches: local mode keeps the existing single-call `fetchExplanation`; hosted mode does `fetchExplainContext(sessionId, target)` → `ollamaClient.generate({ ...ctx, host, model })`, with a small client-side cache (`Map`, keyed by the `cacheKey` the server already computes and returns) replacing the local-mode server-side cache for this path.
- **`web/src/App.tsx`** — fetches `/api/config` on mount. Local mode then fetches the graph immediately as today (mock-data dev fallback preserved); hosted mode shows `UploadScreen` first and fetches only after a session exists.

## New dependencies

`adm-zip` and `express-rate-limit` (+ `@types/adm-zip`). Everything else uses what's already there or Node built-ins.

## Deployment shape

The backend needs to spawn `git clone`, write to a real filesystem, and run synchronous CPU work — that rules out typical no-persistent-disk serverless functions. A single small long-running Node process on a container/VM host (Fly.io, Render, Railway, or a droplet) is enough, serving both the API and the built SPA; session temp dirs are meant to expire anyway, so ephemeral instance storage is fine. Worth a `/cost-check` pass once a specific host is picked, since this moves the project from "free, zero infra" to "small but nonzero hosting cost."

## Implementation order

1. `walk.ts` file-count cap, `types.ts` `ExplainContextResponse` + `AppConfig` + doc update — small, unblocks the rest.
2. `explain.ts` export `SYSTEM_PROMPT`, extract shared `parseExplainTarget` into `src/llm/explainTarget.ts`, add `/api/config` to `src/server.ts`.
3. `src/session/store.ts` + `src/session/scrub.ts` — pure logic, no external deps, easiest to test in isolation.
4. `src/ingest/zip.ts` + `src/ingest/gitClone.ts` — the actual security-sensitive code (zip-slip, zip-bomb, SSRF guards); worth deliberate test cases for each guard before wiring into routes.
5. `src/hostedServer.ts` + `src/hostedCli.ts` — wire routes and rate limiting.
6. Frontend: `api.ts` prefix support, `ollamaClient.ts`, `OllamaConfigContext`/`OllamaSettings`, `UploadScreen`, `App.tsx`/`SidePanel.tsx` mode branching.
7. End-to-end pass: confirm local CLI mode is unchanged; test hosted upload flow, hosted clone flow (including a rejected private/invalid URL and an oversized zip), and hosted explain flow against a real local Ollama with `OLLAMA_ORIGINS` set.

## Verification

- Local mode regression: `npx tsx src/cli.ts .` still analyzes and serves as before, `/api/explain` still round-trips through Ollama server-side unchanged.
- Hosted mode: run `npm run build`, start the hosted server, open it; upload a small zip and confirm the graph renders; paste a small public GitHub repo URL and confirm clone + graph render; click "explain" on an edge with local Ollama running and `OLLAMA_ORIGINS` set, confirm the explanation comes back from the browser's direct call.
- Security guards: attempt a zip with a `../../etc/passwd`-style entry (must be rejected), a zip exceeding the uncompressed-size cap (must abort early, not after full extraction), and clone URLs targeting `http://`, non-github.com hosts, and a hostname resolving to a private IP (all must be rejected before `git clone` runs).
- Session lifecycle: confirm an expired/unknown session id returns 404 rather than 500, and that its temp directory is gone from disk after the sweep.
