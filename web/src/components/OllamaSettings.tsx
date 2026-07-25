import { useState } from "react";
import { useOllamaConfig } from "../OllamaConfigContext";
import { checkAvailability, type AvailabilityResult } from "../ollamaClient";

/**
 * The origin note is the important part of this panel. Ollama rejects requests
 * from origins it wasn't told about, and the browser reports that rejection as
 * an indistinguishable network error — so a user whose Ollama is running fine
 * sees "could not reach Ollama" with no hint about the actual fix.
 */
export function OllamaOriginHelp() {
  const origin = window.location.origin;
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin);

  if (isLocalhost) {
    return (
      <p className="hint">
        This page is served from localhost, which Ollama allows by default — no extra setup needed.
      </p>
    );
  }

  return (
    <>
      <p className="hint">
        Explanations run on <strong>your</strong> machine, so nothing about your code is sent
        anywhere. Ollama only accepts browser requests from origins it has been told to trust, so
        start it like this:
      </p>
      <pre className="code-block">OLLAMA_ORIGINS={origin} ollama serve</pre>
    </>
  );
}

export default function OllamaSettings({ onClose }: { onClose: () => void }) {
  const { host, model, setConfig } = useOllamaConfig();
  const [draftHost, setDraftHost] = useState(host);
  const [draftModel, setDraftModel] = useState(model);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AvailabilityResult | null>(null);

  async function handleTest() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await checkAvailability(draftHost, draftModel));
    } finally {
      setTesting(false);
    }
  }

  function handleSave() {
    setConfig({ host: draftHost.trim(), model: draftModel.trim() });
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>AI explanations</h2>

        <label className="field">
          <span>Ollama host</span>
          <input
            type="text"
            value={draftHost}
            onChange={(e) => setDraftHost(e.target.value)}
            placeholder="http://localhost:11434"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Model</span>
          <input
            type="text"
            value={draftModel}
            onChange={(e) => setDraftModel(e.target.value)}
            placeholder="llama3.1:8b"
            spellCheck={false}
          />
        </label>

        {result?.models && result.models.length > 0 && (
          <div className="model-suggestions">
            {result.models.map((name) => (
              <button key={name} className="toggle-btn" onClick={() => setDraftModel(name)}>
                {name}
              </button>
            ))}
          </div>
        )}

        {result && (
          <div className={result.ok ? "test-result ok" : "test-result error"}>{result.message}</div>
        )}

        <OllamaOriginHelp />

        <div className="modal-actions">
          <button className="toggle-btn" onClick={handleTest} disabled={testing}>
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button className="toggle-btn active" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
