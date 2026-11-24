/**
 * Browser port of src/llm/ollama.ts. In hosted mode the model runs on the
 * user's own machine, so the request has to originate from their browser —
 * the server has no route to localhost:11434.
 *
 * Ollama enforces its own Origin allowlist, so a page served from anywhere
 * other than localhost needs the user to start Ollama with OLLAMA_ORIGINS set.
 * A blocked request surfaces as an opaque TypeError with no detail, which is
 * why isLikelyCorsFailure exists: it's the only signal available to tell the
 * user what actually went wrong.
 */

export class OllamaError extends Error {
  constructor(
    message: string,
    /** True when the failure looks like Ollama refusing this page's origin. */
    public readonly likelyCors = false,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "llama3.1:8b";

function normalizeHost(host: string): string {
  return host.trim().replace(/\/+$/, "") || DEFAULT_OLLAMA_HOST;
}

export interface GenerateOptions {
  host: string;
  model: string;
  prompt: string;
  system: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** "json" constrains Ollama's decoder to valid JSON. */
  format?: "json";
  /** Output token budget. Callers expecting long structured replies must raise
   * this — the default suits a few sentences of prose, nothing more. */
  numPredict?: number;
}

export async function generate({
  host,
  model,
  prompt,
  system,
  timeoutMs = 120_000,
  signal,
  format,
  numPredict = 300,
}: GenerateOptions): Promise<string> {
  const base = normalizeHost(host);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });

  let response: Response;
  try {
    response = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        system,
        stream: false,
        ...(format ? { format } : {}),
        options: { temperature: 0.2, num_predict: numPredict },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new OllamaError(
        `Ollama did not respond within ${Math.round(timeoutMs / 1000)}s. ` +
          "The model may still be loading — try again.",
      );
    }
    // fetch reports both "nothing is listening" and "CORS blocked it" as the
    // same opaque TypeError, so both possibilities have to be offered.
    throw new OllamaError(
      `Could not reach Ollama at ${base}. Make sure it is running (\`ollama serve\`) ` +
        "and that it allows requests from this page.",
      true,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    throw new OllamaError(`Model "${model}" is not available. Pull it with \`ollama pull ${model}\`.`);
  }
  if (response.status === 403) {
    throw new OllamaError(
      `Ollama refused a request from this page's origin (${window.location.origin}). ` +
        "Restart it with OLLAMA_ORIGINS set to allow this site.",
      true,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new OllamaError(`Ollama returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }

  const data = (await response.json()) as { response?: string };
  const text = (data.response ?? "").trim();
  if (!text) throw new OllamaError("Ollama returned an empty response.");
  return text;
}

export interface AvailabilityResult {
  ok: boolean;
  message: string;
  likelyCors?: boolean;
  /** Models the daemon reports, for the settings UI to offer. */
  models?: string[];
}

export async function checkAvailability(host: string, model: string): Promise<AvailabilityResult> {
  const base = normalizeHost(host);
  let response: Response;
  try {
    response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
  } catch {
    return {
      ok: false,
      likelyCors: true,
      message: `Could not reach Ollama at ${base}. It may not be running, or it may be blocking this page's origin.`,
    };
  }

  if (response.status === 403) {
    return {
      ok: false,
      likelyCors: true,
      message: `Ollama is running but refused this page's origin (${window.location.origin}).`,
    };
  }
  if (!response.ok) return { ok: false, message: `Ollama returned ${response.status}` };

  const data = (await response.json()) as { models?: Array<{ name: string }> };
  const names = (data.models ?? []).map((m) => m.name);
  // Ollama reports "llama3.1:8b"; accept a bare "llama3.1" as matching it.
  const found = names.some((n) => n === model || n.split(":")[0] === model.split(":")[0]);
  if (!found) {
    return {
      ok: false,
      models: names,
      message: `Connected, but "${model}" is not pulled. Run \`ollama pull ${model}\`.`,
    };
  }
  return { ok: true, models: names, message: `Connected — using ${model}.` };
}
