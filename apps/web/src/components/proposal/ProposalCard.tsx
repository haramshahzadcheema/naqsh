import { useRef, useState } from "react";
import type { EngineeringObject, Proposal } from "@naqsh/schemas";
import { Badge } from "../common/StatusDot.js";

const STATUS_TONE = {
  proposed: "pending",
  approved: "success",
  rejected: "danger",
  executed: "info",
  superseded: "neutral"
} as const;

interface PropertyChange {
  key: string;
  before: unknown;
  after: unknown;
  /** `false` when the CURRENT value genuinely isn't known (the target
   * object hasn't been synced into the World Model yet, or this proposal
   * doesn't target a single object/property at all) -- shown as an honest
   * "→ after" without inventing a starting value, never a fabricated
   * "unknown → after" that LOOKS like real data. */
  hasBefore: boolean;
}

/** Resolves a genuine Before -> After property change by cross-referencing
 * the proposal's OWN input against the target object's CURRENT recorded
 * state (`objects`, the World Model's real `EngineeringObject`s) -- never
 * only the "after" side `Proposal.input` carries on its own. */
function resolveChange(proposal: Proposal, objects: EngineeringObject[]): PropertyChange | null {
  const input = proposal.input;
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const key = typeof record.propertyKey === "string" ? record.propertyKey : null;
  const after = "value" in record ? record.value : undefined;
  if (!key || after === undefined) return null;

  const target = proposal.target?.entityType === "object" ? objects.find((object) => object.id === proposal.target?.entityId) : undefined;
  const hasBefore = !!target && key in target.properties;
  return { key, before: hasBefore ? target!.properties[key] : undefined, after, hasBefore };
}

export function ProposalCard({
  proposal,
  objects = [],
  onApprove,
  onReject
}: {
  proposal: Proposal;
  /** The World Model's current engineering objects, so a real Before ->
   * After can be shown -- optional (defaults to none known) since not
   * every caller has project-wide object state on hand. */
  objects?: EngineeringObject[];
  onApprove: (proposal: Proposal) => Promise<void>;
  onReject: (proposal: Proposal) => Promise<void>;
}): JSX.Element {
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  // A plain ref, not just `pending` state: React batches/defers the
  // re-render that flips the button's `disabled` attribute, so a fast
  // double-click (or double `Enter`) can fire this handler TWICE before
  // that re-render ever commits -- the second call would otherwise reach
  // the server and get a real, honest, but confusing "already approved"
  // error back. This ref is set synchronously, before any `await`, so the
  // second invocation is rejected the instant it happens, independent of
  // render timing.
  const inFlightRef = useRef(false);
  const change = resolveChange(proposal, objects);
  const isDecided = proposal.status !== "proposed";

  const handle = async (action: "approve" | "reject") => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPending(action);
    try {
      if (action === "approve") await onApprove(proposal);
      else await onReject(proposal);
    } finally {
      inFlightRef.current = false;
      setPending(null);
    }
  };

  return (
    <article className="proposal-card" aria-labelledby={`${proposal.id}-title`}>
      <header className="proposal-card__header">
        <span className="proposal-card__eyebrow">Proposed change</span>
        <Badge tone={STATUS_TONE[proposal.status]}>{proposal.status}</Badge>
      </header>

      <h3 id={`${proposal.id}-title`} className="proposal-card__title">
        {proposal.objectiveSummary}
      </h3>

      {change ? (
        <div className="proposal-card__diff">
          <span className="proposal-card__diff-key">{change.key}</span>
          <span className="mono">
            {change.hasBefore ? <span className="proposal-card__diff-before">{String(change.before)}</span> : <span className="proposal-card__diff-unknown">current value unknown</span>}
            <span className="proposal-card__diff-arrow" aria-hidden="true">
              →
            </span>
            <span className="proposal-card__diff-after">{String(change.after)}</span>
          </span>
        </div>
      ) : null}

      <dl className="proposal-card__facts">
        <div>
          <dt>Reason</dt>
          <dd>{proposal.rationale}</dd>
        </div>
        <div>
          <dt>Expected effect</dt>
          <dd>{proposal.expectedEffect}</dd>
        </div>
        <div>
          <dt>Revertibility</dt>
          {/* A real, always-true guarantee, not a fabricated risk score:
              engineeringWorkflow.ts's executeProposal ALWAYS creates a
              real checkpoint before mutating anything, and aborts outright
              if that checkpoint can't be created -- so approving this
              never risks an unrecoverable change. There is deliberately
              no separate "Risk: Low/Medium/High" field here: no such
              classification exists anywhere in the schema, and inventing
              one would be exactly the fabricated UI this codebase avoids. */}
          <dd>Reversible -- Naqsh saves a checkpoint before executing, and this change can be restored afterward.</dd>
        </div>
      </dl>

      <div className="proposal-card__actions">
        <button type="button" className="btn btn--primary" disabled={isDecided || pending !== null} onClick={() => handle("approve")}>
          {pending === "approve" ? "Approving…" : "Approve change"}
        </button>
        <button type="button" className="btn btn--ghost" disabled={isDecided || pending !== null} onClick={() => handle("reject")}>
          {pending === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </article>
  );
}
