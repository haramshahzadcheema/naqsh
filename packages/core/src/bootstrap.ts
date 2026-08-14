import {
  createWorldModelState,
  type ObjectiveInput,
  type ProjectInput,
  type SessionStateInput,
  type WorldModelState
} from "@naqsh/schemas";

export interface InitializeWorldModelInput {
  project?: ProjectInput;
  session?: SessionStateInput;
  name?: string;
  description?: string;
  objective?: ObjectiveInput;
}

/** Convenience entry point for starting a new project run — this is
 * orchestration sugar over @naqsh/schemas' factories, not a new contract. */
export function initializeWorldModel(input: InitializeWorldModelInput = {}): WorldModelState {
  return createWorldModelState({
    project: input.project ?? {
      name: input.name ?? "",
      description: input.description ?? "",
      objective: input.objective ?? { summary: "" }
    },
    session: input.session ?? {}
  });
}

export function createEmptyWorldModelState(): WorldModelState {
  return createWorldModelState({
    project: {
      name: "Untitled Project",
      description: "",
      objective: { summary: "" }
    },
    session: {}
  });
}
