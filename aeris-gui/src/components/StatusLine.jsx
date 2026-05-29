import React from 'react';
import { useUI } from '../store';
import '../styles/StatusLine.css';

const SECTION_BADGES = [
  { id: 'geometry', label: 'Geom', item: 'geometry.dimensions' },
  { id: 'material', label: 'Matl', item: 'material.base' },
  { id: 'shellConstruction', label: 'Shell', item: 'shellConstruction.sectionAssignments' },
  { id: 'mesh', label: 'Mesh', item: 'mesh.discretisation' },
  { id: 'bcsLoads', label: 'BCs', item: 'bcsLoads.bcs' },
  { id: 'analysis', label: 'Anlys', item: 'analysis.type' },
];

const STATUS_COLORS = {
  configured: '#10b981', // green
  warning: '#f59e0b', // amber
  default: '#6b7280', // gray
};

const STATUS_ICON = {
  configured: '✓',
  warning: '⚠',
  default: '○',
};

export default function StatusLine() {
  const sectionStatus = useUI((s) => s.sectionStatus);
  const model = useUI((s) => s.model);
  const lastRun = useUI((s) => s.lastRun);
  const selectTreeItem = useUI((s) => s.selectTreeItem);
  const expandSection = useUI((s) => s.expandSection);
  const paletteOpen = useUI((s) => s.paletteOpen);
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);

  const handleBadgeClick = (sectionId) => {
    expandSection(sectionId);
    selectTreeItem(`${sectionId}.${SECTION_BADGES.find((b) => b.id === sectionId)?.item}`);
  };

  const solverPhase = lastRun?.phase || '';
  const solverStatus = lastRun?.status || '';
  const solverEta = lastRun?.etaSeconds ? `~${Math.ceil(lastRun.etaSeconds / 60)}m` : '';

  const modelName = model.name || 'Model';

  return (
    <div className="status-line">
      <div className="status-line-left">
        <span className="model-name">{modelName}</span>
        <span className="divider">·</span>
        {SECTION_BADGES.map((badge) => {
          const status = sectionStatus[badge.id] || 'default';
          const color = STATUS_COLORS[status];
          const icon = STATUS_ICON[status];
          return (
            <button
              key={badge.id}
              className="status-badge"
              onClick={() => handleBadgeClick(badge.id)}
              style={{ color }}
              title={`${badge.label}: ${status}`}
            >
              <span className="icon">{icon}</span>
              <span>{badge.label}</span>
            </button>
          );
        })}
      </div>

      <div className="status-line-right">
        {solverStatus && (
          <span className="solver-status">
            ⏯ {solverPhase}
            {solverEta && ` · ETA ${solverEta}`}
          </span>
        )}
        <button
          className="palette-hint"
          onClick={() => setPaletteOpen(!paletteOpen)}
          title="Open command palette"
        >
          Space: search
        </button>
      </div>
    </div>
  );
}
