import type {
  BuildResult, Clarification, Proposal } from "@naqsh/schemas";
import {
  apiGetBuildResults,
  ApiError,
  apiAnalyzeFrame,
  apiAnswerClarification,
  apiApproveProposal,
  apiCancelJob,
  apiConnectEnvironment,
  apiGenerateCandidates,
  apiGetActivity,
  apiGetCandidates,
  apiGetChecks,
  apiGetClarifications,
  apiGetDesignSpecifications,
  apiGetEnvironment,
  apiGetJob,
  apiGetJobs,
  apiArchiveMemory,
  apiGetMemory,
  apiGetObjectiveSatisfactionResults,
  apiGetPlans,
  apiGetProject,
  apiGetProposalsForProject,
  apiGetVerificationResults,
  apiListProjectFiles,
  apiListProjects,
  apiRejectProposal
} from "../api/client.js";
import type { AgentEvent, EnvironmentStatus, NaqshDataSource, ProjectFile, ProjectSnapshot, ProjectSummary } from "./NaqshDataSource.js";

/** How many of a project's most recent background jobs to fetch full
 * `JobEvent` histories for, when composing a `ProjectSnapshot` -- there is
 * no "all events for every job" endpoint, and fanning out to every job a
 * long-lived project has ever run would be unbounded. A view that needs a
 * SPECIFIC job's full history should call `apiGetJob` directly instead of
 * relying on this snapshot's `jobEvents`. */
const MAX_JOBS_WITH_EVENTS = 5;

/**
 * Phase B's real implementation of `NaqshDataSource` -- composes a
 * `ProjectSnapshot` entirely from `apps/api`'s real HTTP routes (via
 * `api/client.ts`), never from `demoProject.ts`.
 *
 * `candidates`/`designSpecifications`, `clarifications`, and
 * `objectiveSatisfaction` are all REAL: `generateDesignSpecification`
 * (P20), the whole P19 clarification pipeline (`ClarificationStore` +
 * `analyze_requirement_completeness`/`answer_clarification`/
 * `dismiss_clarification`), and `ObjectiveSatisfactionStore` (P17) were
 * each fully built and tested in `@naqsh/core` but left either unwired
 * into a live project or unexposed over HTTP -- all three are now wired
 * end to end and listed/actionable here for real. `objectiveSatisfaction`
 * is the MOST RECENT result for this project (by `evaluatedAt`), matching
 * `mostRecentPlan`'s identical "the snapshot shows the latest one, a
 * caller wanting full history calls the list endpoint directly" precedent
 * -- `null` only when no proposal execution has ever evaluated the
 * objective yet.
 */
