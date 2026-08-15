/**
 * The file and run actions, top right, in the prototype's button style.
 */

export interface ToolbarProps {
  onImport(): void;
  onOpenProject(): void;
  onSaveProject(): void;
  onSolve(): void;
  onResetView(): void;
  canSolve: boolean;
  solving: boolean;
  hasModel: boolean;
  embedMesh: boolean;
  onToggleEmbedMesh(): void;
  plotsOpen: boolean;
  onTogglePlots(): void;
}

export function Toolbar({
  onImport,
  onOpenProject,
  onSaveProject,
  onSolve,
  onResetView,
  canSolve,
  solving,
  hasModel,
  embedMesh,
  onToggleEmbedMesh,
  plotsOpen,
  onTogglePlots,
}: ToolbarProps) {
  return (
    <div className="panel toolbar">
      <div>
        <button type="button" onClick={onImport}>
          import CAD
        </button>
        <button type="button" onClick={onOpenProject}>
          open project
        </button>
        <button type="button" onClick={onSaveProject} disabled={!hasModel}>
          save project
        </button>
      </div>
      <div>
        <button
          type="button"
          className={embedMesh ? 'on' : undefined}
          onClick={onToggleEmbedMesh}
          title="Embed the tessellated mesh in the project file so it opens without the CAD file"
        >
          embed mesh
        </button>
        <button
          type="button"
          className={plotsOpen ? 'on' : undefined}
          onClick={onTogglePlots}
          disabled={!hasModel}
        >
          plots
        </button>
        <button type="button" onClick={onResetView} disabled={!hasModel}>
          reset view
        </button>
        <button
          type="button"
          className="primary"
          onClick={onSolve}
          disabled={!canSolve || solving}
          title="Steady-state shell solve, in a worker"
        >
          {solving ? 'solving…' : 'solve'}
        </button>
      </div>
    </div>
  );
}
