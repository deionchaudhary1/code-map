const DEFAULT_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

/** Thrown when Ollama isn't reachable or the model isn't available, so the
 * server can answer 503 with actionable text instead of a generic failure. */
export class OllamaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaUnavailableError";
  }
}

interface GenerateOptions {
  model: string;
  prompt: string;
  system: string;
  /** Generation is capped so a slow local model can't hang a request forever. */
  timeoutMs?: number;
}

export async function generate({
  model,
  prompt,
  system,
  timeoutMs = 120_000,
}: GenerateOptions): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${DEFAULT_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        system,
        stream: false,
        options: { temperature: 0.2, num_predict: 300 },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new OllamaUnavailableError(
        `Ollama did not respond within ${Math.round(timeoutMs / 1000)}s. The model may still be loading — try again.`,
      );
    }
    throw new OllamaUnavailableError(
      `Could not reach Ollama at ${DEFAULT_HOST}. Start it with \`ollama serve\`.`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    throw new OllamaUnavailableError(
      `Model "${model}" is not available. Pull it with \`ollama pull ${model}\`.`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new OllamaUnavailableError(
      `Ollama returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }

  const data = (await response.json()) as { response?: string };
  const text = (data.response ?? "").trim();
  if (!text) throw new OllamaUnavailableError("Ollama returned an empty response.");
  return text;
}

/** Verifies the daemon is up and the model is pulled; used at CLI startup. */
export async function checkAvailability(model: string): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch(`${DEFAULT_HOST}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { ok: false, message: `Ollama returned ${response.status}` };

    const data = (await response.json()) as { models?: Array<{ name: string }> };
    const names = (data.models ?? []).map((m) => m.name);
    // Ollama reports "llama3.1:8b"; accept a bare "llama3.1" as matching it.
    const found = names.some((n) => n === model || n.split(":")[0] === model.split(":")[0]);
    if (!found) {
      return { ok: false, message: `model "${model}" not pulled (\`ollama pull ${model}\`)` };
    }
    return { ok: true, message: `using ${model}` };
  } catch {
    return { ok: false, message: `not running at ${DEFAULT_HOST}` };
  }
}
