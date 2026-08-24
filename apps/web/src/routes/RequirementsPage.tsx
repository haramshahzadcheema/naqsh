import { RequirementsView } from "../components/requirements/RequirementsView.js";
import { useProjectData } from "../data/ProjectDataProvider.js";
import { LoadingState, ErrorState } from "../components/common/States.js";

export function RequirementsPage(): JSX.Element {
  const { snapshot, answerClarification } = useProjectData();

  if (snapshot.status === "loading") return <LoadingState label="Analyzing requirements…" />;
  if (snapshot.status === "error") return <ErrorState title="Could not load requirements" message={snapshot.message} />;

  const { data } = snapshot;
  return (
    <RequirementsView
      requirements={data.requirements}
      constraints={data.constraints}
      clarifications={data.clarifications}
      onAnswerClarification={async (id, answer) => {
        await answerClarification(id, answer);
      }}
    />
  );
}
