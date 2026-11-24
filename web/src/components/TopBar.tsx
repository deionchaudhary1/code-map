import type { Direction } from "../layout/elk";
import { useOllamaConfig } from "../OllamaConfigContext";

interface TopBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  folders: string[];
  selectedFolders: Set<string>;
  onToggleFolder: (folder: string) => void;
  extensions: string[];
  selectedExtensions: Set<string>;
  onToggleExtension: (extension: string) => void;
  cyclesOnly: boolean;
  onToggleCyclesOnly: () => void;
  apiOnly: boolean;
  onToggleApiOnly: () => void;
  direction: Direction;
  onToggleDirection: () => void;
  uniformWidth: boolean;
  onToggleUniformWidth: () => void;
  /** False only in local mode started with --no-ai; hides the topic button. */
  aiEnabled: boolean;
  hasTopics: boolean;
  topicMode: boolean;
  topicsLoading: boolean;
  topicsError: string | null;
  /** Called with the Ollama host/model, which only this component can read. */
  onGenerateTopics: (host: string, model: string) => void;
  onToggleTopicMode: () => void;
  /** True when a trace exists; the runtime controls are hidden without one. */
  hasRuntime: boolean;
  runtimeMode: boolean;
  onToggleRuntimeMode: () => void;
  hideUnexecuted: boolean;
  onToggleHideUnexecuted: () => void;
  /** Hosted mode adds the controls that only make sense with a session. */
  hosted: boolean;
  onOpenSettings: () => void;
  onReset: () => void;
}

export default function TopBar({
  search,
  onSearchChange,
  folders,
  selectedFolders,
  onToggleFolder,
  extensions,
  selectedExtensions,
  onToggleExtension,
  cyclesOnly,
  onToggleCyclesOnly,
  apiOnly,
  onToggleApiOnly,
  direction,
  onToggleDirection,
  uniformWidth,
  onToggleUniformWidth,
  aiEnabled,
  hasTopics,
  topicMode,
  topicsLoading,
  topicsError,
  onGenerateTopics,
  onToggleTopicMode,
  hasRuntime,
  runtimeMode,
  onToggleRuntimeMode,
  hideUnexecuted,
  onToggleHideUnexecuted,
  hosted,
  onOpenSettings,
  onReset,
}: TopBarProps) {
  const { host, model } = useOllamaConfig();

  return (
    <div className="top-bar">
      <input
        type="text"
        placeholder="Search filename..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />

      <div className="field-group">
        <span>Folders:</span>
        {folders.map((folder) => (
          <label key={folder}>
            <input
              type="checkbox"
              checked={selectedFolders.size === 0 || selectedFolders.has(folder)}
              onChange={() => onToggleFolder(folder)}
            />
            {folder}
          </label>
        ))}
      </div>

      <div className="field-group">
        <span>Ext:</span>
        {extensions.map((ext) => (
          <label key={ext}>
            <input
              type="checkbox"
              checked={selectedExtensions.size === 0 || selectedExtensions.has(ext)}
              onChange={() => onToggleExtension(ext)}
            />
            {ext}
          </label>
        ))}
      </div>

      <button
        className={`toggle-btn${cyclesOnly ? " active" : ""}`}
        onClick={onToggleCyclesOnly}
      >
        Cycles only
      </button>

      <button
        className={`toggle-btn${apiOnly ? " active" : ""}`}
        onClick={onToggleApiOnly}
      >
        API calls only
      </button>

      <button className="toggle-btn" onClick={onToggleDirection} title="Layout direction">
        {direction === "DOWN" ? "↓ Top-down" : "→ Left-right"}
      </button>

      <button
        className={`toggle-btn${uniformWidth ? " active" : ""}`}
        onClick={onToggleUniformWidth}
        title="Give every box the same width"
      >
        Uniform width
      </button>

      {aiEnabled && (
        <>
          <button
            className={`toggle-btn${topicMode ? " active" : ""}`}
            onClick={() => (hasTopics ? onToggleTopicMode() : onGenerateTopics(host, model))}
            disabled={topicsLoading}
            title={
              hasTopics
                ? "Color and connect files by AI-derived topic"
                : "Ask the model to group these files into 4-5 topics"
            }
          >
            {topicsLoading ? "Grouping…" : hasTopics ? "Topics" : "Group into topics"}
          </button>
          {hasTopics && !topicsLoading && (
            <button
              className="toggle-btn"
              onClick={() => onGenerateTopics(host, model)}
              title="Ask the model again"
            >
              ↻
            </button>
          )}
          {topicsError && <span className="top-bar-error">{topicsError}</span>}
        </>
      )}

      {hasRuntime && (
        <>
          <button
            className={`toggle-btn${runtimeMode ? " active" : ""}`}
            onClick={onToggleRuntimeMode}
            title="Show which code actually executed"
          >
            Runtime
          </button>
          {runtimeMode && (
            <button
              className={`toggle-btn${hideUnexecuted ? " active" : ""}`}
              onClick={onToggleHideUnexecuted}
              title="Hide files that never executed"
            >
              Hide unexecuted
            </button>
          )}
        </>
      )}

      {hosted && (
        <div className="top-bar-right">
          <button className="toggle-btn" onClick={onOpenSettings} title="Configure Ollama">
            AI settings
          </button>
          <button className="toggle-btn" onClick={onReset} title="Analyze a different project">
            New project
          </button>
        </div>
      )}
    </div>
  );
}
