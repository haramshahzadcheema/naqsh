/**
 * The one concrete `NaqshDataSource` implementation that exists today.
 * Backed entirely by `demoProject.ts` (real schema-factory-built records).
 * Clearly named/isolated in a `demo/` directory so nothing accidentally
 * imports it expecting production behavior — see `NaqshDataSource.ts` for
 * what a real implementation would need to satisfy instead.
 */
import type { BackgroundJob, Clarification, MemoryRecord, Proposal } from "@naqsh/schemas";
import type { AgentEvent, EnvironmentStatus, NaqshDataSource, ProjectSnapshot } from "../NaqshDataSource.js";
import * as demo from "./demoProject.js";

/** Simulates real network latency so loading states are genuinely visible
 * rather than instantaneous-looking. Small and fixed, not random —
 * determinism matters for tests. */
function settle<T>(value: T, ms = 260): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export function createDemoDataSource(): NaqshDataSource {
  let proposals: Proposal[] = [demo.proposal];
  let clarifications: Clarification[] = [...demo.clarifications];
  let backgroundJob: BackgroundJob = demo.backgroundJob;
  let memoryRecords: MemoryRecord[] = [...demo.memoryRecords];

  const agentEvents: AgentEvent[] = [
    {
      id: "aev_observed",
      kind: "observed",
      title: "Observed",
      body: "Candidate B's mounting hole sits 2.4 mm from the plate edge.",
      createdAt: demo.proposal.createdAt
    },
    {
      id: "aev_reasoning",
      kind: "reasoning",
      title: "Reasoning",
      body: "The edge-clearance constraint requires at least 5 mm. At 2.4 mm, ordinary manufacturing tolerance could put this below the limit.",
      createdAt: demo.proposal.createdAt
    },
    {
      id: "aev_recommendation",
      kind: "recommendation",
      title: "Recommendation",
      body: "Increase the mounting-hole offset to 5.0 mm.",
      createdAt: demo.proposal.createdAt
    },
    {
      id: "aev_proposal",
      kind: "proposal",
      title: "Proposal",
      body: "Modify mounting-hole offset: 2.4 mm → 5.0 mm",
      createdAt: demo.proposal.createdAt,
      proposalId: demo.proposal.id
    }
  ];

  return {
    async getEnvironmentStatus(): Promise<EnvironmentStatus> {
      // Matches the real mock_cad adapter's own `.describe().capabilities`
      // (packages/adapters/src/mock-cad-environment.ts) -- not an
      // independently-invented list.
      return settle(
        { kind: "mock_cad", name: "Mock CAD Environment", status: "connected", capabilities: ["create", "modify", "delete", "save", "checkpoint"], documentName: demo.DEMO_PROJECT.name },
        80
      );
    },

    async connectEnvironment(): Promise<void> {
      // The offline demo's environment is always already "connected" (a
      // fixed literal above) -- nothing real to trigger here.
    },

    async analyzeFrame(): Promise<string> {
      // No real backend/model call in the offline demo -- an honest
      // rejection, never a fabricated canned "analysis" pretending to have
      // looked at an image nothing here actually saw.
      throw new Error("Frame analysis needs a real connected project -- this is the offline demo project.");
    },

    async listProjects() {
      return settle([{ id: demo.DEMO_PROJECT.id, name: demo.DEMO_PROJECT.name, version: demo.DEMO_PROJECT.version, createdAt: demo.DEMO_PROJECT.createdAt }], 200);
    },

    async getProjectSnapshot(projectId: string): Promise<ProjectSnapshot> {
      return settle(
        {
          project: demo.DEMO_PROJECT,
          requirements: demo.requirements,
          constraints: demo.constraints,
          clarifications,
          objects: demo.objects,
          plan: demo.plan,
          sources: demo.sources,
          evidence: demo.evidence,
          candidates: demo.candidates,
          designSpecifications: demo.designSpecifications,
          checks: demo.checks,
          verificationResults: demo.verificationResults,
          experiments: demo.experiments,
          objectiveSatisfaction: demo.objectiveSatisfaction,
          proposals,
          decisions: demo.decisions,
          memoryRecords,
          backgroundJobs: [backgroundJob],
          jobEvents: demo.jobEvents,
          // Phase D: the seeded demo was never given a modeled file
          // upload -- an honest empty list, not a fabricated one.
          files: []
        },
        projectId === demo.DEMO_PROJECT.id ? 320 : 320
      );
    },

    async getAgentEvents(): Promise<AgentEvent[]> {
      return settle(agentEvents, 220);
    },

    async decideProposal(proposalId, decision): Promise<Proposal> {
      const current = proposals.find((entry) => entry.id === proposalId);
      if (!current) throw new Error(`Unknown proposal "${proposalId}"`);
      const updated: Proposal = { ...current, status: decision === "approved" ? "approved" : "rejected", updatedAt: new Date().toISOString() };
      proposals = proposals.map((entry) => (entry.id === proposalId ? updated : entry));
      return settle(updated, 360);
    },

    async answerClarification(_projectId, clarificationId, answerText, _modelId): Promise<Clarification> {
      const current = clarifications.find((entry) => entry.id === clarificationId);
      if (!current) throw new Error(`Unknown clarification "${clarificationId}"`);
      const updated: Clarification = { ...current, status: "answered", answerText, answeredAt: new Date().toISOString() };
      clarifications = clarifications.map((entry) => (entry.id === clarificationId ? updated : entry));
      return settle(updated, 300);
    },

    async cancelBackgroundJob(jobId): Promise<BackgroundJob> {
      if (backgroundJob.id !== jobId) throw new Error(`Unknown background job "${jobId}"`);
      backgroundJob = { ...backgroundJob, status: "cancelling", cancelRequestedAt: new Date().toISOString() };
      return settle(backgroundJob, 200);
    },

    async archiveMemory(_projectId, memoryId, status, reason): Promise<MemoryRecord> {
      const current = memoryRecords.find((entry) => entry.id === memoryId);
      if (!current) throw new Error(`Unknown memory record "${memoryId}"`);
      if (current.status !== "active") throw new Error(`Memory "${memoryId}" is already ${current.status} -- a lifecycle transition applies once.`);
      const updated: MemoryRecord = {
        ...current,
        status,
        updatedAt: new Date().toISOString(),
        metadata: reason ? { ...current.metadata, archiveReason: reason } : current.metadata
      };
      memoryRecords = memoryRecords.map((entry) => (entry.id === memoryId ? updated : entry));
      return settle(updated, 240);
    },

    async generateCandidates(): Promise<{ generatedCount: number; failedCount: number }> {
      // No live model connection exists for the offline demo -- there is
      // no honest way to "generate" a design alternative without one.
      // Unreachable in practice: the UI only offers this action when
      // `isRealProject` is true.
      throw new Error("Generating candidate designs requires a real backend connection -- not available for the offline demo.");
    }
  };
}
