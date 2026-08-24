import { ArtifactsView } from "../components/artifacts/ArtifactsView.js";
import { useProjectData } from "../data/ProjectDataProvider.js";
import { LoadingState, ErrorState } from "../components/common/States.js";

export function ArtifactsPage(): JSX.Element {
  const { snapshot } = useProjectData();

  if (snapshot.status === "loading") return <LoadingState label="Loading artifacts…" />;
  if (snapshot.status === "error") return <ErrorState title="Could not load artifacts" message={snapshot.message} />;

  return <ArtifactsView designSpecifications={snapshot.data.designSpecifications} />;
}
