import { useState } from "react";
import type { Clarification, Constraint, Requirement } from "@naqsh/schemas";
import { Badge } from "../common/StatusDot.js";
import { EmptyState } from "../common/States.js";

function RequirementRow({ requirement }: { requirement: Requirement }): JSX.Element {
  return (
    <li className="req-row">
      <span className={`req-row__marker req-row__marker--${requirement.status}`} aria-hidden="true" />
      <div className="req-row__body">
        <div className="req-row__description">{requirement.description}</div>
        <div className="req-row__meta">
          <span>Source: {requirement.source}</span>
          <span aria-hidden="true">·</span>
          <span>
            {requirement.value !== null && requirement.value !== undefined ? `${String(requirement.value)}${requirement.unit ? ` ${requirement.unit}` : ""}` : "No target value"}
          </span>
        </div>
      </div>
      <Badge tone={requirement.status === "active" ? "info" : requirement.status === "satisfied" ? "success" : "neutral"}>{requirement.status}</Badge>
    </li>
  );
}

function ConstraintRow({ constraint }: { constraint: Constraint }): JSX.Element {
  return (
    <li className="req-row">
      <span className={`req-row__marker req-row__marker--${constraint.status}`} aria-hidden="true" />
      <div className="req-row__body">
        <div className="req-row__description">{constraint.description}</div>
        <div className="req-row__meta">
          <span>{constraint.severity === "hard" ? "Hard constraint" : "Soft constraint"}</span>
          <span aria-hidden="true">·</span>
          <span>{constraint.value !== null && constraint.value !== undefined ? `${String(constraint.value)}${constraint.unit ? ` ${constraint.unit}` : ""}` : ""}</span>
        </div>
      </div>
      <Badge tone={constraint.severity === "hard" ? "warning" : "neutral"}>{constraint.severity}</Badge>
    </li>
  );
}

function ClarificationCard({ clarification, onAnswer }: { clarification: Clarification; onAnswer: (id: string, answer: string) => Promise<void> }): JSX.Element {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const answered = clarification.status === "answered";

  return (
    <li className="clarification-card">
      <div className="clarification-card__marker" aria-hidden="true">
        ◐
      </div>
      <div className="clarification-card__body">
        <div className="clarification-card__question">{clarification.question}</div>
        <p className="clarification-card__reason">{clarification.reason}</p>
        {answered ? (
          <p className="clarification-card__answer">
            <strong>Answer:</strong> {clarification.answerText}
          </p>
        ) : (
          <form
            className="clarification-card__form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!draft.trim()) return;
              setSubmitting(true);
              try {
                await onAnswer(clarification.id, draft.trim());
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <label className="visually-hidden" htmlFor={`${clarification.id}-answer`}>
              Answer for: {clarification.question}
            </label>
            <input id={`${clarification.id}-answer`} type="text" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Type your answer…" />
            <button type="submit" className="btn btn--primary btn--sm" disabled={submitting || !draft.trim()}>
              {submitting ? "Sending…" : "Answer"}
            </button>
          </form>
        )}
      </div>
      <Badge tone={answered ? "success" : "warning"}>{answered ? "answered" : "clarification required"}</Badge>
    </li>
  );
}

export function RequirementsView({
  requirements,
  constraints,
  clarifications,
  onAnswerClarification
}: {
  requirements: Requirement[];
  constraints: Constraint[];
  clarifications: Clarification[];
  onAnswerClarification: (id: string, answer: string) => Promise<void>;
}): JSX.Element {
  if (requirements.length === 0 && constraints.length === 0 && clarifications.length === 0) {
    return <EmptyState title="No requirements yet" message="Tell Naqsh what you're trying to build, and requirements will appear here as they're understood." />;
  }

  return (
    <div className="view-stack">
      {requirements.length > 0 ? (
        <section>
          <h2 className="view-section-title">Requirements</h2>
          <ul className="req-list">
            {requirements.map((requirement) => (
              <RequirementRow key={requirement.id} requirement={requirement} />
            ))}
          </ul>
        </section>
      ) : null}

      {constraints.length > 0 ? (
        <section>
          <h2 className="view-section-title">Constraints</h2>
          <ul className="req-list">
            {constraints.map((constraint) => (
              <ConstraintRow key={constraint.id} constraint={constraint} />
            ))}
          </ul>
        </section>
      ) : null}

      {clarifications.length > 0 ? (
        <section>
          <h2 className="view-section-title">Naqsh noticed missing information</h2>
          <ul className="clarification-list">
            {clarifications.map((clarification) => (
              <ClarificationCard key={clarification.id} clarification={clarification} onAnswer={onAnswerClarification} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
