import { useState } from "react";
import type { ExecutionUiState } from "../../chat/workflowEvents.js";
import { VerificationPanel } from "../verification/VerificationPanel.js";
import { LoadingState, ErrorState } from "../common/States.js";
import { Badge } from "../common/StatusDot.js";

/** Part 14's explicit failure states, given a human-readable gloss --
 * everything not listed here still shows the real backend message
 * verbatim, never a generic "something went wrong." */
const FAILURE_LABELS: Record<string, string> = {
  proposal_stale: "This proposal is stale — the project changed since it was generated. Ask Naqsh to design it again.",
  capability_missing: "The connected environment doesn't support this kind of modification.",
  environment_unavailable: "The environment isn't reachable right now.",
  checkpoint_failed: "Could not create a safety checkpoint, so nothing was executed.",
  proposal_not_found: "This proposal no longer exists in this project."
};

/**
 * Part 12's execution-state indicator + Part 8's verification/objective
 * result, in one place. Every branch here corresponds to a REAL backend
 * call currently in flight or resolved — "approving"/"executing" are
 * shown only while the matching `fetch` is actually pending (see
 * `useChatThreads.ts`'s `decideProposal`); there is no fabricated
 * "Verifying…" step distinct from "Executing…" because the real
 * `POST /proposals/:id/execute` performs checkpoint -> mutate -> verify ->
 * evaluate objective as ONE call, not four independently observable ones.
 */
export function ExecutionStatus({ state, onRestore }: { state: ExecutionUiState; onRestore?: (checkpointId: string) => Promise<void> }): JSX.Element {
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);

  if (state.status === "approving") return <LoadingState label="Requesting approval…" />;
  if (state.status === "executing") return <LoadingState label="Executing and verifying…" />;

  if (state.status === "error") {
    return <ErrorState title="Could not complete this action" message={FAILURE_LABELS[state.kind] ?? state.message} />;
  }

  const { report } = state;
  const checkpointId = report.execution.checkpointId;
  const offerRestore = report.execution.status === "success" && report.verification.status === "failed" && checkpointId !== null && onRestore;

  return (
    <div className="execution-report">
      <div className="execution-report__status">
        <Badge tone={report.execution.status === "success" ? "success" : "danger"}>{report.execution.status === "success" ? "Execution completed" : "Execution failed"}</Badge>
        <span className="execution-report__message">{report.execution.message}</span>
      </div>

      {report.verification.results.length > 0 ? (
        <VerificationPanel checks={report.verification.checks} results={report.verification.results} objectiveSatisfaction={report.objective.result} />
      ) : null}

      {report.discrepancy ? (
        <p className={`execution-report__discrepancy${report.discrepancy.detected ? " execution-report__discrepancy--detected" : ""}`}>
          <Badge tone={report.discrepancy.detected ? "warning" : "success"}>{report.discrepancy.detected ? "Discrepancy detected" : "Consistency check passed"}</Badge>
          <span>{report.discrepancy.description}</span>
        </p>
      ) : null}

      {offerRestore ? (
        restored ? (
          <p className="execution-report__restored">Restored to the state before this execution.</p>
        ) : (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={restoring}
            onClick={async () => {
              setRestoring(true);
              try {
                await onRestore!(checkpointId!);
                setRestored(true);
              } finally {
                setRestoring(false);
              }
            }}
          >
            {restoring ? "Restoring…" : "Restore previous state"}
          </button>
        )
      ) : null}
    </div>
  );
}
