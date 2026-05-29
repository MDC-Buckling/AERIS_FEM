import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useUI } from '../store';
import '../styles/CommandPalette.css';

const COMMANDS = [
  // Sections
  {
    label: 'Geometry — Dimensions',
    icon: '⬡',
    section: 'geometry',
    action: (store) => {
      store.expandSection('geometry');
      store.selectTreeItem('geometry.dimensions');
    },
  },
  {
    label: 'Material — Base',
    icon: '◈',
    section: 'material',
    action: (store) => {
      store.expandSection('material');
      store.selectTreeItem('material.base');
    },
  },
  {
    label: 'Shell Construction',
    icon: '▦',
    section: 'shellConstruction',
    action: (store) => {
      store.expandSection('shellConstruction');
      store.selectTreeItem('shellConstruction.sectionAssignments');
    },
  },
  {
    label: 'Mesh / Discretisation',
    icon: '⊞',
    section: 'mesh',
    action: (store) => {
      store.expandSection('mesh');
      store.selectTreeItem('mesh.discretisation');
    },
  },
  {
    label: 'BCs & Loads',
    icon: '⊸',
    section: 'bcsLoads',
    action: (store) => {
      store.expandSection('bcsLoads');
      store.selectTreeItem('bcsLoads.bcs');
    },
  },
  {
    label: 'Analysis Type',
    icon: '▷',
    section: 'analysis',
    action: (store) => {
      store.expandSection('analysis');
      store.selectTreeItem('analysis.type');
    },
  },
  // Actions
  {
    label: 'Run Solver',
    icon: '⚡',
    action: (store) => store.runSolver(),
  },
  {
    label: 'Switch to Post-Processor',
    icon: '↗',
    action: (store) => store.setMode('post'),
  },
  {
    label: 'Export Model JSON',
    icon: '⬇',
    action: (store) => store.exportModel(),
  },
];

export default function CommandPalette() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const paletteOpen = useUI((s) => s.paletteOpen);
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  const store = useUI.getState;
  const inputRef = useRef(null);

  useEffect(() => {
    if (paletteOpen && inputRef.current) {
      inputRef.current.focus();
      setQuery('');
      setSelected(0);
    }
  }, [paletteOpen]);

  const filtered = COMMANDS.filter((cmd) =>
    cmd.label.toLowerCase().includes(query.toLowerCase())
  );

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      setPaletteOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(Math.min(selected + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(Math.max(selected - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selected]) {
        filtered[selected].action(store());
        setPaletteOpen(false);
      }
      return;
    }
  };

  const handleClick = (cmd) => {
    cmd.action(store());
    setPaletteOpen(false);
  };

  if (!paletteOpen) return null;

  return createPortal(
    <div className="command-palette-overlay" onClick={() => setPaletteOpen(false)}>
      <div className="command-palette-container" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="command-palette-input"
          placeholder="Search commands..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette-list">
          {filtered.length > 0 ? (
            filtered.map((cmd, i) => (
              <button
                key={cmd.label}
                className={`command-palette-item ${i === selected ? 'selected' : ''}`}
                onClick={() => handleClick(cmd)}
              >
                <span className="command-icon">{cmd.icon}</span>
                <span className="command-label">{cmd.label}</span>
              </button>
            ))
          ) : (
            <div className="command-palette-empty">No commands found</div>
          )}
        </div>
        <div className="command-palette-help">
          <kbd>↑↓</kbd> to navigate • <kbd>Enter</kbd> to run • <kbd>Esc</kbd> to close
        </div>
      </div>
    </div>,
    document.body
  );
}
