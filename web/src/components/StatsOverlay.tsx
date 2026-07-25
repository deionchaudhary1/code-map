import { colorForFolder } from "../palette";
import type { FileGraph } from "../types";

interface StatsOverlayProps {
  stats: FileGraph["stats"];
  folders: string[];
  /** Rows in the current layered layout — the graph's dependency depth. */
  layerCount: number;
}

export default function StatsOverlay({ stats, folders, layerCount }: StatsOverlayProps) {
  return (
    <div className="stats-overlay">
      <div className="stats-row">
        <span>Files</span>
        <span>{stats.fileCount}</span>
      </div>
      <div className="stats-row">
        <span>Edges</span>
        <span>{stats.edgeCount}</span>
      </div>
      <div className="stats-row">
        <span>Cycles</span>
        <span>{stats.cycleCount}</span>
      </div>
      <div className="stats-row">
        <span>API calls</span>
        <span>{stats.apiCallCount}</span>
      </div>
      <div className="stats-row">
        <span>Routes</span>
        <span>{stats.routeCount}</span>
      </div>
      {layerCount > 0 && (
        <div className="stats-row">
          <span>Depth</span>
          <span>{layerCount}</span>
        </div>
      )}
      {stats.skippedFiles > 0 && (
        <div className="stats-row">
          <span>Skipped</span>
          <span>{stats.skippedFiles}</span>
        </div>
      )}

      <div className="legend">
        {folders.map((folder) => (
          <div className="legend-item" key={folder}>
            <span className="legend-swatch" style={{ background: colorForFolder(folder) }} />
            <span>{folder}</span>
          </div>
        ))}
        <div className="legend-item">
          <span className="legend-line" />
          <span>import</span>
        </div>
        <div className="legend-item">
          <span className="legend-line dashed" />
          <span>type-only</span>
        </div>
        <div className="legend-item">
          <span className="legend-line cycle" />
          <span>in cycle</span>
        </div>
        <div className="legend-item">
          <span className="legend-line api" />
          <span>API call</span>
        </div>
        <div className="legend-item">
          <span className="legend-swatch endpoint" />
          <span>endpoint</span>
        </div>
      </div>
    </div>
  );
}
