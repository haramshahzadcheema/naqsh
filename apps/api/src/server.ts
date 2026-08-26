import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import cors from "cors";
import multer from "multer";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createId, AuthorizationError, type Approval } from "@naqsh/schemas";
import { initializeWorldModel } from "@naqsh/core";
import {
  createConversationRepository,
  createFileRepository,
  createMessageRepository,
  createProjectRepository,
  createRuntimeStateRepository,
  DEFAULT_ENVIRONMENT_KIND,
  ENVIRONMENT_KINDS,
  type ConversationRecord,
  type EnvironmentKind,
  type FileRecord,
  type MessageRecord,
  type ProjectRecord
} from "./db/repositories.js";
import {
  answerClarification,
  captureRequirementFromStatement,
  discardProjectRuntime,
  dismissClarification,
  ensureEnvironmentSession,
  findProjectIdForProposal,
  getOrCreateProjectRuntime,
  persistRuntimeState,
  setMaxCachedRuntimes
} from "./projectRuntime.js";
import { resolveModelProvider, isGeminiConfigured, getModelCatalog, DETERMINISTIC_MODEL_ID, type ModelUnavailableReason } from "./modelProviderFactory.js";
import { discoverFreecad } from "./environmentDiscovery.js";
import { createMockCadEnvironment, createMockSimulationEnvironment } from "@naqsh/adapters";
import { type AiStyle } from "./chatReply.js";
import { analyzeFrame } from "./frameAnalysis.js";
import { processFile } from "./fileProcessing.js";
import {
  approveProposal,
  executeProposal,
  generateProjectCandidates,
  generateProjectPlan,
  generateProjectProposal,
  observeCurrentProject,
  rejectProposal,
  rollbackToCheckpoint,
  verifyExistingCheck
} from "./engineeringWorkflow.js";
import { sendChatMessage, regenerateChatReply } from "./chatWorkflow.js";
import { acceptResearchSource, addMemoryRecord, addResearchEvidence, fetchResearchLocator } from "./researchWorkflow.js";
import { cancelBackgroundJob, getBackgroundJob, listBackgroundJobs, submitBackgroundJob } from "./jobsWorkflow.js";
import { getAuthContext, type AuthContext } from "./auth.js";
import { createRateLimiter } from "./rateLimit.js";
import { writeErrorResponse } from "./httpErrors.js";
import { resolveCorsConfig, resolveEnvironment } from "./config.js";
import { errorMeta, logger } from "./logger.js";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB -- Phase V: limit file size.
const MAX_MESSAGE_CHARS = 8_000; // Phase V: limit request body size for a single chat message.
// A real, bounded cost/abuse control: each unit of `count` is a genuine
// Gemini call (generateDesignSpecification), not a cheap loop iteration --
// unlike MAX_MESSAGE_CHARS/MAX_UPLOAD_BYTES this bounds the number of
// UPSTREAM model calls one request can trigger, not the request's own size.
const MAX_CANDIDATE_GENERATION_COUNT = 6;
const VALID_STYLES: AiStyle[] = ["balanced", "concise", "detailed", "technical", "creative"];

// `Promise<unknown>`, not `Promise<void>`: several handlers below use
// `return res.status(x).json(y)` as a terse early-exit -- the returned
// `Response` value is never used (only `.catch(next)` matters here), so
// there's no reason to force every handler body into a two-statement
// "call res.json(), then a bare return" just to satisfy a stricter type.
function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** Express types route params as `{ [key: string]: string }`, which under
 * this repo's `noUncheckedIndexedAccess` widens every access to
 * `string | undefined`. In practice a param is always present when its
 * route pattern matched (that's how Express routing works) -- this just
 * makes that guarantee visible to the type checker instead of scattering
 * `?? ""` everywhere. */
function param(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === "string" ? value : "";
}

function notFound(res: Response, message: string): void {
  res.status(404).json({ error: { kind: "not_found", message } });
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { kind: "invalid_input", message } });
}

function modelUnavailable(res: Response, reason: ModelUnavailableReason): void {
  res.status(503).json({ error: { kind: reason, message: describeModelUnavailable(reason) } });
}

function sanitizeModelId(raw: unknown): string {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : DETERMINISTIC_MODEL_ID;
}

function sanitizeStyle(raw: unknown): AiStyle {
  return typeof raw === "string" && (VALID_STYLES as string[]).includes(raw) ? (raw as AiStyle) : "balanced";
}

/** Part 30's "strict project isolation": a project is only ever visible to
 * the auth identity that owns it. Deliberately returns the SAME "not
 * found" shape for "doesn't exist" and "exists but belongs to someone
 * else" -- never leaking existence to an unauthorized caller (the
 * "safe error messages" requirement). */
function isOwnedProject(record: ProjectRecord | null, auth: AuthContext): ProjectRecord | null {
  return record && record.ownerId === auth.userId ? record : null;
}

export interface CreateServerOptions {
  dataDir: string;
  /** Overridable only for tests -- production always gets the default
   * (240 req/min per identity/IP). Exposed here rather than hardcoded so a
   * test can exercise the 429 path without firing 240+ real requests. */
  rateLimit?: { windowMs: number; maxRequests: number };
  /** The SECOND, deliberately tighter budget applied on top of the global
   * one, to exactly those routes whose handlers invoke a real model
   * provider (or fetch a real external URL). The global limit protects the
   * SERVER; this one protects the API BILL and the upstream provider's own
   * quota -- 240 chat/plan/candidate requests a minute is well within the
   * global budget while being enough real Gemini traffic to matter,
   * and `/plans/:planId/candidates` plus `/jobs` each fan out to MANY
   * model calls per single HTTP request, so the per-request cost is not
   * uniform. Same override-for-tests rationale as `rateLimit`. */
  modelRateLimit?: { windowMs: number; maxRequests: number };
  /** How many projects' full in-memory runtimes this process caches at
   * once before evicting the least-recently-used one (see
   * `projectRuntime.ts`'s `setMaxCachedRuntimes` for why this is safe).
   * Defaults to 500 -- generous enough that no existing test suite trips
   * it, small enough to keep this process's memory bounded regardless of
   * how many distinct projects it's asked about over its lifetime. */
  maxCachedRuntimes?: number;
}

