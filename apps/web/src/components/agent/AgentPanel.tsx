import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentEvent, AgentEventKind } from "../../data/NaqshDataSource.js";
import { useProjectData } from "../../data/ProjectDataProvider.js";
import { LoadingState, ErrorState, EmptyState } from "../common/States.js";

const KIND_LABEL: Record<AgentEventKind, string> = {
  observed: "Observed",
  reasoning: "Reasoning",
  recommendation: "Recommendation",
  proposal: "Proposal",
  verification: "Verification",
  note: "Note"
};

function AgentEventRow({ event }: { event: AgentEvent }): JSX.Element {
  const navigate = useNavigate();
  return (
    <li className={`agent-event agent-event--${event.kind}`}>
      <div className="agent-event__kind">{KIND_LABEL[event.kind]}</div>
      <div className="agent-event__title">{event.title !== KIND_LABEL[event.kind] ? event.title : null}</div>
      <p className="agent-event__body">{event.body}</p>
      {event.proposalId ? (
        <div className="agent-event__actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => navigate("/design")}>
            Review proposal
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The signature UI surface: NOT a chat log. Every entry is a structured
 * statement of what Naqsh noticed, why, and what it recommends — the
 * human decides what happens next, always from the Proposal/Approval UI,
 * never from this panel directly mutating anything.
 */
export function AgentPanel(): JSX.Element {
  const { agentEvents } = useProjectData();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <section className={collapsed ? "agent-panel is-collapsed" : "agent-panel"} aria-label="Agent collaborator">
      <div className="agent-panel__header">
        <span className="agent-panel__title">AI Collaborator</span>
        <span className="agent-panel__subtitle">What Naqsh is noticing and proposing</span>
        <button type="button" className="agent-panel__collapse" onClick={() => setCollapsed((v) => !v)} aria-expanded={!collapsed}>
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>
      <div className="agent-panel__body">
        {agentEvents.status === "loading" ? <LoadingState label="Observing environment…" /> : null}
        {agentEvents.status === "error" ? <ErrorState title="Agent activity unavailable" message={agentEvents.message} /> : null}
        {agentEvents.status === "ready" && agentEvents.data.length === 0 ? (
          <EmptyState title="No activity yet" message="Once you describe an objective, Naqsh will narrate what it observes here." />
        ) : null}
        {agentEvents.status === "ready" && agentEvents.data.length > 0 ? (
          <ul className="agent-event-list">
            {agentEvents.data.map((event) => (
              <AgentEventRow key={event.id} event={event} />
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
