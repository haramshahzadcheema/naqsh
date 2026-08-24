import { MemoryView } from "../components/memory/MemoryView.js";
import { useProjectData } from "../data/ProjectDataProvider.js";
import { LoadingState, ErrorState } from "../components/common/States.js";

export function MemoryPage(): JSX.Element {
  const { snapshot, archiveMemory } = useProjectData();
  if (snapshot.status === "loading") return <LoadingState label="Recalling project memory…" />;
  if (snapshot.status === "error") return <ErrorState title="Could not load memory" message={snapshot.message} />;
  return <MemoryView records={snapshot.data.memoryRecords} onArchive={archiveMemory} />;
}
