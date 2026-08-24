import { ActivityTimeline } from "../components/history/ActivityTimeline.js";
import { useProjectData } from "../data/ProjectDataProvider.js";
import { LoadingState, ErrorState } from "../components/common/States.js";

export function HistoryPage(): JSX.Element {
  const { snapshot } = useProjectData();
  if (snapshot.status === "loading") return <LoadingState label="Loading history…" />;
  if (snapshot.status === "error") return <ErrorState title="Could not load history" message={snapshot.message} />;
  return <ActivityTimeline snapshot={snapshot.data} />;
}
