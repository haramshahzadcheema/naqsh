import { useState } from "react";
import type { BackgroundJob, JobEvent } from "@naqsh/schemas";
import { Badge } from "../common/StatusDot.js";

function eventTone(kind: JobEvent["kind"]): "success" | "danger" | "pending" | "info" {
  if (kind === "candidate_completed") return "info";
  if (kind === "failed" || kind === "cancelled") return "danger";
  if (kind === "completed") return "success";
  return "pending";
}

export function BackgroundJobPanel({ job, events, onCancel }: { job: BackgroundJob; events: JobEvent[]; onCancel: (jobId: string) => Promise<void> }): JSX.Element {
  const [cancelling, setCancelling] = useState(false);
  const { budget, consumption } = job;
  const pct = Math.round((consumption.candidatesEvaluated / budget.maxCandidates) * 100);
  const canCancel = job.status === "running" || job.status === "paused";

  return (
    <section className="job-panel" aria-label="Running background experiment">
      <header className="job-panel__header">
        <div>
          <div className="job-panel__title">Running experiment</div>
          <p className="job-panel__objective">{job.objective}</p>
        </div>
        <Badge tone={job.status === "running" ? "info" : job.status === "cancelling" ? "warning" : job.status === "failed" ? "danger" : "success"}>{job.status}</Badge>
      </header>

      <div className="job-panel__progress">
        <div className="job-panel__progress-track">
          <div className="job-panel__progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="mono job-panel__progress-label">{`${consumption.candidatesEvaluated} / ${budget.maxCandidates} candidates`}</span>
      </div>

      <dl className="job-panel__budget mono">
        <div>
          <dt>Tool calls</dt>
          <dd>
            {consumption.toolCallsUsed} / {budget.maxToolCalls}
          </dd>
        </div>
        <div>
          <dt>Model calls</dt>
          <dd>
            {consumption.modelCallsUsed} / {budget.maxModelCalls}
          </dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>
            {Math.round(consumption.durationMsUsed / 1000)}s / {Math.round(budget.maxDurationMs / 1000)}s
          </dd>
        </div>
      </dl>

      <ul className="job-panel__events">
        {events.map((event) => (
          <li key={event.id}>
            <Badge tone={eventTone(event.kind)}>{event.kind.replace(/_/g, " ")}</Badge>
            <span>{event.message}</span>
          </li>
        ))}
      </ul>

      <div className="job-panel__actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={!canCancel || cancelling}
          onClick={async () => {
            setCancelling(true);
            try {
              await onCancel(job.id);
            } finally {
              setCancelling(false);
            }
          }}
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </button>
      </div>
    </section>
  );
}
