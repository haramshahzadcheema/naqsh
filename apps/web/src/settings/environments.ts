export type EnvironmentChoice = "mock_cad" | "mock_simulation";

export interface EnvironmentOption {
  id: EnvironmentChoice;
  name: string;
  description: string;
  status: string;
  selectable: boolean;
}

/** The real, complete environment-kind value space `apps/api` can
 * actually connect a NEW project to (`ApiEnvironmentKind`,
 * `apps/api/src/db/repositories.ts`'s `EnvironmentKind`) -- this picker
 * only ever offers choices that genuinely change what happens when the
 * user creates a project next. "FreeCAD" is listed as a REAL, honest
 * reference (a tested adapter exists in `@naqsh/adapters`) but is
 * deliberately not selectable: nothing in this deployment drives a live
 * FreeCAD session from the server, so offering it as a pickable choice
 * would be exactly the "control that appears functional but silently
 * does nothing" this application's own principles forbid. */
export const ENVIRONMENT_OPTIONS: EnvironmentOption[] = [
  { id: "mock_cad", name: "Mock CAD", description: "A deterministic, fully connected mock CAD environment -- real object creation/modification, no external tooling required.", status: "Connected", selectable: true },
  { id: "mock_simulation", name: "Mock Simulation", description: "A deterministic, fully connected mock simulation environment.", status: "Connected", selectable: true }
];

export interface UnavailableEnvironment {
  id: string;
  name: string;
  description: string;
  status: string;
}

/** Not one of `ENVIRONMENT_OPTIONS` -- has no real `EnvironmentChoice` id
 * at all, because it isn't selectable. Shown separately in Settings as an
 * honest "exists, not wired up yet" entry rather than a pickable option
 * that would silently fall back to Mock CAD if chosen. */
export const UNAVAILABLE_ENVIRONMENTS: UnavailableEnvironment[] = [
  { id: "freecad", name: "FreeCAD", description: "Parametric CAD environment.", status: "Adapter exists in @naqsh/adapters — not connected to a live session in this deployment" }
];

export const DEFAULT_ENVIRONMENT: EnvironmentChoice = "mock_cad";
