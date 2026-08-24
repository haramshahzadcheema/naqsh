import { useState } from "react";
import { useProjectData } from "../../data/ProjectDataProvider.js";

interface ViewportObject {
  id: string;
  label: string;
  kind: "plate" | "hole" | "rib";
}

const OBJECTS: ViewportObject[] = [
  { id: "plate", label: "Mounting Plate", kind: "plate" },
  { id: "hole-1", label: "Mounting Hole 1", kind: "hole" },
  { id: "hole-2", label: "Mounting Hole 2", kind: "hole" },
  { id: "rib-1", label: "Reinforcing Rib", kind: "rib" }
];

/**
 * A high-quality MOCK engineering viewport for the seeded DEMO project only
 * — a deliberately simplified, monochrome 2D drawing, not a real geometry
 * kernel. It exists purely to make the demo feel like an engineering
 * surface rather than a blank pane. For any REAL project, no backend CAD
 * geometry exists yet (no environment adapter produces a model tree), so
 * this component must not show this fabricated bracket for one — that
 * would misrepresent a real project's actual (empty) CAD state. See
 * `EnvironmentUnavailableViewport` below for the honest real-project view.
 */
export function EngineeringViewport(): JSX.Element {
  const { isRealProject, environment } = useProjectData();

  if (isRealProject) {
    return <EnvironmentUnavailableViewport environment={environment} />;
  }

  return <MockDemoViewport />;
}

function EnvironmentUnavailableViewport({
  environment
}: {
  environment: ReturnType<typeof useProjectData>["environment"];
}): JSX.Element {
  const name = environment.status === "ready" ? environment.data.name : "Environment";
  const status = environment.status === "ready" ? environment.data.status : "loading";

  return (
    <div className="viewport">
      <div className="viewport__toolbar">
        <span className="viewport__env-indicator">
          <span className="viewport__env-dot viewport__env-dot--inactive" aria-hidden="true" />
          {name} · {status}
        </span>
      </div>
      <div className="viewport__stage viewport__stage--empty">
        <p className="viewport__empty-message">
          No CAD geometry is available for this project yet. This environment ({name}) has not produced any geometry, and no
          model tree exists to display.
        </p>
      </div>
      <div className="viewport__tree" aria-label="Model tree">
        <div className="viewport__tree-title">Model tree</div>
        <p className="viewport__empty-message viewport__empty-message--tree">No CAD session connected.</p>
      </div>
    </div>
  );
}

function MockDemoViewport(): JSX.Element {
  const [selected, setSelected] = useState<string | null>("hole-2");
  const [zoom, setZoom] = useState(1);

  const isHighlighted = (id: string) => selected === id;

  return (
    <div className="viewport">
      <div className="viewport__toolbar">
        <span className="viewport__env-indicator">
          <span className="viewport__env-dot" aria-hidden="true" />
          Mock CAD · Motor Mounting Bracket
        </span>
        <div className="viewport__zoom">
          <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))}>
            −
          </button>
          <span className="mono">{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(2, z + 0.15))}>
            +
          </button>
          <button type="button" onClick={() => setZoom(1)}>
            Fit view
          </button>
        </div>
      </div>

      <div className="viewport__stage">
        <svg
          viewBox="0 0 400 280"
          role="img"
          aria-label="Mounting bracket geometry: rectangular plate with two mounting holes and a reinforcing rib"
          style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}
        >
          <g stroke="var(--border-strong)" strokeWidth="0.5" opacity="0.5">
            {Array.from({ length: 9 }).map((_, i) => (
              <line key={`v${i}`} x1={i * 50} y1={0} x2={i * 50} y2={280} />
            ))}
            {Array.from({ length: 6 }).map((_, i) => (
              <line key={`h${i}`} x1={0} y1={i * 56} x2={400} y2={i * 56} />
            ))}
          </g>

          {/* Plate */}
          <rect
            x="80"
            y="70"
            width="240"
            height="140"
            rx="4"
            fill={isHighlighted("plate") ? "var(--bg-active)" : "var(--bg-surface-raised)"}
            stroke={isHighlighted("plate") ? "var(--ink)" : "var(--border-strong)"}
            strokeWidth={isHighlighted("plate") ? 2 : 1.25}
            onClick={() => setSelected("plate")}
            style={{ cursor: "pointer" }}
          />

          {/* Reinforcing rib */}
          <rect
            x="192"
            y="80"
            width="16"
            height="120"
            fill={isHighlighted("rib-1") ? "var(--bg-active)" : "var(--bg-inset)"}
            stroke={isHighlighted("rib-1") ? "var(--ink)" : "var(--border-default)"}
            strokeWidth={isHighlighted("rib-1") ? 2 : 1}
            onClick={() => setSelected("rib-1")}
            style={{ cursor: "pointer" }}
          />

          {/* Holes */}
          <circle
            cx="115"
            cy="105"
            r="11"
            fill="var(--bg-canvas)"
            stroke={isHighlighted("hole-1") ? "var(--ink)" : "var(--border-strong)"}
            strokeWidth={isHighlighted("hole-1") ? 2.5 : 1.25}
            onClick={() => setSelected("hole-1")}
            style={{ cursor: "pointer" }}
          />
          <circle
            cx="285"
            cy="175"
            r="11"
            fill="var(--bg-canvas)"
            stroke={isHighlighted("hole-2") ? "var(--ink)" : "var(--border-strong)"}
            strokeWidth={isHighlighted("hole-2") ? 2.5 : 1.25}
            onClick={() => setSelected("hole-2")}
            style={{ cursor: "pointer" }}
          />

          {isHighlighted("hole-2") ? (
            <g stroke="var(--status-warning)" strokeWidth="1" fill="none">
              <line x1="285" y1="175" x2="320" y2="175" strokeDasharray="3 2" />
              <text x="298" y="168" fontSize="10" fill="var(--status-warning)" stroke="none" fontFamily="var(--font-mono)">
                2.4 mm
              </text>
            </g>
          ) : null}

          <g fontSize="9" fill="var(--text-tertiary)" stroke="none" fontFamily="var(--font-mono)">
            <text x="200" y="230">
              90 × 60 × 8 mm
            </text>
          </g>
        </svg>
      </div>

      <div className="viewport__tree" aria-label="Model tree">
        <div className="viewport__tree-title">Model tree</div>
        <ul>
          {OBJECTS.map((object) => (
            <li key={object.id}>
              <button type="button" className={`viewport__tree-item${selected === object.id ? " is-selected" : ""}`} onClick={() => setSelected(object.id)}>
                {object.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
