import type { Direction } from "../layout/elk";

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
  hosted,
  onOpenSettings,
  onReset,
}: TopBarProps) {
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
