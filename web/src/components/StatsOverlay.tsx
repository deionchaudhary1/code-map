import { colorForFolder, UNASSIGNED_COLOR } from "../palette";
import type { TopicIndex } from "../topics";
import type { FileGraph, RuntimeTrace } from "../types";

interface StatsOverlayProps {
  stats: FileGraph["stats"];
  folders: string[];
  /** Rows in the current layered layout — the graph's dependency depth. */
  layerCount: number;
  runtime: RuntimeTrace | null;
  runtimeMode: boolean;
  /** Non-null while topic mode is on; the legend then lists topics. */
  topicIndex: TopicIndex | null;
  unassignedCount: number;
}

export default function StatsOverlay({
  stats,
  folders,
  layerCount,
  runtime,
  runtimeMode,
  topicIndex,
  unassignedCount,
}: StatsOverlayProps) {
  const executed = runtime ? runtime.executedFiles.length : 0;
  const coveragePct =
    runtime && stats.fileCount > 0 ? Math.round((executed / stats.fileCount) * 100) : 0;
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
      {runtime && (
        <>
          <div className="stats-row">
            <span>Executed</span>
            <span>
              {executed}/{stats.fileCount} ({coveragePct}%)
            </span>
          </div>
          <div className="stats-row">
            <span>Never ran</span>
            <span>{stats.fileCount - executed}</span>
          </div>
        </>
      )}

      <div className="legend">
        {/* Topic colors replace folder colors on the canvas, so the legend has
            to swap too — showing both would explain neither. */}
        {topicIndex
          ? topicIndex.views.map((view) => (
              <div className="legend-item" key={view.topic.id}>
                <span className="legend-swatch" style={{ background: view.color }} />
                <span>
                  {view.topic.name} ({view.topic.members.length})
                </span>
              </div>
            ))
          : folders.map((folder) => (
              <div className="legend-item" key={folder}>
                <span className="legend-swatch" style={{ background: colorForFolder(folder) }} />
                <span>{folder}</span>
              </div>
            ))}
        {topicIndex && unassignedCount > 0 && (
          <div className="legend-item">
            <span className="legend-swatch" style={{ background: UNASSIGNED_COLOR }} />
            <span>unassigned ({unassignedCount})</span>
          </div>
        )}
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
        {runtimeMode && (
          <>
            <div className="legend-item">
              <span className="legend-swatch executed" />
              <span>executed</span>
            </div>
            <div className="legend-item">
              <span className="legend-swatch unexecuted" />
              <span>never ran</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
