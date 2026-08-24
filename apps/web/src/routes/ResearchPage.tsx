import { ResearchView } from "../components/research/ResearchView.js";
import { useProjectData } from "../data/ProjectDataProvider.js";
import { LoadingState, ErrorState } from "../components/common/States.js";

export function ResearchPage(): JSX.Element {
  const { snapshot } = useProjectData();
  if (snapshot.status === "loading") return <LoadingState label="Gathering research…" />;
  if (snapshot.status === "error") return <ErrorState title="Could not load research" message={snapshot.message} />;
  return <ResearchView sources={snapshot.data.sources} evidence={snapshot.data.evidence} />;
}
