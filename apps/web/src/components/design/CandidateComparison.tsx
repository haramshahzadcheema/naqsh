import type { Candidate, Experiment, VerificationResult } from "@naqsh/schemas";
import { Badge } from "../common/StatusDot.js";

/** Real per-candidate check counts, derived from `Experiment.
 * verificationResultIds` cross-referenced against `verificationResults` --
 * never a fabricated measurement table. A candidate whose experiment(s)
 * carry no verification result ids yet (build succeeded but nothing has
 * been checked, or the job hasn't reached this candidate) honestly shows
 * no check line at all, rather than inventing pass/fail data. */
function checkSummary(experiments: Experiment[], verificationResults: VerificationResult[]): { passed: number; total: number } | null {
  const resultById = new Map(verificationResults.map((result) => [result.id, result]));
  const ids = experiments.flatMap((experiment) => experiment.verificationResultIds);
  if (ids.length === 0) return null;
  const resolved = ids.map((id) => resultById.get(id)).filter((result): result is VerificationResult => result !== undefined);
  if (resolved.length === 0) return null;
  return { passed: resolved.filter((result) => result.status === "pass").length, total: resolved.length };
}

/** Deterministic measurements are rendered as plain data; the
 * recommendation line is visually distinct (labeled, not bolded into the
 * measurement rows) so it never reads as another measured value. */
export function CandidateComparison({
  candidates,
  experiments,
  verificationResults,
  recommendedCandidateId
}: {
  candidates: Candidate[];
  experiments: Experiment[];
  verificationResults: VerificationResult[];
  recommendedCandidateId: string | null;
}): JSX.Element {
  const experimentsByCandidate = new Map<string, Experiment[]>();
  for (const experiment of experiments) {
    if (!experiment.candidateId) continue;
    const list = experimentsByCandidate.get(experiment.candidateId) ?? [];
    list.push(experiment);
    experimentsByCandidate.set(experiment.candidateId, list);
  }

  return (
    <div className="candidate-comparison">
      <div className="candidate-grid">
        {candidates.map((candidate, index) => {
          const candidateExperiments = experimentsByCandidate.get(candidate.id) ?? [];
          const latestExperiment = [...candidateExperiments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
          const summary = checkSummary(candidateExperiments, verificationResults);
          const label = String.fromCharCode(65 + index);
          const isRecommended = candidate.id === recommendedCandidateId;
          return (
            <article key={candidate.id} className={`candidate-card${isRecommended ? " is-recommended" : ""}`}>
              <header className="candidate-card__header">
                <span className="candidate-card__label">Candidate {label}</span>
                <Badge tone={latestExperiment?.status === "complete" ? "success" : latestExperiment?.status === "failed" ? "danger" : "pending"}>
                  {latestExperiment?.status ?? "planned"}
                </Badge>
              </header>
              <p className="candidate-card__hypothesis">{candidate.hypothesis}</p>
              {summary ? (
                <dl className="candidate-card__metrics mono">
                  <div>
                    <dt>Checks passed</dt>
                    <dd className={summary.passed === summary.total ? "text-success" : "text-danger"}>
                      {summary.passed} / {summary.total}
                    </dd>
                  </div>
                </dl>
              ) : null}
              {isRecommended ? <div className="candidate-card__recommended">Recommended</div> : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
