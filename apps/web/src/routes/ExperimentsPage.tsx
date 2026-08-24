import { ExperimentsView } from "../components/experiments/ExperimentsView.js";
import { useProjectData } from "../data/ProjectDataProvider.js";
import { LoadingState, ErrorState } from "../components/common/States.js";
import { deriveRecommendedCandidateId } from "../data/deriveRecommendedCandidate.js";

export function ExperimentsPage(): JSX.Element {
  const { snapshot, cancelBackgroundJob } = useProjectData();

  if (snapshot.status === "loading") return <LoadingState label="Loading experiments…" />;
  if (snapshot.status === "error") return <ErrorState title="Could not load experiments" message={snapshot.message} />;

  const { data } = snapshot;
  return (
    <ExperimentsView
      candidates={data.candidates}
      experiments={data.experiments}
      verificationResults={data.verificationResults}
      recommendedCandidateId={deriveRecommendedCandidateId(data.candidates, data.experiments)}
      backgroundJobs={data.backgroundJobs}
      jobEvents={data.jobEvents}
      onCancelJob={cancelBackgroundJob}
    />
  );
}
