import { useState } from "react";
import type { MemoryRecord } from "@naqsh/schemas";
import { Badge } from "../common/StatusDot.js";
import { EmptyState } from "../common/States.js";

const KIND_LABEL: Record<string, string> = {
  decision: "Decision",
  preference: "Preference",
  lesson: "Lesson",
  failure: "Failure",
  success: "Success",
  experiment_finding: "Experiment finding",
  verification_finding: "Verification finding",
  optimization_finding: "Optimization finding",
  research_finding: "Research finding",
  historical_observation: "Historical observation"
};

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  archived: "Archived",
  rejected: "Forgotten",
  superseded: "Superseded"
};

type ActionState = { phase: "idle" } | { phase: "working" } | { phase: "error"; message: string };

/** Engineering knowledge, not a chat history: each record shows WHAT was
 * learned/decided, WHY, and WHERE it came from — never a raw event log.
 * `onArchive`, when supplied, turns each active record's Archive/Forget
 * into a REAL lifecycle transition (`MemoryStore.archive`, @naqsh/core) --
 * there is deliberately no "Edit" action: a memory's content is immutable
 * once created, so the UI never offers a control with nothing real behind
 * it. */
export function MemoryView({
  records,
  onArchive
}: {
  records: MemoryRecord[];
  onArchive?: (memoryId: string, status: "archived" | "rejected", reason?: string) => Promise<MemoryRecord>;
}): JSX.Element {
  const [actionState, setActionState] = useState<Record<string, ActionState>>({});

  if (records.length === 0) {
    return <EmptyState title="No memory yet" message="Durable decisions, preferences, and findings will accumulate here as Naqsh works on this project." />;
  }

  async function handleArchive(memoryId: string, status: "archived" | "rejected"): Promise<void> {
    if (!onArchive) return;
    setActionState((prev) => ({ ...prev, [memoryId]: { phase: "working" } }));
    try {
      await onArchive(memoryId, status);
      setActionState((prev) => ({ ...prev, [memoryId]: { phase: "idle" } }));
    } catch (error) {
      setActionState((prev) => ({ ...prev, [memoryId]: { phase: "error", message: error instanceof Error ? error.message : "Could not update this memory." } }));
    }
  }

  return (
    <ul className="memory-list">
      {records.map((record) => {
        const state = actionState[record.id] ?? { phase: "idle" };
        return (
          <li key={record.id} className="memory-card">
            <header className="memory-card__header">
              <Badge tone={record.kind === "failure" ? "danger" : record.kind === "success" ? "success" : "info"}>{KIND_LABEL[record.kind] ?? record.kind}</Badge>
              <span className="mono memory-card__date">{new Date(record.createdAt).toLocaleDateString()}</span>
            </header>
            <h3 className="memory-card__title">{record.title}</h3>
            <p className="memory-card__content">{record.content}</p>
            <footer className="memory-card__footer">
              <span>Source: {record.provenanceKind.replace(/_/g, " ")}</span>
              <span>Status: {STATUS_LABEL[record.status] ?? record.status}</span>
            </footer>
            {onArchive && record.status === "active" ? (
              <div className="memory-card__actions">
                <button type="button" className="btn btn--ghost btn--sm" disabled={state.phase === "working"} onClick={() => handleArchive(record.id, "archived")}>
                  Archive
                </button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={state.phase === "working"} onClick={() => handleArchive(record.id, "rejected")}>
                  Forget (found incorrect)
                </button>
                {state.phase === "error" ? (
                  <span className="memory-card__action-error" role="alert">
                    {state.message}
                  </span>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
