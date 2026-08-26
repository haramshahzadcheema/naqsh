import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Clarification, MemoryRecord, Proposal } from "@naqsh/schemas";
import type { AgentEvent, EnvironmentStatus, NaqshDataSource, ProjectSnapshot, ProjectSummary } from "./NaqshDataSource.js";
import { createDemoDataSource } from "./demo/demoDataSource.js";
import { createHttpDataSource } from "./HttpDataSource.js";
import { DEMO_PROJECT } from "./demo/demoProject.js";
import { useApiConnection } from "../api/ApiConnectionProvider.js";
import { useSettings } from "../settings/SettingsProvider.js";

type LoadState<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

interface ProjectDataContextValue {
  snapshot: LoadState<ProjectSnapshot>;
  agentEvents: LoadState<AgentEvent[]>;
  environment: LoadState<EnvironmentStatus>;
  /** Whether the CURRENTLY active project's data is coming from the real
   * backend (`HttpDataSource`) or the offline/seeded demo
   * (`demoDataSource`) -- so a view can honestly label which one it's
   * showing, never implying every project is "real" when the API is
   * unreachable or no real project is selected yet. */
  isRealProject: boolean;
  decideProposal: (proposalId: string, decision: "approved" | "rejected") => Promise<Proposal>;
  answerClarification: (clarificationId: string, answerText: string) => Promise<Clarification>;
  cancelBackgroundJob: (jobId: string) => Promise<void>;
  /** Requests real Gemini-generated candidate designs for one plan step.
   * Only meaningful when `isRealProject` is true -- reloads the snapshot
   * afterward so newly-saved candidates/design specs appear. Rethrows on
   * failure (including a total-failure "nothing generated" outcome) so the
   * caller can surface the honest error rather than silently no-op-ing. */
  generateCandidates: (planId: string, planStepId: string, count: number, modelId: string) => Promise<{ generatedCount: number; failedCount: number }>;
  /** Explicitly triggers the real environment connect for the active
   * project, then refreshes -- see `NaqshDataSource.connectEnvironment`'s
   * own doc comment for why this needs to exist as a real action rather
   * than only ever happening implicitly. */
  connectEnvironment: () => Promise<void>;
  /** ONE captured live-view frame + a question, answered by a real model
   * provider for the active project -- bound to `effectiveProjectId`/
   * `modelId` so a caller (`LiveViewPanel`) never has to know either.
   * Rejects in the offline demo (see `demoDataSource.analyzeFrame`). */
  analyzeFrame: (imageDataUrl: string, question: string) => Promise<string>;
  /** A real lifecycle transition for one memory record, then refreshes --
   * see `NaqshDataSource.archiveMemory`'s own doc comment for why there is
   * no "edit" here. */
  archiveMemory: (memoryId: string, status: "archived" | "rejected", reason?: string) => Promise<MemoryRecord>;
  listProjects: () => Promise<ProjectSummary[]>;
  reload: () => void;
  /** Called by the chat layer (`MainShell`) whenever the active thread's
   * real backend project changes -- the ONE place this provider learns
   * "which project is the workspace currently looking at." `null` means
   * no real project is active (a brand-new, not-yet-backed thread, or the
   * API is unreachable), in which case this provider falls back to the
   * seeded demo project, exactly like before Phase B. */
  setActiveProjectId: (projectId: string | null) => void;
}

const ProjectDataContext = createContext<ProjectDataContextValue | null>(null);

const demoDataSource: NaqshDataSource = createDemoDataSource();
const httpDataSource: NaqshDataSource = createHttpDataSource();

