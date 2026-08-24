import { useState } from "react";
import type { DesignSpecification, DesignSpecificationStatus } from "@naqsh/schemas";
import { Badge, type Tone } from "../common/StatusDot.js";
import { EmptyState } from "../common/States.js";
import { buildDesignSpecificationMarkdown } from "../../chat/exportDesignSpecification.js";
import { downloadTextFile } from "../../chat/exportThread.js";

const STATUS_TONE: Record<DesignSpecificationStatus, Tone> = {
  proposed: "pending",
  approved: "success",
  rejected: "danger",
  superseded: "neutral"
};

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "design-specification"
  );
}

/**
 * P22's "Artifacts" concept (UI/UX brief §9), scoped to what's genuinely
 * REAL: `DesignSpecification` (P20) -- a structured, generated document
 * (components, relationships, material, manufacturing intent) that was
 * already being fetched into every `ProjectSnapshot` but had NO view
 * anywhere in the app. This is not a generic "reports/notes/summaries"
 * dashboard bolted on top of nothing; every card here is one real backend
 * record, and Download produces a real file built from that record's own
 * fields (`exportDesignSpecification.ts`), never a placeholder.
 */
export function ArtifactsView({ designSpecifications }: { designSpecifications: DesignSpecification[] }): JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (designSpecifications.length === 0) {
    return (
      <EmptyState
        title="No artifacts yet"
        message="Once Naqsh generates a design specification for one of your plan steps, it will appear here as a real, downloadable document -- never a placeholder."
      />
    );
  }

  // Most recent first -- matches every other "latest record leads" list
  // in this app (plan/proposal history, activity timeline).
  const sorted = [...designSpecifications].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="view-stack">
      <section>
        <h2 className="view-section-title">Artifacts</h2>
        <ul className="artifact-list">
          {sorted.map((spec) => {
            const expanded = expandedId === spec.id;
            return (
              <li key={spec.id} className="card card--flat artifact-card">
                <div className="artifact-card__header">
                  <div>
                    <h3 className="artifact-card__title">{spec.description || "Design specification"}</h3>
                    <p className="artifact-card__meta">
                      v{spec.version} · {spec.components.length} component{spec.components.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[spec.status]}>{spec.status}</Badge>
                </div>
                <p className="artifact-card__objective">{spec.objectiveSummary}</p>
                <div className="artifact-card__actions">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setExpandedId(expanded ? null : spec.id)} aria-expanded={expanded}>
                    {expanded ? "Hide details" : "Preview"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() =>
                      downloadTextFile(`${slug(spec.description)}-v${spec.version}.md`, buildDesignSpecificationMarkdown(spec), "text/markdown")
                    }
                  >
                    Download
                  </button>
                </div>
                {expanded ? (
                  <div className="artifact-card__detail">
                    {spec.material ? (
                      <p className="artifact-card__detail-line">
                        <strong>Material:</strong> {spec.material}
                      </p>
                    ) : null}
                    {spec.manufacturingIntent ? (
                      <p className="artifact-card__detail-line">
                        <strong>Manufacturing intent:</strong> {spec.manufacturingIntent}
                      </p>
                    ) : null}
                    {spec.components.length > 0 ? (
                      <div className="artifact-table-wrap">
                        <table className="artifact-table">
                          <thead>
                            <tr>
                              <th>Component</th>
                              <th>Type</th>
                              <th>Geometry intent</th>
                            </tr>
                          </thead>
                          <tbody>
                            {spec.components.map((component) => (
                              <tr key={component.id}>
                                <td>{component.name}</td>
                                <td>{component.type}</td>
                                <td>{component.geometryIntent}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
