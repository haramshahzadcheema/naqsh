import { ExperimentsView } from "../components/experiments/ExperimentsView.js";
import { BuildFailures } from "../components/experiments/BuildFailures.js";
import { useProjectData } from "../data/ProjectDataProvider.js";
import { LoadingState, ErrorState } from "../components/common/States.js";
import { deriveRecommendedCandidateId } from "../data/deriveRecommendedCandidate.js";

export function ExperimentsPage(): JSX.Element {
  const { snapshot, cancelBackgroundJob } = useProjectData();

  if (snapshot.status === "loading") return <LoadingState label="Loading experiments…" />;
  if (snapshot.status === "error") return <ErrorState title="Could not load experiments" message={snapshot.message} />;

  const { data } = snapshot;
  return (
    <>
      {/* Above the comparison deliberately: a failed build explains why a
          candidate has no results at all, so it has to be readable before
          you try to interpret the empty comparison below it. */}
      <BuildFailures buildResults={data.buildResults} />
      <ExperimentsView
        candidates={data.candidates}
        experiments={data.experiments}
        verificationResults={data.verificationResults}
        recommendedCandidateId={deriveRecommendedCandidateId(data.candidates, data.experiments)}
        backgroundJobs={data.backgroundJobs}
        jobEvents={data.jobEvents}
        onCancelJob={cancelBackgroundJob}
      />
    </>
  );
}
