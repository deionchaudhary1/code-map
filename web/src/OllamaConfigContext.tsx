import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_OLLAMA_HOST, DEFAULT_OLLAMA_MODEL } from "./ollamaClient";

export interface OllamaConfig {
  host: string;
  model: string;
}

interface OllamaConfigValue extends OllamaConfig {
  setConfig: (next: Partial<OllamaConfig>) => void;
}

const STORAGE_KEY = "code-map.ollama";

function load(defaultModel: string): OllamaConfig {
  const fallback = { host: DEFAULT_OLLAMA_HOST, model: defaultModel };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<OllamaConfig>;
    return {
      host: typeof parsed.host === "string" && parsed.host ? parsed.host : fallback.host,
      model: typeof parsed.model === "string" && parsed.model ? parsed.model : fallback.model,
    };
  } catch {
    return fallback;
  }
}

const OllamaConfigContext = createContext<OllamaConfigValue>({
  host: DEFAULT_OLLAMA_HOST,
  model: DEFAULT_OLLAMA_MODEL,
  setConfig: () => {},
});

export function OllamaConfigProvider({
  children,
  defaultModel = DEFAULT_OLLAMA_MODEL,
}: {
  children: ReactNode;
  /** Model the server suggests; used only when the user hasn't chosen one. */
  defaultModel?: string;
}) {
  const [config, setState] = useState<OllamaConfig>(() => load(defaultModel));

  const setConfig = useCallback((next: Partial<OllamaConfig>) => {
    setState((prev) => {
      const merged = { ...prev, ...next };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {
        // Private browsing or a full quota — the setting just won't persist.
      }
      return merged;
    });
  }, []);

  const value = useMemo(() => ({ ...config, setConfig }), [config, setConfig]);
  return <OllamaConfigContext.Provider value={value}>{children}</OllamaConfigContext.Provider>;
}

export function useOllamaConfig(): OllamaConfigValue {
  return useContext(OllamaConfigContext);
}
