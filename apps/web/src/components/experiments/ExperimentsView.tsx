import type { BackgroundJob, Candidate, Experiment, JobEvent, VerificationResult } from "@naqsh/schemas";
import { CandidateComparison } from "../design/CandidateComparison.js";
import { BackgroundJobPanel } from "../jobs/BackgroundJobPanel.js";
import { EmptyState } from "../common/States.js";

export function ExperimentsView({
  candidates,
  experiments,
  verificationResults,
  recommendedCandidateId,
  backgroundJobs,
  jobEvents,
  onCancelJob
}: {
  candidates: Candidate[];
  experiments: Experiment[];
  verificationResults: VerificationResult[];
  recommendedCandidateId: string | null;
  backgroundJobs: BackgroundJob[];
  jobEvents: JobEvent[];
  onCancelJob: (jobId: string) => Promise<void>;
}): JSX.Element {
  if (candidates.length === 0 && backgroundJobs.length === 0) {
    return <EmptyState title="No experiments yet" message="Once you have multiple candidate designs, Naqsh can evaluate them here." />;
  }

  return (
    <div className="view-stack">
      {candidates.length > 0 ? (
        <section>
          <h2 className="view-section-title">Candidate comparison</h2>
          <CandidateComparison candidates={candidates} experiments={experiments} verificationResults={verificationResults} recommendedCandidateId={recommendedCandidateId} />
        </section>
      ) : null}

      {backgroundJobs.map((job) => (
        <BackgroundJobPanel key={job.id} job={job} events={jobEvents.filter((event) => event.jobId === job.id)} onCancel={onCancelJob} />
      ))}
    </div>
  );
}