export function createHttpDataSource(): NaqshDataSource {
  return {
    async getEnvironmentStatus(projectId?: string): Promise<EnvironmentStatus> {
      if (!projectId) {
        return { kind: "unknown", name: "No project selected", status: "disconnected", capabilities: [], documentName: null };
      }
      const env = await apiGetEnvironment(projectId);
      return { kind: env.kind, name: env.name, status: env.status, capabilities: env.capabilities, documentName: env.documentName };
    },

    async connectEnvironment(projectId: string): Promise<void> {
      await apiConnectEnvironment(projectId);
    },

    async analyzeFrame(projectId: string, imageDataUrl: string, question: string, modelId: string): Promise<string> {
      const { text } = await apiAnalyzeFrame(projectId, imageDataUrl, question, modelId);
      return text;
    },

    async archiveMemory(projectId: string, memoryId: string, status: "archived" | "rejected", reason?: string) {
      return apiArchiveMemory(projectId, memoryId, status, reason);
    },

    async listProjects(): Promise<ProjectSummary[]> {
      const projects = await apiListProjects();
      return projects.map((p) => ({ id: p.id, name: p.name, version: p.version, createdAt: p.createdAt }));
    },

    async getProjectSnapshot(projectId: string): Promise<ProjectSnapshot> {
      const [record, plans, proposalEntries, checks, verificationResults, memoryRecords, backgroundJobs, fileRecords, candidates, designSpecifications, clarifications, objectiveSatisfactionResults, buildResults] =
        await Promise.all([
          apiGetProject(projectId),
          apiGetPlans(projectId),
          apiGetProposalsForProject(projectId),
          apiGetChecks(projectId),
          apiGetVerificationResults(projectId),
          apiGetMemory(projectId),
          apiGetJobs(projectId),
          apiListProjectFiles(projectId),
          apiGetCandidates(projectId),
          apiGetDesignSpecifications(projectId),
          apiGetClarifications(projectId),
          apiGetObjectiveSatisfactionResults(projectId),
          // Supplementary, and deliberately fault-tolerant: build results
          // explain a failure but are not required to render the
          // workspace. Inside Promise.all a single rejection would fail
          // the ENTIRE snapshot -- so an API server without this route
          // (or a transient error on it) would black out every tab
          // rather than degrade one panel. Failing soft to [] is honest
          // here: the UI then shows no failures because it genuinely
          // could not read any, and every other panel still works.
          apiGetBuildResults(projectId).catch(() => [] as BuildResult[])
        ]);
      const files: ProjectFile[] = fileRecords.map((f) => ({
        id: f.id,
        filename: f.filename,
        mimeType: f.mimeType,
        size: f.size,
        createdAt: f.createdAt,
        extractionStatus: f.extractionStatus,
        extractionError: f.extractionError
      }));

      const jobsToFetchEvents = backgroundJobs.slice(0, MAX_JOBS_WITH_EVENTS);
      const jobEventLists = await Promise.all(jobsToFetchEvents.map((job) => apiGetJob(projectId, job.id).then((detail) => detail.events)));

      const project = record.worldModelState.project;
      const mostRecentPlan = plans.length > 0 ? [...plans].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]! : null;
      const mostRecentObjectiveSatisfaction =
        objectiveSatisfactionResults.length > 0 ? [...objectiveSatisfactionResults].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0]! : null;

      return {
        project: { id: record.id, name: record.name, version: project.version, createdAt: record.createdAt },
        requirements: project.requirements,
        constraints: project.constraints,
        clarifications,
        objects: project.objects,
        plan: mostRecentPlan,
        sources: project.sources,
        evidence: project.researchEvidence,
        candidates,
        designSpecifications,
        checks,
        verificationResults,
        experiments: project.experiments,
        objectiveSatisfaction: mostRecentObjectiveSatisfaction,
        proposals: proposalEntries.map((entry) => entry.proposal),
        decisions: project.decisions,
        memoryRecords,
        buildResults,
        backgroundJobs,
        jobEvents: jobEventLists.flat(),
        files
      };
    },

    async getAgentEvents(projectId: string): Promise<AgentEvent[]> {
      const activity = await apiGetActivity(projectId);
      return activity.map((event) => ({ id: event.id, kind: event.kind as AgentEvent["kind"], title: event.title, body: event.body, createdAt: event.createdAt }));
    },

    async decideProposal(proposalId: string, decision: "approved" | "rejected"): Promise<Proposal> {
      const outcome = decision === "approved" ? await apiApproveProposal(proposalId) : await apiRejectProposal(proposalId);
      return outcome.proposal;
    },

    async answerClarification(projectId: string, clarificationId: string, answerText: string, modelId: string): Promise<Clarification> {
      const result = await apiAnswerClarification(projectId, clarificationId, answerText, modelId);
      return result.clarification;
    },

    async cancelBackgroundJob(jobId: string, projectId?: string) {
      if (!projectId) {
        throw new ApiError("invalid_input", "cancelBackgroundJob requires a projectId against the real backend.");
      }
      return apiCancelJob(projectId, jobId);
    },

    async generateCandidates(projectId: string, planId: string, planStepId: string, count: number, modelId: string) {
      const outcome = await apiGenerateCandidates(projectId, planId, planStepId, count, modelId);
      return { generatedCount: outcome.candidates.length, failedCount: outcome.failures.length };
    }
  };
}