export function createServer(options: CreateServerOptions) {
  const dataDir = options.dataDir;
  const uploadsDir = join(dataDir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  if (options.maxCachedRuntimes !== undefined) setMaxCachedRuntimes(options.maxCachedRuntimes);

  const projects = createProjectRepository(dataDir);
  const conversations = createConversationRepository(dataDir);
  const messages = createMessageRepository(dataDir);
  const files = createFileRepository(dataDir);
  const runtimeStates = createRuntimeStateRepository(dataDir);

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 } });

  /** Resolves `:projectId` from the route, enforcing ownership -- writes a
   * 404 itself and returns null on any failure, so every call site is just
   * `const record = getOwnedProject(req, res); if (!record) return;`.
   * Also stashes the resolved id on `res.locals` -- the ONE thing the
   * post-response runtime-state persistence hook (below) needs to know
   * which project's runtime might have just changed, without threading a
   * projectId through every individual route handler. */
  function getOwnedProject(req: Request, res: Response): ProjectRecord | null {
    const projectId = param(req, "projectId");
    const record = isOwnedProject(projects.get(projectId), getAuthContext(req));
    if (!record) {
      notFound(res, `No project with id "${projectId}"`);
      return null;
    }
    res.locals.naqshProjectId = record.id;
    return record;
  }

  /** Same ownership enforcement for the `/proposals/:proposalId/*` routes,
   * which don't carry a projectId in their URL -- resolves through
   * `findProjectIdForProposal`'s cross-project-safe index first. */
  function getOwnedProjectForProposal(req: Request, res: Response, proposalId: string): ProjectRecord | null {
    const projectId = findProjectIdForProposal(proposalId);
    const record = projectId ? isOwnedProject(projects.get(projectId), getAuthContext(req)) : null;
    if (!record) {
      notFound(res, `No proposal with id "${proposalId}"`);
      return null;
    }
    res.locals.naqshProjectId = record.id;
    return record;
  }

  const app = express();

  // Every request gets a real, unique id -- carried through the response
  // header (a client/proxy can correlate its own logs against this
  // server's) and into every log line this request produces (including
  // the runtime-state persistence failure log below). Registered before
  // anything else so even a request that fails CORS/JSON-parsing/rate-
  // limiting still gets one real logged line, never silence.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = createId("req");
    res.locals.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    const startedAt = Date.now();
    res.on("finish", () => {
      logger.info("request", {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        projectId: res.locals.naqshProjectId as string | undefined
      });
    });
    next();
  });

  // NAQSH_ALLOWED_ORIGIN, when set, restricts CORS to that comma-separated
  // origin allowlist. Permissive by default in development/test (matching
  // this phase's "local development identity" scope, see auth.ts) -- but
  // `resolveCorsConfig` THROWS here, before the server ever binds a port,
  // if NODE_ENV=production and no allowlist was configured. A production
  // deployment does not get to silently fall back to "answer every
  // origin" just because someone forgot to set the environment variable.
  const { allowedOrigins } = resolveCorsConfig(resolveEnvironment(process.env.NODE_ENV), process.env.NAQSH_ALLOWED_ORIGIN);
  app.use(cors(allowedOrigins ? { origin: allowedOrigins } : {}));
  // 10mb, not 1mb: P22's frame-analysis route accepts one base64-encoded
  // captured frame per request. The real bound is enforced downstream at
  // the schema layer regardless (`assertModelAttachment` caps
  // `dataBase64` at 8,000,000 characters, ~6MB decoded) -- this is just
  // body-parser's own outer limit, raised enough to let that through.
  app.use(express.json({ limit: "10mb" }));
  // Part 30: rate limits. Generous enough for normal chat/engineering-
  // workflow use (many small requests per user action), bounded enough to
  // stop a runaway client/script from hammering the server.
  app.use(createRateLimiter(options.rateLimit ?? { windowMs: 60_000, maxRequests: 240 }));

  // The tighter, model-facing budget (see `modelRateLimit`'s doc comment).
  // Mounted per-path rather than globally so a burst of cheap reads
  // (polling /projects/:id/activity while a job runs, loading every tab's
  // data on project switch) can never consume the budget that exists to
  // protect real Gemini spend. Express matches these prefixes before the
  // route handlers registered further down, and a request that trips this
  // limiter never reaches its handler -- so no model call, and no partial
  // World Model mutation, happens for a rejected request.
  const modelLimiter = createRateLimiter(options.modelRateLimit ?? { windowMs: 60_000, maxRequests: 40 });
  for (const modelRoute of [
    "/projects/:projectId/plans",
    "/projects/:projectId/plans/:planId/proposals",
    "/projects/:projectId/plans/:planId/candidates",
    "/projects/:projectId/requirements",
    "/projects/:projectId/research/fetch",
    "/projects/:projectId/environment/frame-analysis",
    "/projects/:projectId/jobs",
    "/conversations/:conversationId/messages",
    "/conversations/:conversationId/messages/stream",
    "/conversations/:conversationId/messages/:messageId/regenerate"
  ]) {
    app.post(modelRoute, modelLimiter);
  }

  // Persists a project's live runtime state (plans, proposals, approvals,
  // checkpoints, verification results, memory, activity, experiments,
  // background jobs -- everything `ProjectRuntime` holds beyond
  // `WorldModelState`, which already persists through `setState`) after
  // any request that resolved a project AND could plausibly have mutated
  // it. Registered once, globally, rather than threaded through every
  // individual route handler: `getOwnedProject`/`getOwnedProjectForProposal`/
  // `getOwnedConversation` already stash the resolved project id on
  // `res.locals.naqshProjectId` for exactly this purpose. `res.on("finish")`
  // fires after the response is actually sent, so this never adds latency
  // to the request itself; a failure here is logged, never thrown back at
  // the client for a request that already succeeded.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on("finish", () => {
      if (req.method === "GET") return; // never mutates -- nothing to persist.
      const projectId = res.locals.naqshProjectId as string | undefined;
      if (!projectId) return;
      try {
        persistRuntimeState(projectId, runtimeStates);
      } catch (error) {
        logger.error("runtime_state_persist_failed", { requestId: res.locals.requestId as string | undefined, projectId, method: req.method, path: req.path, ...errorMeta(error) });
      }
    });
    next();
  });

  // ---- Health --------------------------------------------------------------
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", geminiConfigured: isGeminiConfigured() });
  });

  // ---- Model catalog ---------------------------------------------------------
  app.get("/models", (_req, res) => {
    res.json(getModelCatalog());
  });

  // ---- Projects --------------------------------------------------------------
  app.get(
    "/projects",
    asyncHandler(async (req, res) => {
      const auth = getAuthContext(req);
      res.json(projects.listByOwner(auth.userId).map(summarizeProject));
    })
  );

  app.post(
    "/projects",
    asyncHandler(async (req, res) => {
      const auth = getAuthContext(req);
      const name = typeof req.body?.name === "string" && req.body.name.trim().length > 0 ? req.body.name.trim().slice(0, 200) : "Untitled project";
      const description = typeof req.body?.description === "string" ? req.body.description.slice(0, 2000) : "";
      const requestedEnvironmentKind = req.body?.environmentKind;
      if (requestedEnvironmentKind !== undefined && !ENVIRONMENT_KINDS.includes(requestedEnvironmentKind)) {
        return badRequest(res, `environmentKind must be one of ${ENVIRONMENT_KINDS.join(", ")}`);
      }
      const environmentKind: EnvironmentKind = requestedEnvironmentKind ?? DEFAULT_ENVIRONMENT_KIND;

      let documentPath: string | undefined;
      if (environmentKind === "freecad") {
        // A FreeCAD-backed project has no "current file" concept to fall
        // back on (each call is a fresh subprocess against ONE named
        // document) -- require the real path up front, never silently
        // proceed with nothing to connect to.
        if (typeof req.body?.documentPath !== "string" || req.body.documentPath.trim().length === 0) {
          return badRequest(res, "documentPath is required when environmentKind is \"freecad\" -- the absolute path to a .FCStd file on the machine running the Naqsh server.");
        }
        const requestedDocumentPath: string = req.body.documentPath.trim();
        if (!existsSync(requestedDocumentPath)) {
          return badRequest(res, `No file exists at documentPath "${requestedDocumentPath}".`);
        }
        documentPath = requestedDocumentPath;
        // Never take "FreeCAD is selectable" as "FreeCAD is HERE" -- the
        // same real, bounded health check the Environment Center itself
        // uses, not a weaker "trust the client" shortcut for this one path.
        const availability = await discoverFreecad();
        if (availability.status !== "connectable") {
          return res.status(503).json({ error: { kind: "environment_unavailable", message: availability.reason ?? "FreeCAD is not available on this server." } });
        }
      }

      const worldModelState = initializeWorldModel({ name, description, objective: { summary: description || name } });
      const now = new Date().toISOString();
      const record: ProjectRecord = { id: worldModelState.project.id, name, ownerId: auth.userId, environmentKind, documentPath, createdAt: now, updatedAt: now, worldModelState };
      projects.save(record);
      res.status(201).json(summarizeProject(record));
    })
  );

  app.get(
    "/projects/:projectId",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      res.json(record);
    })
  );

  app.post(
    "/projects/:projectId/observe",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(observeCurrentProject(runtime));
    })
  );

  // ---- Engineering workflow: observe -> plan -> propose -> approve ->
  // execute -> verify -> report (see engineeringWorkflow.ts). ----------------
  app.post(
    "/projects/:projectId/plans",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const resolved = resolveModelProvider(sanitizeModelId(req.body?.modelId));
      if ("error" in resolved) return modelUnavailable(res, resolved.error.reason);
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const outcome = await generateProjectPlan(runtime, resolved.provider, { modelId: resolved.modelId });
      if (outcome.status === "error") return res.status(422).json({ error: outcome.error });
      res.status(201).json(outcome.plan);
    })
  );

  app.get(
    "/projects/:projectId/plans/:planId",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const plan = runtime.plans.get(param(req, "planId"));
      if (!plan) return notFound(res, `No plan with id "${param(req, "planId")}"`);
      res.json(plan);
    })
  );

  app.post(
    "/projects/:projectId/plans/:planId/proposals",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const resolved = resolveModelProvider(sanitizeModelId(req.body?.modelId));
      if ("error" in resolved) return modelUnavailable(res, resolved.error.reason);
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const planStepId = typeof req.body?.planStepId === "string" ? req.body.planStepId : undefined;
      const outcome = await generateProjectProposal(runtime, resolved.provider, param(req, "planId"), { modelId: resolved.modelId }, planStepId);
      if (outcome.status === "error") return res.status(422).json({ error: outcome.error });
      res.status(201).json({ proposal: outcome.proposal, approvalId: outcome.approvalId });
    })
  );

  app.get(
    "/projects/:projectId/proposals",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(Array.from(runtime.proposals.values()).map((tracked) => ({ proposal: tracked.proposal, approvalId: tracked.approvalId, approval: runtime.approvals.getById(tracked.approvalId) })));
    })
  );

  /** Generates N genuinely alternative candidate designs for one plan
   * step -- real Gemini calls through `generateDesignSpecification`
   * (P20), each saved and turned into a real `Candidate`
   * (`generateProjectCandidates`, engineeringWorkflow.ts). Best-effort:
   * a 201 with `failures` populated means SOME variations succeeded and
   * some didn't; a 422 means none did. Never silently returns fewer
   * candidates than were generated without saying so. */
  app.post(
    "/projects/:projectId/plans/:planId/candidates",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const planStepId = typeof req.body?.planStepId === "string" ? req.body.planStepId : "";
      if (!planStepId.trim()) return badRequest(res, "planStepId is required");
      const rawCount = typeof req.body?.count === "number" ? Math.trunc(req.body.count) : 1;
      const count = Math.min(Math.max(rawCount, 1), MAX_CANDIDATE_GENERATION_COUNT);
      const resolved = resolveModelProvider(sanitizeModelId(req.body?.modelId));
      if ("error" in resolved) return modelUnavailable(res, resolved.error.reason);
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const outcome = await generateProjectCandidates(runtime, resolved.provider, param(req, "planId"), planStepId, count, { modelId: resolved.modelId });
      if (outcome.status === "error") return res.status(422).json({ error: outcome.error });
      res.status(201).json({ candidates: outcome.candidates, failures: outcome.failures });
    })
  );

  app.get(
    "/projects/:projectId/candidates",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(runtime.candidateStore.list());
    })
  );

  /**
   * Real build results for the project.
   *
   * AUDIT FIX: these were persisted by `projectRuntime` from the very
   * beginning but exposed through NO endpoint, so a failed build was
   * completely invisible in the UI. Reproduced live: three consecutive
   * candidate builds failed with `"freecad" does not support "create"`
   * and the workspace showed nothing at all -- no error, no badge, no
   * activity entry the user could act on. The whole exploration simply
   * appeared to do nothing.
   */
  app.get(
    "/projects/:projectId/build-results",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(runtime.buildResultStore.list());
    })
  );

  app.get(
    "/projects/:projectId/design-specifications",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(runtime.designSpecificationStore.list());
    })
  );

  app.get(
    "/projects/:projectId/proposals/:proposalId",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const tracked = runtime.proposals.get(param(req, "proposalId"));
      if (!tracked) return notFound(res, `No proposal with id "${param(req, "proposalId")}"`);
      res.json({ proposal: tracked.proposal, approvalId: tracked.approvalId, approval: runtime.approvals.getById(tracked.approvalId) });
    })
  );

  app.post(
    "/proposals/:proposalId/approve",
    asyncHandler(async (req, res) => {
      const proposalId = param(req, "proposalId");
      const record = getOwnedProjectForProposal(req, res, proposalId);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
      const outcome = approveProposal(runtime, proposalId, reason);
      if (outcome.status === "error") return res.status(409).json({ error: outcome.error });
      res.json({ proposal: outcome.proposal, approval: outcome.approval });
    })
  );

  app.post(
    "/proposals/:proposalId/reject",
    asyncHandler(async (req, res) => {
      const proposalId = param(req, "proposalId");
      const record = getOwnedProjectForProposal(req, res, proposalId);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
      const outcome = rejectProposal(runtime, proposalId, reason);
      if (outcome.status === "error") return res.status(409).json({ error: outcome.error });
      res.json({ proposal: outcome.proposal, approval: outcome.approval });
    })
  );

  app.post(
    "/proposals/:proposalId/execute",
    asyncHandler(async (req, res) => {
      const proposalId = param(req, "proposalId");
      const record = getOwnedProjectForProposal(req, res, proposalId);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const outcome = await executeProposal(runtime, proposalId);
      if (outcome.status === "error") return res.status(409).json({ error: outcome.error });
      res.json(outcome.report);
    })
  );

  app.post(
    "/projects/:projectId/verify",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const checkId = typeof req.body?.checkId === "string" ? req.body.checkId : "";
      if (!checkId) return badRequest(res, "checkId is required");
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const outcome = await verifyExistingCheck(runtime, checkId);
      if (outcome.status === "error") return res.status(422).json({ error: outcome.error });
      res.json(outcome.result);
    })
  );

  app.post(
    "/projects/:projectId/rollback",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const checkpointId = typeof req.body?.checkpointId === "string" ? req.body.checkpointId : "";
      if (!checkpointId) return badRequest(res, "checkpointId is required");
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const outcome = await rollbackToCheckpoint(runtime, checkpointId, reason);
      if (outcome.status === "error") return res.status(409).json({ error: outcome.error });
      res.json({ mismatchDetected: outcome.mismatchDetected, warnings: outcome.warnings });
    })
  );

  app.get(
    "/projects/:projectId/requirements",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      res.json(record.worldModelState.project.requirements);
    })
  );

  app.post(
    "/projects/:projectId/requirements",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const statementText = typeof req.body?.statementText === "string" ? req.body.statementText.slice(0, MAX_MESSAGE_CHARS) : "";
      if (!statementText.trim()) return badRequest(res, "statementText is required");

      const modelId = sanitizeModelId(req.body?.modelId);
      const resolved = resolveModelProvider(modelId);
      if ("error" in resolved) return modelUnavailable(res, resolved.error.reason);

      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const outcome = await captureRequirementFromStatement(runtime, resolved.provider, statementText, { modelId: resolved.modelId });
      res.json(outcome);
    })
  );

  app.get(
    "/projects/:projectId/clarifications",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(runtime.clarificationStore.list());
    })
  );

  app.post(
    "/projects/:projectId/clarifications/:clarificationId/answer",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const clarificationId = param(req, "clarificationId");
      const answerText = typeof req.body?.answerText === "string" ? req.body.answerText.slice(0, MAX_MESSAGE_CHARS) : "";
      if (!answerText.trim()) return badRequest(res, "answerText is required");

      const modelId = sanitizeModelId(req.body?.modelId);
      const resolved = resolveModelProvider(modelId);
      if ("error" in resolved) return modelUnavailable(res, resolved.error.reason);

      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      if (!runtime.clarificationStore.getById(clarificationId)) return res.status(404).json({ error: { kind: "not_found", message: `No clarification with id "${clarificationId}" exists.` } });

      const outcome = await answerClarification(runtime, resolved.provider, clarificationId, answerText, resolved.modelId);
      if (outcome.kind === "answer_rejected") return res.status(422).json({ error: { kind: "invalid_input", message: outcome.message } });
      res.json(outcome);
    })
  );

  app.post(
    "/projects/:projectId/clarifications/:clarificationId/dismiss",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const clarificationId = param(req, "clarificationId");
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;

      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      if (!runtime.clarificationStore.getById(clarificationId)) return res.status(404).json({ error: { kind: "not_found", message: `No clarification with id "${clarificationId}" exists.` } });

      const outcome = await dismissClarification(runtime, clarificationId, reason);
      if (outcome.status === "error") return res.status(422).json({ error: { kind: "invalid_input", message: outcome.message } });
      res.json({ clarification: outcome.clarification });
    })
  );

  app.get(
    "/projects/:projectId/research",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      res.json({ sources: record.worldModelState.project.sources, evidence: record.worldModelState.project.researchEvidence });
    })
  );

  app.post(
    "/projects/:projectId/research/fetch",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const locator = typeof req.body?.locator === "string" ? req.body.locator : "";
      if (!locator.trim()) return badRequest(res, "locator is required");
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const outcome = await fetchResearchLocator(runtime, locator);
      if (outcome.status === "error") return res.status(422).json({ error: outcome.error });
      res.json(outcome.content);
    })
  );

  app.post(
    "/projects/:projectId/research/sources",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const title = typeof req.body?.title === "string" ? req.body.title : "";
      const sourceType = typeof req.body?.sourceType === "string" ? req.body.sourceType : "";
      if (!title.trim() || !sourceType.trim()) return badRequest(res, "title and sourceType are required");
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const outcome = await acceptResearchSource(runtime, {
        locator: typeof req.body?.locator === "string" ? req.body.locator : null,
        title,
        publisher: typeof req.body?.publisher === "string" ? req.body.publisher : null,
        sourceType: sourceType as never,
        publishedAt: typeof req.body?.publishedAt === "string" ? req.body.publishedAt : null,
        contentHash: typeof req.body?.contentHash === "string" ? req.body.contentHash : null,
        provenance: req.body?.provenance === "human" ? "human" : "research"
      });
      if (outcome.status === "error") return res.status(422).json({ error: outcome.error });
      res.status(201).json(outcome.source);
    })
  );

  app.post(
    "/projects/:projectId/research/evidence",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const sourceId = typeof req.body?.sourceId === "string" ? req.body.sourceId : "";
      const claim = typeof req.body?.claim === "string" ? req.body.claim : "";
      if (!sourceId.trim() || !claim.trim()) return badRequest(res, "sourceId and claim are required");
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const outcome = await addResearchEvidence(runtime, {
        sourceId,
        claim,
        excerpt: typeof req.body?.excerpt === "string" ? req.body.excerpt : null,
        confidence: typeof req.body?.confidence === "string" ? req.body.confidence : null,
        relevanceNote: typeof req.body?.relevanceNote === "string" ? req.body.relevanceNote : null,
        provenance: req.body?.provenance === "human" ? "human" : "research"
      });
      if (outcome.status === "error") return res.status(422).json({ error: outcome.error });
      res.status(201).json(outcome.evidence);
    })
  );

  app.get(
    "/projects/:projectId/plans",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(Array.from(runtime.plans.values()));
    })
  );

  app.get(
    "/projects/:projectId/checks",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(runtime.checkStore.list());
    })
  );

  app.get(
    "/projects/:projectId/verification-results",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(runtime.verificationResultStore.listForProject(record.id));
    })
  );

  app.get(
    "/projects/:projectId/objective-satisfaction",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(runtime.objectiveSatisfactionStore.listForProject(record.id));
    })
  );

  app.get(
    "/projects/:projectId/environment",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const descriptor = runtime.environmentAdapter.describe();
      const session = runtime.getSession();
      res.json({
        kind: runtime.environmentKind,
        name: descriptor.name,
        capabilities: descriptor.capabilities,
        status: session?.status === "connected" ? "connected" : "disconnected",
        // Real data that already existed on the session object (see the
        // POST .../connect route just below, which returns the exact same
        // field) -- previously computed here and then left out of the
        // response entirely. Null, not omitted, when there is no live
        // session, so the frontend can distinguish "connected but no
        // document" from "field doesn't exist."
        documentName: session?.documentName ?? null
      });
    })
  );

  // A real, explicit "Connect" action -- every other route that needs a
  // live session gets one lazily and implicitly (never eagerly at project
  // creation, see `ensureEnvironmentSession`'s own doc comment); this
  // route exists so the Environment Center can show a genuine connection
  // moment on demand rather than the user's first real action silently
  // paying that cost. Calls the SAME function, reuses the SAME session
  // cache -- a project already connected via some other route simply
  // returns its existing session here, never a duplicate.
  app.post(
    "/projects/:projectId/environment/connect",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      try {
        const session = await ensureEnvironmentSession(runtime);
        res.json({ status: "connected", session: { id: session.id, documentName: session.documentName, openedAt: session.openedAt } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(503).json({ error: { kind: "environment_unavailable", message } });
      }
    })
  );

  // P22: the desktop app's live-view capture, made useful -- ONE captured
  // frame (never a continuous feed, never anything the browser sends on
  // its own) + a question, answered by the SAME `ModelProvider` boundary
  // every other AI-backed route already goes through (`resolveModelProvider`,
  // real Gemini or the deterministic mock, never a bespoke second path).
  // Project-scoped for consistent ownership/auth (`getOwnedProject`), even
  // though the image itself carries no project data -- keeps this route
  // inside the same access-control boundary as everything else here.
  app.post(
    "/projects/:projectId/environment/frame-analysis",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const imageDataUrl = req.body?.imageDataUrl;
      if (typeof imageDataUrl !== "string" || imageDataUrl.length === 0) {
        return badRequest(res, "imageDataUrl is required.");
      }
      const question = typeof req.body?.question === "string" ? req.body.question : "";
      const resolved = resolveModelProvider(sanitizeModelId(req.body?.modelId));
      if ("error" in resolved) return modelUnavailable(res, resolved.error.reason);
      const outcome = await analyzeFrame(resolved.provider, { imageDataUrl, question, modelConfig: { modelId: resolved.modelId } });
      if (outcome.status === "error") {
        const status = outcome.error.kind === "invalid_input" ? 400 : 422;
        return res.status(status).json({ error: outcome.error });
      }
      res.json({ text: outcome.text });
    })
  );

  // ---- Environment Center: which engineering environments this SERVER
  // (not any one project) can genuinely reach right now. Real, bounded
  // discovery (environmentDiscovery.ts) -- never a static "supported
  // list" that claims availability without having actually checked. The
  // two mock kinds need no discovery (they're in-memory and always
  // constructible); FreeCAD's entry reflects a real health-checked
  // subprocess probe.
  app.get(
    "/environments/discover",
    asyncHandler(async (req, res) => {
      const forceRefresh = req.query.refresh === "true";
      const freecad = await discoverFreecad(forceRefresh);
      res.json({
        environments: [
          {
            kind: "mock_cad",
            name: "Mock CAD",
            status: "connectable",
            reason: null,
            resolvedCommandPath: null,
            version: null,
            checkedAt: freecad.checkedAt,
            capabilities: createMockCadEnvironment().describe().capabilities
          },
          {
            kind: "mock_simulation",
            name: "Mock Simulation",
            status: "connectable",
            reason: null,
            resolvedCommandPath: null,
            version: null,
            checkedAt: freecad.checkedAt,
            capabilities: createMockSimulationEnvironment().describe().capabilities
          },
          freecad
        ]
      });
    })
  );

  app.get(
    "/projects/:projectId/experiments",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      res.json(record.worldModelState.project.experiments);
    })
  );

  // ---- Background jobs (P25) --------------------------------------------------
  app.post(
    "/projects/:projectId/jobs",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const objective = typeof req.body?.objective === "string" ? req.body.objective : "";
      const candidateIds = Array.isArray(req.body?.candidateIds) ? req.body.candidateIds.filter((id: unknown): id is string => typeof id === "string") : [];
      const autonomyLevel = typeof req.body?.autonomyLevel === "string" ? req.body.autonomyLevel : "";
      const allowedTools = Array.isArray(req.body?.allowedTools) ? req.body.allowedTools.filter((name: unknown): name is string => typeof name === "string") : [];
      const budget = req.body?.budget;
      if (!objective.trim() || !autonomyLevel.trim() || allowedTools.length === 0 || typeof budget !== "object" || budget === null) {
        return badRequest(res, "objective, autonomyLevel, a non-empty allowedTools array, and budget are required");
      }
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const outcome = await submitBackgroundJob(
        runtime,
        { objective, candidateIds, autonomyLevel: autonomyLevel as never, allowedTools, budget, optimizationProblemId: req.body?.optimizationProblemId ?? null },
        () => persistRuntimeState(record.id, runtimeStates)
      );
      if (outcome.status === "error") return res.status(422).json({ error: outcome.error });
      res.status(202).json(outcome.job);
    })
  );

  app.get(
    "/projects/:projectId/jobs",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(listBackgroundJobs(runtime));
    })
  );

  app.get(
    "/projects/:projectId/jobs/:jobId",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const outcome = await getBackgroundJob(runtime, param(req, "jobId"));
      if (outcome.status === "error") return notFound(res, outcome.error.message);
      res.json(outcome);
    })
  );

  app.post(
    "/projects/:projectId/jobs/:jobId/cancel",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
      const outcome = await cancelBackgroundJob(runtime, param(req, "jobId"), reason);
      if (outcome.status === "error") return res.status(422).json({ error: outcome.error });
      res.json(outcome.job);
    })
  );

  // ---- Approvals (P4), generic -- not proposal-scoped. Section 5's
  // "explore alternatives" flow (prepareExploration, engineeringWorkflow.ts)
  // requests one Approval per mutate-tool a background job's candidate
  // builds will need; a human approves/rejects each one here before
  // POST /projects/:projectId/jobs can do anything real. The existing
  // /proposals/:proposalId/approve|reject routes stay -- this is a second,
  // generic surface for approvals that were never born from one specific
  // Proposal. ------------------------------------------------------------
  app.get(
    "/projects/:projectId/approvals",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(runtime.approvals.list());
    })
  );

  function decideApproval(res: Response, decide: () => Approval): void {
    try {
      res.json(decide());
    } catch (error) {
      if (error instanceof AuthorizationError && error.kind === "not_found") return notFound(res, error.message);
      const message = error instanceof Error ? error.message : String(error);
      res.status(409).json({ error: { kind: "approval_decision_failed", message } });
    }
  }

  app.post(
    "/projects/:projectId/approvals/:approvalId/approve",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
      decideApproval(res, () => runtime.approvals.approve(param(req, "approvalId"), "human", reason));
    })
  );

  app.post(
    "/projects/:projectId/approvals/:approvalId/reject",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
      decideApproval(res, () => runtime.approvals.reject(param(req, "approvalId"), "human", reason));
    })
  );

  app.get(
    "/projects/:projectId/memory",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(runtime.memory.listForProject(record.id));
    })
  );

  app.post(
    "/projects/:projectId/memory",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const kind = typeof req.body?.kind === "string" ? req.body.kind : "";
      const title = typeof req.body?.title === "string" ? req.body.title : "";
      const content = typeof req.body?.content === "string" ? req.body.content : "";
      if (!kind.trim() || !title.trim() || !content.trim()) return badRequest(res, "kind, title, and content are required");
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      const outcome = await addMemoryRecord(runtime, { kind: kind as never, title, content, references: req.body?.references ?? null });
      if (outcome.status === "error") return res.status(422).json({ error: outcome.error });
      res.status(201).json(outcome.memory);
    })
  );

  // Real, previously-unexposed backend capability (`MemoryStore.archive`,
  // @naqsh/core) -- lets the Memory view's Archive/Forget actions be
  // genuine lifecycle transitions instead of a read-only list. `status`
  // distinguishes "no longer needed" (archived) from "found incorrect"
  // (rejected) -- the same two real outcomes the store itself supports;
  // there is no "Edit" here because a memory's content is immutable once
  // created (see memory-store.ts's own doc comment) -- Section 25's "do
  // not fake a capability" rule applies to the UI too.
  app.post(
    "/projects/:projectId/memory/:memoryId/archive",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const status = req.body?.status === "rejected" ? "rejected" : "archived";
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      // `getForProject`, not `getById` + a separate `.projectId` compare:
      // the isolation check cannot be half-performed if it is the lookup
      // itself (see memory-store.ts's PROJECT ISOLATION note).
      const existing = runtime.memory.getForProject(param(req, "memoryId"), record.id);
      if (!existing) return notFound(res, `No memory record with id "${param(req, "memoryId")}" in this project`);
      try {
        const archived = runtime.memory.archive(param(req, "memoryId"), { status, reason });
        res.json(archived);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(422).json({ error: { kind: "invalid_input", message } });
      }
    })
  );

  app.get(
    "/projects/:projectId/activity",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      const runtime = getOrCreateProjectRuntime(record.id, projects, record.environmentKind, runtimeStates);
      res.json(runtime.activity);
    })
  );

  app.delete(
    "/projects/:projectId",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      projects.delete(record.id);
      discardProjectRuntime(record.id);
      runtimeStates.delete(record.id);
      for (const conversation of conversations.listForProject(record.id)) {
        for (const message of messages.listForConversation(conversation.id)) messages.delete(message.id);
        conversations.delete(conversation.id);
      }
      for (const file of files.listForProject(record.id)) {
        try {
          unlinkSync(join(dataDir, file.storedAt));
        } catch {
          // Already gone, or never wrote successfully -- the metadata
          // record is still deleted below either way; nothing left on
          // disk to leak either way.
        }
        files.delete(file.id);
      }
      res.status(204).end();
    })
  );

  // ---- Conversations ---------------------------------------------------------
  app.get(
    "/projects/:projectId/conversations",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      res.json(conversations.listForProject(record.id));
    })
  );

  app.post(
    "/conversations",
    asyncHandler(async (req, res) => {
      const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
      const record = isOwnedProject(projects.get(projectId), getAuthContext(req));
      if (!record) return badRequest(res, `projectId must reference an existing project`);
      const now = new Date().toISOString();
      const conversation: ConversationRecord = {
        id: createId("conv"),
        projectId,
        title: typeof req.body?.title === "string" && req.body.title.trim() ? req.body.title.trim().slice(0, 200) : "New conversation",
        createdAt: now,
        updatedAt: now
      };
      conversations.save(conversation);
      res.status(201).json(conversation);
    })
  );

  /** Resolves `:conversationId`, enforcing ownership THROUGH the
   * conversation's own project -- a conversation has no ownerId of its
   * own; it inherits isolation from `conversation.projectId`. */
  function getOwnedConversation(req: Request, res: Response): { conversation: ConversationRecord; project: ProjectRecord } | null {
    const conversationId = param(req, "conversationId");
    const conversation = conversations.get(conversationId);
    const project = conversation ? isOwnedProject(projects.get(conversation.projectId), getAuthContext(req)) : null;
    if (!conversation || !project) {
      notFound(res, `No conversation with id "${conversationId}"`);
      return null;
    }
    res.locals.naqshProjectId = project.id;
    return { conversation, project };
  }

  app.get(
    "/conversations/:conversationId",
    asyncHandler(async (req, res) => {
      const owned = getOwnedConversation(req, res);
      if (!owned) return;
      res.json({ conversation: owned.conversation, messages: messages.listForConversation(owned.conversation.id) });
    })
  );

  app.patch(
    "/conversations/:conversationId",
    asyncHandler(async (req, res) => {
      const owned = getOwnedConversation(req, res);
      if (!owned) return;
      const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 200) : owned.conversation.title;
      const updated = { ...owned.conversation, title, updatedAt: new Date().toISOString() };
      conversations.save(updated);
      res.json(updated);
    })
  );

  app.delete(
    "/conversations/:conversationId",
    asyncHandler(async (req, res) => {
      const owned = getOwnedConversation(req, res);
      if (!owned) return;
      conversations.delete(owned.conversation.id);
      res.status(204).end();
    })
  );

  /** Shared by the plain JSON and SSE-streaming message routes -- every
   * step through "resolve a valid, owned, parseable request" is identical
   * between them; only what happens with the RESULT differs. Writes the
   * 400/404 itself and returns null on failure. */
  function parseMessageRequest(req: Request, res: Response): { conversation: ConversationRecord; project: ProjectRecord; text: string; fileIds: string[]; modelId: string; style: AiStyle } | null {
    const owned = getOwnedConversation(req, res);
    if (!owned) return null;
    const text = typeof req.body?.text === "string" ? req.body.text.slice(0, MAX_MESSAGE_CHARS) : "";
    const fileIds: string[] = Array.isArray(req.body?.fileIds) ? req.body.fileIds.filter((id: unknown): id is string => typeof id === "string") : [];
    if (!text.trim() && fileIds.length === 0) {
      badRequest(res, "text or fileIds is required");
      return null;
    }
    return { conversation: owned.conversation, project: owned.project, text, fileIds, modelId: sanitizeModelId(req.body?.modelId), style: sanitizeStyle(req.body?.style) };
  }

  /** Writes the SAME "model unavailable" shape both message routes need --
   * a real user message is still saved (the user really did say
   * something), paired with an honest error assistant message, never a
   * fabricated reply. */
  function respondModelUnavailable(res: Response, conversation: ConversationRecord, text: string, fileIds: string[], reason: ModelUnavailableReason): { userMessage: MessageRecord; assistantMessage: MessageRecord } {
    const userMessage: MessageRecord = { id: createId("msg"), conversationId: conversation.id, role: "user", text, createdAt: new Date().toISOString(), fileIds };
    messages.save(userMessage);
    const errorMessage = describeModelUnavailable(reason);
    const assistantMessage: MessageRecord = {
      id: createId("msg"),
      conversationId: conversation.id,
      role: "assistant",
      text: errorMessage,
      createdAt: new Date().toISOString(),
      error: { kind: reason, message: errorMessage }
    };
    messages.save(assistantMessage);
    res.status(503).json({ userMessage, assistantMessage, requirementOutcome: null, workflowEvents: [] });
    return { userMessage, assistantMessage };
  }

  app.post(
    "/conversations/:conversationId/messages",
    asyncHandler(async (req, res) => {
      const parsed = parseMessageRequest(req, res);
      if (!parsed) return;
      const { conversation, project, text, fileIds, modelId, style } = parsed;

      const resolved = resolveModelProvider(modelId);
      if ("error" in resolved) {
        respondModelUnavailable(res, conversation, text, fileIds, resolved.error.reason);
        return;
      }

      const runtime = getOrCreateProjectRuntime(project.id, projects, project.environmentKind, runtimeStates);
      const result = await sendChatMessage({ conversation, project, runtime, provider: resolved.provider, modelId: resolved.modelId, style, text, fileIds, messages, files });
      conversations.save({ ...conversation, updatedAt: new Date().toISOString() });

      res.json(result);
    })
  );

  /**
   * Part 10: genuine streaming, via SSE. Only the PLAIN-CHAT-REPLY branch
   * of `sendChatMessage` actually streams token-by-token (see
   * chatReply.ts's doc comment); the design-intent (plan/proposal) branch
   * and the "model doesn't support streaming" fallback both still arrive
   * as a single `event: done` with zero `event: delta`s first -- an
   * honest reflection of what can genuinely be delivered incrementally,
   * never a completed string drip-fed on a timer.
   *
   * KNOWN LIMITATION: if the client aborts the connection (Stop button),
   * this handler stops WRITING further chunks (`closed` guard below), but
   * the in-flight `generateStream` call to Gemini is not itself
   * cancelled server-side -- there is no `AbortSignal` threaded through
   * `ModelProvider.generateStream` in this pass. The user-visible
   * behavior is still correct (no more text appears, whatever streamed so
   * far is preserved), but the server may keep consuming the upstream
   * response briefly after a client-side stop.
   */
  app.post(
    "/conversations/:conversationId/messages/stream",
    asyncHandler(async (req, res) => {
      const parsed = parseMessageRequest(req, res);
      if (!parsed) return;
      const { conversation, project, text, fileIds, modelId, style } = parsed;

      const resolved = resolveModelProvider(modelId);
      if ("error" in resolved) {
        respondModelUnavailable(res, conversation, text, fileIds, resolved.error.reason);
        return;
      }

      const runtime = getOrCreateProjectRuntime(project.id, projects, project.environmentKind, runtimeStates);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      // Guards each write against a client that genuinely disconnected
      // mid-stream (`writableEnded`/`destroyed` are the response's OWN
      // state, unlike `req`'s "close" event, which -- in this Node/Express
      // stack -- fires once the REQUEST body has been fully consumed, not
      // when the client actually goes away; using it here would silently
      // discard every real chunk).
      function writeEvent(event: string, data: unknown): void {
        if (res.writableEnded || res.destroyed) return;
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          // The connection dropped between the guard check and the write --
          // nothing left to do, the client is gone.
        }
      }

      const result = await sendChatMessage({
        conversation,
        project,
        runtime,
        provider: resolved.provider,
        modelId: resolved.modelId,
        style,
        text,
        fileIds,
        messages,
        files,
        onChunk: (delta) => writeEvent("delta", { text: delta })
      });
      conversations.save({ ...conversation, updatedAt: new Date().toISOString() });

      writeEvent("done", result);
      if (!res.writableEnded) res.end();
    })
  );

  /** Phase C: a real "Regenerate" for the most recent assistant reply --
   * see `regenerateChatReply`'s own doc comment for exactly what it will
   * and won't do (plain-chat replies only, last message only). Honest
   * 422s (never a fabricated success) for anything outside that. */
  app.post(
    "/conversations/:conversationId/messages/:messageId/regenerate",
    asyncHandler(async (req, res) => {
      const owned = getOwnedConversation(req, res);
      if (!owned) return;
      const { conversation, project } = owned;

      const modelId = sanitizeModelId(req.body?.modelId);
      const style = sanitizeStyle(req.body?.style);
      const resolved = resolveModelProvider(modelId);
      if ("error" in resolved) return modelUnavailable(res, resolved.error.reason);

      const runtime = getOrCreateProjectRuntime(project.id, projects, project.environmentKind, runtimeStates);
      const outcome = await regenerateChatReply({
        conversation,
        runtime,
        provider: resolved.provider,
        modelId: resolved.modelId,
        style,
        messages,
        targetMessageId: param(req, "messageId")
      });
      if (outcome.status === "error") {
        const status = outcome.error.kind === "not_found" ? 404 : outcome.error.kind === "unsupported" ? 409 : 422;
        return res.status(status).json({ error: outcome.error });
      }
      conversations.save({ ...conversation, updatedAt: new Date().toISOString() });
      res.json({ assistantMessage: outcome.assistantMessage });
    })
  );

  // ---- Files -------------------------------------------------------------------
  app.get(
    "/projects/:projectId/files",
    asyncHandler(async (req, res) => {
      const record = getOwnedProject(req, res);
      if (!record) return;
      res.json(files.listForProject(record.id));
    })
  );

  app.post(
    "/files",
    upload.array("files", 10),
    asyncHandler(async (req, res) => {
      // `projectId` is REQUIRED (not optional) -- a file with no project
      // has no owner at all, which meant it was readable by any caller
      // who knew its id, regardless of `x-naqsh-user` (both GET routes
      // below only enforce ownership `if (record.projectId !== null)`).
      // The real frontend already always supplies a real projectId
      // (`apps/web/src/api/client.ts`'s `apiUploadFiles`), so this closes
      // the gap without changing any real user-facing behavior.
      const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : null;
      if (projectId === null) return badRequest(res, "projectId is required");
      if (!isOwnedProject(projects.get(projectId), getAuthContext(req))) {
        return badRequest(res, `projectId must reference an existing project`);
      }
      const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (uploaded.length === 0) return badRequest(res, "at least one file is required");

      const records: FileRecord[] = [];
      for (const file of uploaded) {
        const id = createId("file");
        const storedAt = join("uploads", `${id}_${file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_")}`);
        writeFileSync(join(dataDir, storedAt), file.buffer);
        const result = await processFile(file.mimetype, file.originalname, file.buffer);
        const record: FileRecord = {
          id,
          projectId,
          filename: file.originalname,
          mimeType: file.mimetype || "application/octet-stream",
          size: file.size,
          createdAt: new Date().toISOString(),
          extractionStatus: result.status,
          extractedText: result.text,
          extractionError: result.error,
          storedAt
        };
        files.save(record);
        records.push(record);
      }
      res.status(201).json(records);
    })
  );

  app.get(
    "/files/:fileId",
    asyncHandler(async (req, res) => {
      const fileId = param(req, "fileId");
      const record = files.get(fileId);
      if (!record) return notFound(res, `No file with id "${fileId}"`);
      if (record.projectId !== null && !isOwnedProject(projects.get(record.projectId), getAuthContext(req))) {
        return notFound(res, `No file with id "${fileId}"`);
      }
      res.json(record);
    })
  );

  // Real, previously-unserved bytes: `storedAt` (repositories.ts) already
  // points at the exact file `POST /files` wrote to disk -- the metadata
  // route above only ever returned the extracted TEXT, never the original
  // bytes, so an image/PDF attachment had no way to be shown for real.
  // `storedAt` is always a value THIS server generated (a sanitized-
  // filename join under `uploads/`, see the POST handler below) -- never
  // client-supplied -- so there is no path-traversal surface here.
  app.get(
    "/files/:fileId/raw",
    asyncHandler(async (req, res) => {
      const fileId = param(req, "fileId");
      const record = files.get(fileId);
      if (!record) return notFound(res, `No file with id "${fileId}"`);
      if (record.projectId !== null && !isOwnedProject(projects.get(record.projectId), getAuthContext(req))) {
        return notFound(res, `No file with id "${fileId}"`);
      }
      const absolutePath = join(dataDir, record.storedAt);
      if (!existsSync(absolutePath)) {
        return res.status(410).json({ error: { kind: "not_found", message: `The original bytes for file "${fileId}" are no longer available on this server.` } });
      }
      res.setHeader("Content-Type", record.mimeType || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${record.filename.replace(/["\\]/g, "_")}"`);
      res.send(readFileSync(absolutePath));
    })
  );

  app.use((req, res) => {
    res.status(404).json({ error: { kind: "not_found", message: `No route for ${req.method} ${req.path}` } });
  });

  // Express error handler -- must have 4 args for Express to recognize it.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    writeErrorResponse(err, res);
  });

  return app;
}

function summarizeProject(
  record: ProjectRecord
): { id: string; name: string; createdAt: string; updatedAt: string; requirementCount: number; version: number; environmentKind: EnvironmentKind } {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    requirementCount: record.worldModelState.project.requirements.length,
    version: record.worldModelState.project.version,
    environmentKind: record.environmentKind ?? DEFAULT_ENVIRONMENT_KIND
  };
}

function describeModelUnavailable(reason: ModelUnavailableReason): string {
  if (reason === "not_configured") {
    return "Gemini isn't configured on this server (GEMINI_API_KEY is not set) -- no reply was generated.";
  }
  return "The requested model isn't one this server allows.";
}
