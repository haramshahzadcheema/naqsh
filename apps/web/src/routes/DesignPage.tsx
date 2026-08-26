import { useState } from "react";
import type { Plan } from "@naqsh/schemas";
import { CandidateComparison } from "../components/design/CandidateComparison.js";
import { ProposalCard } from "../components/proposal/ProposalCard.js";
import { VerificationPanel } from "../components/verification/VerificationPanel.js";
import { useProjectData } from "../data/ProjectDataProvider.js";
import { useSettings } from "../settings/SettingsProvider.js";
import { LoadingState, ErrorState, EmptyState } from "../components/common/States.js";
import { deriveRecommendedCandidateId } from "../data/deriveRecommendedCandidate.js";

const CANDIDATE_COUNT_OPTIONS = [1, 2, 3, 4, 5, 6];

/**
 * Real trigger for `generateCandidates` (Gemini-backed, `apps/api`'s
 * `POST /projects/:id/plans/:planId/candidates`) -- only rendered once a
 * real backend project with a real Plan exists, since candidate generation
 * has no meaningful offline-demo equivalent (see `demoDataSource`'s
 * `generateCandidates`, which honestly throws). Reports genuine success
 * ("N generated, M failed") or the real error rather than pretending the
 * request always succeeds.
 */
function GenerateCandidatesPanel({ plan }: { plan: Plan }): JSX.Element {
  const { generateCandidates } = useProjectData();
  const { modelId } = useSettings();
  const [stepId, setStepId] = useState(() => plan.steps.find((s) => s.status === "pending" || s.status === "in_progress")?.id ?? plan.steps[0]!.id);
  const [count, setCount] = useState(3);
  const [status, setStatus] = useState<{ kind: "idle" } | { kind: "pending" } | { kind: "done"; generatedCount: number; failedCount: number } | { kind: "error"; message: string }>({ kind: "idle" });

  const handleGenerate = async () => {
    setStatus({ kind: "pending" });
    try {
      const outcome = await generateCandidates(plan.id, stepId, count, modelId);
      setStatus({ kind: "done", generatedCount: outcome.generatedCount, failedCount: outcome.failedCount });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "Candidate generation failed." });
    }
  };

  const isPending = status.kind === "pending";

  return (
    <section className="candidate-generate">
      <h2 className="view-section-title">Generate candidate designs</h2>
      <p className="state-message">Ask Naqsh to propose alternative design candidates for one plan step, using the reasoning model currently selected in Settings.</p>
      <div className="candidate-generate__controls">
        <label className="candidate-generate__field">
          <span>Plan step</span>
          <select value={stepId} onChange={(event) => setStepId(event.target.value)} disabled={isPending}>
            {plan.steps.map((step) => (
              <option key={step.id} value={step.id}>
                {step.title}
              </option>
            ))}
          </select>
        </label>
        <label className="candidate-generate__field">
          <span>Variations</span>
          <select value={count} onChange={(event) => setCount(Number(event.target.value))} disabled={isPending}>
            {CANDIDATE_COUNT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn--primary" disabled={isPending} onClick={handleGenerate}>
          {isPending ? "Generating…" : "Generate candidates"}
        </button>
      </div>
      {status.kind === "done" ? (
        // Composed into ONE string, not two adjacent expressions: this is
        // a role="status" live region, and adjacent text nodes get
        // announced as separate fragments by screen readers rather than
        // one sentence. (It also made the node unqueryable as a whole,
        // which is how the split was noticed.)
        <p className="state-message" role="status">
          {[
            status.generatedCount > 0 ? `Generated ${status.generatedCount} candidate${status.generatedCount === 1 ? "" : "s"}.` : "No candidates were generated.",
            status.failedCount > 0 ? `${status.failedCount} variation${status.failedCount === 1 ? "" : "s"} failed.` : null
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      ) : null}
      {status.kind === "error" ? (
        <p className="state-message" role="alert">
          {status.message}
        </p>
      ) : null}
    </section>
  );
}

export function DesignPage(): JSX.Element {
  const { snapshot, decideProposal, isRealProject } = useProjectData();

  if (snapshot.status === "loading") return <LoadingState label="Comparing candidates…" />;
  if (snapshot.status === "error") return <ErrorState title="Could not load design data" message={snapshot.message} />;

  const { data } = snapshot;

  const generatePanel = isRealProject && data.plan && data.plan.steps.length > 0 ? <GenerateCandidatesPanel key="generate-candidates" plan={data.plan} /> : null;

  const hasCandidates = data.candidates.length > 0;
  const recommendedCandidateId = hasCandidates ? deriveRecommendedCandidateId(data.candidates, data.experiments) : null;

  // AUDIT FIX: this used to be TWO separate `return`s -- one for the
  // empty state, one for the populated state -- each rendering
  // `generatePanel` at a different position in the tree. Generating your
  // FIRST candidate flips between them, so React unmounted and remounted
  // GenerateCandidatesPanel, discarding its local status state and wiping
  // the "Generated 1 candidate." confirmation the instant it appeared.
  // A successful generation therefore looked like nothing had happened,
  // which is the single most damaging thing this screen could do. One
  // return, one stable tree position, state survives the reload.
  return (
    <div className="view-stack">
      {data.proposals.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          objects={data.objects}
          onApprove={async (p) => {
            await decideProposal(p.id, "approved");
          }}
          onReject={async (p) => {
            await decideProposal(p.id, "rejected");
          }}
        />
      ))}

      {hasCandidates ? (
        <section>
          <h2 className="view-section-title">Candidate designs</h2>
          <CandidateComparison candidates={data.candidates} experiments={data.experiments} verificationResults={data.verificationResults} recommendedCandidateId={recommendedCandidateId} />
        </section>
      ) : (
        <EmptyState
          title="No design yet"
          message={
            isRealProject && (!data.plan || data.plan.steps.length === 0)
              ? "Naqsh needs a plan before it can propose candidate designs -- capture requirements in chat first."
              : "Once Naqsh proposes candidate designs, you'll be able to compare and approve them here."
          }
        />
      )}

      {generatePanel}

      {hasCandidates ? <VerificationPanel checks={data.checks} results={data.verificationResults} objectiveSatisfaction={data.objectiveSatisfaction} /> : null}
    </div>
  );
}
