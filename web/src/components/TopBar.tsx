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
    </div>
  );
}
