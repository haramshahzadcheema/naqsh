import type { ProjectSnapshot } from "../../data/NaqshDataSource.js";
import { EmptyState } from "../common/States.js";

interface TimelineEntry {
  id: string;
  at: string;
  label: string;
}

// Requirements don't carry their own creation timestamp on the schema;
// anchor them to a fixed point for a stable, deterministic order.
const DEMO_REQUIREMENT_TIME = "2026-01-14T09:01:00.000Z";

function buildTimeline(snapshot: ProjectSnapshot): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const requirement of snapshot.requirements) {
    entries.push({ id: `req-${requirement.id}`, at: DEMO_REQUIREMENT_TIME, label: `Requirement added: ${requirement.description}` });
  }
  if (snapshot.plan) {
    entries.push({ id: `plan-${snapshot.plan.id}`, at: snapshot.plan.createdAt, label: `Plan generated: ${snapshot.plan.objectiveSummary}` });
  }
  for (const item of snapshot.evidence) {
    entries.push({ id: `ev-${item.id}`, at: item.retrievedAt, label: "Research completed" });
  }
  for (const candidate of snapshot.candidates) {
    entries.push({ id: `cand-${candidate.id}`, at: candidate.createdAt, label: `Candidate generated: ${candidate.hypothesis}` });
  }
  for (const experiment of snapshot.experiments) {
    entries.push({ id: `exp-${experiment.id}`, at: experiment.createdAt, label: `Experiment ${experiment.status}: ${experiment.conclusion ?? experiment.hypothesis}` });
  }
  for (const proposal of snapshot.proposals) {
    entries.push({ id: `prop-${proposal.id}`, at: proposal.createdAt, label: `Proposal created: ${proposal.objectiveSummary}` });
    if (proposal.status !== "proposed") {
      entries.push({ id: `prop-decided-${proposal.id}`, at: proposal.updatedAt, label: `Human ${proposal.status} the proposal` });
    }
  }
  if (snapshot.objectiveSatisfaction) {
    entries.push({
      id: `objsat-${snapshot.objectiveSatisfaction.id}`,
      at: snapshot.objectiveSatisfaction.evaluatedAt,
      label: snapshot.objectiveSatisfaction.status === "satisfied" ? "Objective satisfied" : "Objective not yet satisfied"
    });
  }
  for (const memory of snapshot.memoryRecords) {
    entries.push({ id: `mem-${memory.id}`, at: memory.createdAt, label: `Memory recorded: ${memory.title}` });
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

export function ActivityTimeline({ snapshot }: { snapshot: ProjectSnapshot }): JSX.Element {
  const entries = buildTimeline(snapshot);
  if (entries.length === 0) {
    return <EmptyState title="No activity yet" message="Once Naqsh starts working on this project, every meaningful step will appear here." />;
  }

  return (
    <ol className="timeline">
      {entries.map((entry) => (
        <li key={entry.id} className="timeline__entry">
          <span className="mono timeline__time">{new Date(entry.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
          <span className="timeline__dot" aria-hidden="true" />
          <span className="timeline__label">{entry.label}</span>
        </li>
      ))}
    </ol>
  );
}
