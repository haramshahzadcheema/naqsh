import { useState } from "react";
import { Badge } from "../common/StatusDot.js";
import type { ChatWorkflowUiEvent } from "../../chat/workflowEvents.js";

const APPROVAL_TONE = { pending: "pending", approved: "success", rejected: "danger", revoked: "neutral" } as const;

type ExplorationEvent = Extract<ChatWorkflowUiEvent, { kind: "exploration_prepared" }>;

/**
 * Section 5's "explore alternatives" card: N real generated candidates
 * (`prepareExploration`, apps/api/engineeringWorkflow.ts) plus the REAL
 * pending Approvals a human must decide before the candidates' builds can
 * run -- never auto-approved (see that file's own doc comment on why).
 * "Start exploration" only calls the real `POST /projects/:id/jobs` once
 * every approval shows `"approved"`; the backend enforces this
 * independently regardless (a rejected/pending approval denies the
 * matching tool call for real), this is just an honest reflection of that
 * same rule in the UI, not a second, competing permission system.
 */
export function ExplorationCard({
  event,
  onDecideApproval,
  onStart
}: {
  event: ExplorationEvent;
  onDecideApproval: (approvalId: string, decision: "approved" | "rejected") => Promise<void>;
  onStart: () => Promise<void>;
}): JSX.Element {
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);

  const allApproved = event.pendingApprovals.length > 0 && event.pendingApprovals.every((approval) => approval.status === "approved");
  const anyRejected = event.pendingApprovals.some((approval) => approval.status === "rejected" || approval.status === "revoked");

  async function decide(approvalId: string, decision: "approved" | "rejected"): Promise<void> {
    setPendingApprovalId(approvalId);
    setDecideError(null);
    try {
      await onDecideApproval(approvalId, decision);
    } catch (error) {
      setDecideError(error instanceof Error ? error.message : "Could not record that decision.");
    } finally {
      setPendingApprovalId(null);
    }
  }

  async function start(): Promise<void> {
    setStarting(true);
    setStartError(null);
    try {
      await onStart();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Could not start this exploration.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <article className="exploration-card" aria-labelledby={`${event.id}-title`}>
      <header className="exploration-card__header">
        <span className="exploration-card__eyebrow">Exploring alternatives</span>
        <Badge tone={event.submittedJobId ? "success" : "pending"}>{event.submittedJobId ? "running" : "awaiting approval"}</Badge>
      </header>

      <h3 id={`${event.id}-title`} className="exploration-card__title">
        {event.candidates.length} alternative design{event.candidates.length === 1 ? "" : "s"} generated
      </h3>

      <div className="candidate-grid">
        {event.candidates.map(({ candidate, designSpecification }, index) => (
          <article key={candidate.id} className="candidate-card">
            <header className="candidate-card__header">
              <span className="candidate-card__label">Candidate {String.fromCharCode(65 + index)}</span>
            </header>
            <p className="candidate-card__hypothesis">{candidate.hypothesis}</p>
            {designSpecification.material ? <p className="exploration-card__material mono">{designSpecification.material}</p> : null}
          </article>
        ))}
      </div>

      {event.failures.length > 0 ? (
        <p className="exploration-card__failures">
          {event.failures.length} variation{event.failures.length === 1 ? "" : "s"} could not be generated ({event.failures[0]!.message}).
        </p>
      ) : null}

      {event.submittedJobId ? (
        <p className="exploration-card__started">Exploration started — see progress and results in Experiments.</p>
      ) : (
        <>
          <div className="exploration-card__approvals">
            <span className="exploration-card__approvals-title">Actions needing your approval</span>
            <ul className="exploration-card__approval-list">
              {event.pendingApprovals.map((approval) => (
                <li key={approval.id} className="exploration-card__approval-row">
                  <span className="mono">{approval.toolName}</span>
                  <div className="exploration-card__approval-row-right">
                    <Badge tone={APPROVAL_TONE[approval.status]}>{approval.status}</Badge>
                    {approval.status === "pending" ? (
                      <div className="exploration-card__approval-actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={pendingApprovalId === approval.id}
                          onClick={() => decide(approval.id, "approved")}
                        >
                          {pendingApprovalId === approval.id ? "…" : "Approve"}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={pendingApprovalId === approval.id}
                          onClick={() => decide(approval.id, "rejected")}
                        >
                          Reject
                        </button>
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          {decideError ? <ErrorLine message={decideError} /> : null}

          {anyRejected ? (
            <p className="exploration-card__failures">One or more actions were rejected — this exploration can no longer run as generated.</p>
          ) : (
            <div className="exploration-card__actions">
              <button type="button" className="btn btn--primary" disabled={!allApproved || starting} onClick={start}>
                {starting ? "Starting…" : "Start exploration"}
              </button>
            </div>
          )}
          {startError ? <ErrorLine message={startError} /> : null}
        </>
      )}
    </article>
  );
}

function ErrorLine({ message }: { message: string }): JSX.Element {
  return <p className="exploration-card__failures">{message}</p>;
}
