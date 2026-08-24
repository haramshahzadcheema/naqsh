import type { Constraint, Requirement } from "@naqsh/schemas";
import type { ExtractionEvent } from "../../onboarding/types.js";

const EXPECTED_LABELS: Array<{ label: string; unclear: string }> = [
  { label: "Load capacity", unclear: "Load requirement" },
  { label: "Envelope", unclear: "Bounding envelope" },
  { label: "Material", unclear: "Material" },
  { label: "Max thickness", unclear: "Maximum thickness" },
  { label: "Manufacturing", unclear: "Manufacturing process" }
];

function formatRequirement(requirement: Requirement): string {
  return `${requirement.description}`;
}

function formatConstraint(constraint: Constraint): string {
  return `${constraint.description}`;
}

export function UnderstandingCard({
  objective,
  requirements,
  constraints,
  extractions,
  onConfirm,
  onKeepRefining
}: {
  objective: string;
  requirements: Requirement[];
  constraints: Constraint[];
  extractions: ExtractionEvent[];
  onConfirm: () => void;
  onKeepRefining: () => void;
}): JSX.Element {
  const presentLabels = new Set(extractions.map((event) => event.label));
  const stillUnclear = EXPECTED_LABELS.filter((entry) => !presentLabels.has(entry.label)).map((entry) => entry.unclear);

  return (
    <div className="understanding-card">
      <h2 className="understanding-card__title">Here's what I understand</h2>

      <section className="understanding-card__section">
        <h3>Objective</h3>
        <p>{objective}</p>
      </section>

      {requirements.length > 0 ? (
        <section className="understanding-card__section">
          <h3>Requirements</h3>
          <ul>
            {requirements.map((requirement) => (
              <li key={requirement.id}>{formatRequirement(requirement)}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {constraints.length > 0 ? (
        <section className="understanding-card__section">
          <h3>Constraints</h3>
          <ul>
            {constraints.map((constraint) => (
              <li key={constraint.id}>{formatConstraint(constraint)}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {stillUnclear.length > 0 ? (
        <section className="understanding-card__section understanding-card__section--unclear">
          <h3>Still unclear</h3>
          <ul>
            {stillUnclear.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="understanding-card__actions">
        <button type="button" className="btn btn--ghost" onClick={onKeepRefining}>
          Keep refining
        </button>
        <button type="button" className="btn btn--primary" onClick={onConfirm}>
          Looks right
        </button>
      </div>
    </div>
  );
}
