import { EngineeringViewport } from "../components/viewport/EngineeringViewport.js";
import { useProjectData } from "../data/ProjectDataProvider.js";
import { LoadingState, ErrorState } from "../components/common/States.js";

export function OverviewPage(): JSX.Element {
  const { snapshot } = useProjectData();

  if (snapshot.status === "loading") return <LoadingState label="Observing environment…" />;
  if (snapshot.status === "error") return <ErrorState title="Could not load project" message={snapshot.message} />;

  const { data } = snapshot;
  const pendingProposals = data.proposals.filter((p) => p.status === "proposed").length;
  const openClarifications = data.clarifications.filter((c) => c.status === "pending").length;

  return (
    <div className="overview-page">
      <div className="overview-page__summary">
        <div className="summary-stat">
          <span className="summary-stat__value mono">{data.requirements.length}</span>
          <span className="summary-stat__label">Requirements</span>
        </div>
        <div className="summary-stat">
          <span className="summary-stat__value mono">{data.candidates.length}</span>
          <span className="summary-stat__label">Candidates</span>
        </div>
        <div className="summary-stat">
          <span className={`summary-stat__value mono${pendingProposals > 0 ? " text-warning" : ""}`}>{pendingProposals}</span>
          <span className="summary-stat__label">Pending approval</span>
        </div>
        <div className="summary-stat">
          <span className={`summary-stat__value mono${openClarifications > 0 ? " text-warning" : ""}`}>{openClarifications}</span>
          <span className="summary-stat__label">Needs clarification</span>
        </div>
      </div>
      <EngineeringViewport />
    </div>
  );
}