export function ProjectDataProvider({ children }: { children: ReactNode }): JSX.Element {
  const apiConnection = useApiConnection();
  const { modelId } = useSettings();
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<LoadState<ProjectSnapshot>>({ status: "loading" });
  const [agentEvents, setAgentEvents] = useState<LoadState<AgentEvent[]>>({ status: "loading" });
  const [environment, setEnvironment] = useState<LoadState<EnvironmentStatus>>({ status: "loading" });
  const [generation, setGeneration] = useState(0);

  // A real project is active only once the API is confirmed reachable AND
  // the chat layer has told us a real backend project id -- otherwise
  // this provider shows the seeded demo project, exactly as before Phase B.
  const isRealProject = apiConnection.status === "connected" && activeProjectId !== null;
  const dataSource = isRealProject ? httpDataSource : demoDataSource;
  const effectiveProjectId = isRealProject ? activeProjectId! : DEMO_PROJECT.id;

  /**
   * Which project the CURRENTLY displayed data belongs to.
   *
   * AUDIT FIX -- this exists to distinguish a first load from a refresh.
   * Every one of these effects used to call `setState({status:"loading"})`
   * unconditionally, including on a mere `reload()`. Because each page
   * returns an early `<LoadingState/>` while loading, that meant EVERY
   * mutation -- approving a proposal, generating candidates, answering a
   * clarification, connecting an environment -- blanked the whole
   * workspace to a spinner and unmounted the page, destroying any local
   * component state with it.
   *
   * The most visible casualty was confirmation: `GenerateCandidatesPanel`
   * would report "Generated 1 candidate." and have it wiped in the same
   * tick by the reload that generation itself triggered, so a SUCCESSFUL
   * action looked like nothing had happened.
   *
   * Refreshes now revalidate in place and keep the last good data on
   * screen; only a genuine first load (or a switch to a different
   * project) shows a loading state.
   */
  const loadedProjectRef = useRef<string | null>(null);
  const agentEventsProjectRef = useRef<string | null>(null);
  const environmentProjectRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSnapshot((prev) => (prev.status === "ready" && loadedProjectRef.current === effectiveProjectId ? prev : { status: "loading" }));
    dataSource
      .getProjectSnapshot(effectiveProjectId)
      .then((data) => {
        if (cancelled) return;
        loadedProjectRef.current = effectiveProjectId;
        setSnapshot({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setSnapshot({ status: "error", message: error instanceof Error ? error.message : "Failed to load project." });
      });
    return () => {
      cancelled = true;
    };
  }, [generation, dataSource, effectiveProjectId]);

  useEffect(() => {
    let cancelled = false;
    setAgentEvents((prev) => (prev.status === "ready" && agentEventsProjectRef.current === effectiveProjectId ? prev : { status: "loading" }));
    dataSource
      .getAgentEvents(effectiveProjectId)
      .then((data) => {
        if (cancelled) return;
        agentEventsProjectRef.current = effectiveProjectId;
        setAgentEvents({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setAgentEvents({ status: "error", message: error instanceof Error ? error.message : "Failed to load agent activity." });
      });
    return () => {
      cancelled = true;
    };
  }, [generation, dataSource, effectiveProjectId]);

  useEffect(() => {
    let cancelled = false;
    dataSource
      .getEnvironmentStatus(effectiveProjectId)
      .then((data) => {
        if (cancelled) return;
        environmentProjectRef.current = effectiveProjectId;
        setEnvironment({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setEnvironment({ status: "error", message: error instanceof Error ? error.message : "Environment status unavailable." });
      });
    return () => {
      cancelled = true;
    };
  }, [generation, dataSource, effectiveProjectId]);

  const decideProposal = useCallback(
    async (proposalId: string, decision: "approved" | "rejected") => {
      const updated = await dataSource.decideProposal(proposalId, decision);
      // Patch the decided proposal immediately so the card stops offering
      // an action it has already taken, THEN reload everything.
      //
      // The surgical patch alone (all this used to do) was the single
      // biggest source of "I clicked Approve and nothing happened":
      // approving a proposal server-side also creates a checkpoint,
      // executes the tool, advances the plan step, writes the world
      // model, records activity, and can produce build results -- none of
      // which live on the returned Proposal. The rest of the UI kept
      // rendering pre-approval state, so the only visible feedback was a
      // second click failing with "already approved".
      setSnapshot((prev) => (prev.status === "ready" ? { status: "ready", data: { ...prev.data, proposals: prev.data.proposals.map((p) => (p.id === proposalId ? updated : p)) } } : prev));
      setGeneration((g) => g + 1);
      return updated;
    },
    [dataSource]
  );

  const answerClarification = useCallback(
    async (clarificationId: string, answerText: string) => {
      const updated = await dataSource.answerClarification(effectiveProjectId, clarificationId, answerText, modelId);
      // A resolved answer can also record a brand-new Requirement server-side
      // (the real HttpDataSource path) -- a full reload picks that up too,
      // not just this one clarification's own status.
      setGeneration((g) => g + 1);
      return updated;
    },
    [dataSource, effectiveProjectId, modelId]
  );

  const cancelBackgroundJob = useCallback(
    async (jobId: string) => {
      const updated = await dataSource.cancelBackgroundJob(jobId, effectiveProjectId);
      setSnapshot((prev) =>
        prev.status === "ready" ? { status: "ready", data: { ...prev.data, backgroundJobs: prev.data.backgroundJobs.map((j) => (j.id === jobId ? updated : j)) } } : prev
      );
      // Cancelling also stops mid-flight candidate builds and writes real
      // activity -- same reason decideProposal reloads above.
      setGeneration((g) => g + 1);
    },
    [dataSource, effectiveProjectId]
  );

  const generateCandidates = useCallback(
    async (planId: string, planStepId: string, count: number, modelId: string) => {
      const outcome = await dataSource.generateCandidates(effectiveProjectId, planId, planStepId, count, modelId);
      setGeneration((g) => g + 1);
      return outcome;
    },
    [dataSource, effectiveProjectId]
  );

  const connectEnvironment = useCallback(async () => {
    await dataSource.connectEnvironment(effectiveProjectId);
    setGeneration((g) => g + 1);
  }, [dataSource, effectiveProjectId]);

  const analyzeFrame = useCallback(
    (imageDataUrl: string, question: string) => dataSource.analyzeFrame(effectiveProjectId, imageDataUrl, question, modelId),
    [dataSource, effectiveProjectId, modelId]
  );

  const archiveMemory = useCallback(
    async (memoryId: string, status: "archived" | "rejected", reason?: string) => {
      const updated = await dataSource.archiveMemory(effectiveProjectId, memoryId, status, reason);
      setGeneration((g) => g + 1);
      return updated;
    },
    [dataSource, effectiveProjectId]
  );

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  const listProjects = useCallback(() => dataSource.listProjects(), [dataSource]);

  const value = useMemo(
    () => ({
      snapshot,
      agentEvents,
      environment,
      isRealProject,
      decideProposal,
      answerClarification,
      cancelBackgroundJob,
      generateCandidates,
      connectEnvironment,
      analyzeFrame,
      archiveMemory,
      listProjects,
      reload,
      setActiveProjectId
    }),
    [
      snapshot,
      agentEvents,
      environment,
      isRealProject,
      decideProposal,
      answerClarification,
      cancelBackgroundJob,
      generateCandidates,
      connectEnvironment,
      analyzeFrame,
      archiveMemory,
      listProjects,
      reload
    ]
  );

  return <ProjectDataContext.Provider value={value}>{children}</ProjectDataContext.Provider>;
}

export function useProjectData(): ProjectDataContextValue {
  const context = useContext(ProjectDataContext);
  if (!context) throw new Error("useProjectData must be used within a ProjectDataProvider");
  return context;
}
