import React, { useState, useEffect } from 'react';
import { useUI } from '../store';
import '../styles/ModelsPanel.css';

export default function ModelsPanel() {
  const models = useUI((s) => s.models);
  const selectedModelId = useUI((s) => s.selectedModelId);
  const model = useUI((s) => s.model);
  const loadModels = useUI((s) => s.loadModels);
  const openModel = useUI((s) => s.openModel);
  const saveModel = useUI((s) => s.saveModel);
  const updateModel = useUI((s) => s.updateModel);
  const duplicateModel = useUI((s) => s.duplicateModel);
  const renameModel = useUI((s) => s.renameModel);
  const deleteModel = useUI((s) => s.deleteModel);
  const moveModel = useUI((s) => s.moveModel);
  const setSelectedModelId = useUI((s) => s.setSelectedModelId);
  const serializeModel = useUI((s) => s.serializeModel);
  const expandedLeftPanels = useUI((s) => s.expandedLeftPanels);
  const toggleLeftPanel = useUI((s) => s.toggleLeftPanel);

  const [renamingId, setRenamingId] = useState(null);
  const [newName, setNewName] = useState('');
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newModelName, setNewModelName] = useState('');

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  const handleNewModel = () => {
    const name = newModelName.trim() || 'Untitled';
    const defaultModel = {
      schemaVersion: 2,
      name,
      geometry: {
        shape: 'cylinder',
        cylinder: { R: 33.0, L: 100.0, t: 0.1, partitions: [], imperfectionForce: 0 },
        cylinder_segment: { R: 45.0, L: 200.0, t: 0.5, phi_deg: 90.0 },
        sphere: { R: 50.0, t: 0.2, opening_angle_deg: 180.0 },
      },
      materials: [{ id: 'mat-default', name: 'Steel', E: 208000, nu: 0.3, density: 7.85e-9 }],
      sections: [
        {
          id: 'shell_full',
          name: 'Shell Full',
          kind: 'shell',
          material_ref: 'mat-default',
          thickness_source: { kind: 'constant', value: 0.1 },
          offset: 'midsurface',
        },
      ],
      assignments: [{ region: 'shell_full', section_ref: 'shell_full' }],
      mesh: { refinement: 3, degree: 2, smoothness: 1, coupling: 0 },
      bcs: { kind: 'clamped_neumann' },
      load: { kind: 'axial', magnitude: 100, controlMode: 'force', nodes: [] },
      analysis: { kind: 'lba', solver: 'auto', shift: 0.05, nmodes: 5, tolerance: 1e-6 },
      imperfections: { kind: 'none', mode: 1, amplitude: 0 },
    };
    saveModel(name, defaultModel);
    setShowNewDialog(false);
    setNewModelName('');
  };

  const handleOpenModel = (id) => {
    openModel(id);
    setSelectedModelId(id);
  };

  const handleSaveCurrentModel = () => {
    if (!selectedModelId) {
      const result = saveModel(model.name, serializeModel());
      setSelectedModelId(result.id);
    } else {
      updateModel(selectedModelId, serializeModel());
    }
  };

  const handleStartRename = (id, currentName) => {
    setRenamingId(id);
    setNewName(currentName);
  };

  const handleConfirmRename = (id) => {
    renameModel(id, newName);
    setRenamingId(null);
    setNewName('');
  };

  const handleDeleteModel = (id) => {
    if (window.confirm('Delete this model? This cannot be undone.')) {
      deleteModel(id);
    }
  };

  return (
    <div className="models-panel glass-panel">
      <div className="models-header">
        <h3>Models</h3>
        <div className="models-buttons">
          <button
            className="model-action-btn"
            onClick={() => setShowNewDialog(true)}
            title="Create new model (Cmd+N)"
          >
            ➕ New
          </button>
          <button
            className="model-action-btn"
            onClick={handleSaveCurrentModel}
            title="Save current model"
          >
            💾 Save
          </button>
          <button
            style={{
              position: "absolute",
              right: -24,
              top: "50%",
              transform: "translateY(-50%)",
              width: 24,
              height: 100,
              padding: 0,
              background: "linear-gradient(180deg, rgba(6,182,212,0.2) 0%, rgba(6,182,212,0.4) 50%, rgba(6,182,212,0.2) 100%)",
              border: "1px solid var(--accent, #06b6d4)",
              borderLeft: "none",
              borderRadius: "0 6px 6px 0",
              color: "var(--accent, #06b6d4)",
              cursor: "pointer",
              fontSize: 14,
              fontFamily: "monospace",
              fontWeight: "bold",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 0.2s ease",
              backdropFilter: "blur(6px)",
              zIndex: 10,
            }}
            onMouseEnter={(e) => {
              e.target.style.background = "linear-gradient(180deg, rgba(6,182,212,0.4) 0%, rgba(6,182,212,0.6) 50%, rgba(6,182,212,0.4) 100%)";
              e.target.style.width = "28px";
              e.target.style.right = "-28px";
            }}
            onMouseLeave={(e) => {
              e.target.style.background = "linear-gradient(180deg, rgba(6,182,212,0.2) 0%, rgba(6,182,212,0.4) 50%, rgba(6,182,212,0.2) 100%)";
              e.target.style.width = "24px";
              e.target.style.right = "-24px";
            }}
            onClick={() => toggleLeftPanel('models')}
            title="Collapse Models panel"
          >
            ◀
          </button>
        </div>
      </div>

      {showNewDialog && (
        <div className="models-dialog">
          <div className="models-dialog-content">
            <h4>New Model</h4>
            <input
              type="text"
              placeholder="Model name (optional)"
              value={newModelName}
              onChange={(e) => setNewModelName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNewModel();
                if (e.key === 'Escape') setShowNewDialog(false);
              }}
              autoFocus
            />
            <div className="models-dialog-buttons">
              <button onClick={handleNewModel}>Create</button>
              <button onClick={() => setShowNewDialog(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="models-list">
        {models.length === 0 ? (
          <div className="models-empty">No models yet. Create one to start.</div>
        ) : (
          models.map((m) => (
            <div
              key={m.id}
              className={`models-item ${selectedModelId === m.id ? 'selected' : ''}`}
              onClick={() => handleOpenModel(m.id)}
            >
              {renamingId === m.id ? (
                <div className="models-rename" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleConfirmRename(m.id);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    autoFocus
                  />
                  <button onClick={() => handleConfirmRename(m.id)}>✓</button>
                  <button onClick={() => setRenamingId(null)}>✕</button>
                </div>
              ) : (
                <>
                  <div className="models-item-main">
                    <div className="models-item-name">{m.name}</div>
                    <div className="models-item-date">
                      {new Date(m.updatedAt).toLocaleDateString()} {new Date(m.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  <div className="models-item-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="models-action"
                      onClick={() => handleStartRename(m.id, m.name)}
                      title="Rename"
                    >
                      ✎
                    </button>
                    <button
                      className="models-action"
                      onClick={() => {
                        duplicateModel(m.id);
                      }}
                      title="Duplicate"
                    >
                      ⎘
                    </button>
                    <button
                      className="models-action"
                      onClick={() => moveModel(m.id, 'up')}
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      className="models-action"
                      onClick={() => moveModel(m.id, 'down')}
                      title="Move down"
                    >
                      ▼
                    </button>
                    <button
                      className="models-action models-delete"
                      onClick={() => handleDeleteModel(m.id)}
                      title="Delete"
                    >
                      ✕
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
