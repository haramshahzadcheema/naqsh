import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { join } from "node:path";

const repoRoot = join(process.cwd(), "..", "..");

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as Record<string, unknown>;
}

/** Every .ts file under a src/ tree, relative to repoRoot. Used for
 * repo-wide static guards that must hold everywhere, not just in the
 * files that happened to prompt them. Written as a manual recursive walk
 * rather than relying on newer Dirent.recursive/.parentPath APIs, so it
 * behaves the same regardless of exact Node patch version. */
function listTsFiles(relativeDir: string): string[] {
  const results: string[] = [];
  const walk = (currentRelativeDir: string): void => {
    const absoluteDir = join(repoRoot, currentRelativeDir);
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const entryRelativePath = `${currentRelativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(entryRelativePath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        results.push(entryRelativePath);
      }
    }
  };
  walk(relativeDir);
  return results;
}

describe("repository layout", () => {
  it("has the expected package boundaries", () => {
    const expectedFiles = [
      "package.json",
      "tsconfig.base.json",
      "apps/web/package.json",
      "apps/web/src",
      "apps/api/package.json",
      "apps/api/src",
      "packages/core/package.json",
      "packages/core/src",
      "packages/adapters/package.json",
      "packages/adapters/src",
      "packages/model-providers/package.json",
      "packages/model-providers/src",
      "packages/schemas/package.json",
      "packages/schemas/src"
    ];

    for (const relativePath of expectedFiles) {
      assert.equal(existsSync(join(repoRoot, relativePath)), true, `Expected ${relativePath} to exist`);
    }
  });

  it("does not declare a conflicting package manager config", () => {
    assert.equal(existsSync(join(repoRoot, "pnpm-workspace.yaml")), false);
  });

  it("AUDIT FIX (P26 UI): no file under packages/schemas/src imports a Node-only built-in module -- schemas must be usable from a browser bundle (apps/web), not just Node", () => {
    // Regression guard for the exact bug found wiring up apps/web:
    // ids.ts imported `randomUUID` from `node:crypto`, which a bundler
    // externalizes for the browser, crashing at runtime the moment any
    // @naqsh/schemas factory (i.e. almost all of them) ran in the UI.
    // Fixed by using the global Web Crypto API instead. This test proves
    // the fix is durable: schemas is the one package apps/web is meant to
    // import directly (its own "shared contract layer" role), so it must
    // stay free of Node-only imports, unlike core/adapters which are
    // allowed to use Node built-ins (they never run in the browser).
    // Matches an actual import/require statement naming a node: built-in,
    // not a doc comment that merely MENTIONS one while explaining why it
    // was removed (this file's own ids.ts doc comment does exactly that)
    // -- the same precision-regex lesson every other "no X leakage" check
    // in this file already applies.
    const forbiddenPattern = /^\s*import\s[^;]*from\s+["'`]node:[a-z_]+["'`]|require\s*\(\s*["'`]node:[a-z_]+["'`]\s*\)/m;
    for (const relativePath of listTsFiles("packages/schemas/src")) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must not import a Node-only built-in module (found a "node:" import) -- packages/schemas must remain usable from a browser bundle`);
    }
  });
});

describe("dependency direction: core depends on schemas, never the reverse", () => {
  it("declares @naqsh/schemas as a dependency of @naqsh/core", () => {
    const corePackageJson = readJson("packages/core/package.json");
    const dependencies = corePackageJson.dependencies as Record<string, string> | undefined;
    assert.ok(dependencies?.["@naqsh/schemas"], "@naqsh/core must depend on @naqsh/schemas");
  });

  it("does not let @naqsh/schemas depend on @naqsh/core", () => {
    const schemasPackageJson = readJson("packages/schemas/package.json");
    const dependencies = (schemasPackageJson.dependencies ?? {}) as Record<string, string>;
    assert.equal(
      "@naqsh/core" in dependencies,
      false,
      "@naqsh/schemas must stay dependency-free of @naqsh/core (schemas is the shared contract layer)"
    );
  });

  it("has exactly one entity-schema implementation, not a hand-duplicated copy", () => {
    // Regression guard for the exact bug found in the P0/P1 audit: identical
    // validators were hand-maintained in three places (core .cjs, core
    // .mjs, and an orphaned copy in schemas that nothing imported). This
    // asserts core has no local re-implementation of entity validation,
    // including Change (P2) and Tool/ToolRequest/ToolResult (P3) -- the
    // exact same risk applies to every one of them.
    const coreSourceFiles = [
      "src/transitions.ts",
      "src/bootstrap.ts",
      "src/change-history.ts",
      "src/record-transition.ts",
      "src/tool-registry.ts",
      "src/execute-tool.ts",
      "src/index.ts"
    ];
    for (const relativePath of coreSourceFiles) {
      const contents = readFileSync(join(repoRoot, "packages/core", relativePath), "utf8");
      assert.doesNotMatch(
        contents,
        /function\s+(assert|validate)(Requirement|Constraint|EngineeringObject|Decision|Experiment|Preference|Change|ChangeCause|ChangeTarget|Tool|ToolRequest|ToolResult)\b/,
        `${relativePath} must import validators from @naqsh/schemas instead of redefining them`
      );
    }
  });

  it("does not redefine WorldModelTransition or its member interfaces in core", () => {
    // Regression guard for the P2 correction: transition type CONTRACTS
    // moved from core to schemas so Change could reference them without
    // schemas depending on core. This asserts core's transitions.ts only
    // adds behavior (the registry/reducer), not a second copy of the
    // transition interfaces themselves.
    const contents = readFileSync(join(repoRoot, "packages/core/src/transitions.ts"), "utf8");
    assert.doesNotMatch(
      contents,
      /^export interface \w+Transition/m,
      "packages/core/src/transitions.ts must import transition interfaces from @naqsh/schemas instead of redefining them"
    );
  });

  it("no source file under packages/core/src or packages/schemas/src imports from apps/api or apps/web", () => {
    // The wrong-direction-import guard this file was otherwise missing
    // (flagged during the P0-P8 audit): apps consume packages, never the
    // reverse. Unlikely in practice, but this file guards every OTHER
    // wrong-direction import explicitly, so this one shouldn't be the sole
    // silent gap.
    const forbiddenPattern = /from\s+["'`](\.\.\/)*apps\/(api|web)\//;
    for (const relativePath of [...listTsFiles("packages/core/src"), ...listTsFiles("packages/schemas/src")]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must not import from apps/api or apps/web`);
    }
  });
});

describe("P3 tool system: no arbitrary code execution", () => {
  it("contains no eval, Function constructor, or subprocess/dynamic-import execution paths anywhere in core or schemas", () => {
    // Static guard for the P3 brief's hard requirement: the tool system
    // must be an explicit allowlist (register() + a known handler), never
    // a path to running arbitrary code. Checked by source-text inspection
    // rather than runtime behavior because there is no runtime input that
    // could prove a negative -- this proves the CAPABILITY doesn't exist
    // in the source at all, not just that today's tests don't trigger it.
    //
    // Scoped to EVERY .ts file under packages/core/src and
    // packages/schemas/src, not just the two tool files -- the guarantee
    // this protects is repo-wide (nothing in the World Model, Change
    // Model, or tool layers should ever gain an execution primitive), and
    // a narrower scan would miss a violation introduced anywhere else.
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/ // dynamic import of a runtime-computed (non-literal) specifier
    ];
    const sourceFiles = [
      ...listTsFiles("packages/core/src"),
      ...listTsFiles("packages/schemas/src"),
      ...listTsFiles("packages/adapters/src"),
      ...listTsFiles("packages/model-providers/src")
    ];
    assert.ok(sourceFiles.length > 10, "expected to find a substantial number of source files to scan");
    for (const relativePath of sourceFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("Tool never carries a handler field -- handlers exist only in ToolRegistry's private closure", () => {
    // A Tool that could serialize a function would defeat the "no
    // arbitrary execution" guarantee the moment it crossed a process
    // boundary. This is enforced structurally (Tool's type has no handler
    // field) and by isJsonSafeValue rejecting functions in every field
    // that IS free-form (metadata); this test guards the structural half.
    const typesContents = readFileSync(join(repoRoot, "packages/schemas/src/types.ts"), "utf8");
    const toolInterfaceMatch = typesContents.match(/export interface Tool \{[\s\S]*?\n\}/);
    assert.ok(toolInterfaceMatch, "expected to find the Tool interface in packages/schemas/src/types.ts");
    assert.doesNotMatch(toolInterfaceMatch![0], /handler/i);
  });
});

describe("P5 environment adapter: dependency direction and World Model boundary", () => {
  it("declares @naqsh/core and @naqsh/schemas as dependencies of @naqsh/adapters", () => {
    const adaptersPackageJson = readJson("packages/adapters/package.json");
    const dependencies = adaptersPackageJson.dependencies as Record<string, string> | undefined;
    assert.ok(dependencies?.["@naqsh/core"], "@naqsh/adapters must depend on @naqsh/core");
    assert.ok(dependencies?.["@naqsh/schemas"], "@naqsh/adapters must depend on @naqsh/schemas");
  });

  it("does not let @naqsh/core depend on @naqsh/adapters", () => {
    const corePackageJson = readJson("packages/core/package.json");
    const dependencies = (corePackageJson.dependencies ?? {}) as Record<string, string>;
    assert.equal(
      "@naqsh/adapters" in dependencies,
      false,
      "@naqsh/core must stay dependency-free of @naqsh/adapters -- core defines the EnvironmentAdapter contract, it never depends on a concrete implementation"
    );
  });

  it("no source file under packages/core/src imports from @naqsh/adapters", () => {
    // Matches an actual import/require statement, not a doc comment that
    // merely MENTIONS the package name while explaining the architecture
    // (e.g. "Concrete adapters (the mocks in @naqsh/adapters now, ...)"),
    // which several files in this repo legitimately do.
    const actualImportPattern = /from\s+["'`]@naqsh\/adapters["'`]|require\s*\(\s*["'`]@naqsh\/adapters["'`]\s*\)/;
    for (const relativePath of listTsFiles("packages/core/src")) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, actualImportPattern, `${relativePath} must not import @naqsh/adapters`);
    }
  });

  it("environment-adapter files never import the World Model transition/change machinery", () => {
    // Preserves the P5 brief's explicit boundary: an adapter reports what
    // an environment has; reconciling that into WorldModelState is a
    // later phase's job (P8), not this one's. If environment-adapter.ts,
    // environment-adapter-contract.ts, or any mock adapter ever imports
    // transitions.ts/change-history.ts/record-transition.ts/bootstrap.ts,
    // that boundary has been silently crossed.
    const forbiddenImports = [
      "./transitions.js",
      "./change-history.js",
      "./record-transition.js",
      "./bootstrap.js",
      "@naqsh/core/transitions",
      "@naqsh/core/change-history"
    ];
    const filesToCheck = [
      "packages/core/src/environment-adapter.ts",
      "packages/core/src/environment-adapter-contract.ts",
      ...listTsFiles("packages/adapters/src")
    ];
    for (const relativePath of filesToCheck) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- environment observation and World Model mutation are separate concerns`
        );
      }
    }
  });

  it("environment-adapter files never import P4's authorization machinery", () => {
    // Preserves the P5 brief's security requirement: EnvironmentAdapter
    // must not become a backdoor around the typed tool/permission system.
    // An adapter has no concept of AutonomyLevel/Approval/AutonomyGrant --
    // enforcement happens one layer up, in executeTool's authorize hook,
    // when a future (P6+) tool handler wraps an adapter call. If any
    // adapter file ever imports authorization.ts/approval-store.ts/
    // autonomy-grant-store.ts, that means an adapter has started making its
    // OWN policy decisions, which is exactly the bypass this boundary
    // guards against.
    const forbiddenImports = [
      "./authorization.js",
      "./approval-store.js",
      "./autonomy-grant-store.js",
      "@naqsh/core/authorization"
    ];
    const filesToCheck = [
      "packages/core/src/environment-adapter.ts",
      "packages/core/src/environment-adapter-contract.ts",
      ...listTsFiles("packages/adapters/src")
    ];
    for (const relativePath of filesToCheck) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- an adapter is a mechanism, never its own policy decision point`
        );
      }
    }
  });

  it("EnvironmentAdapter's optional methods are real methods on every implementation, not conditionally present", () => {
    // Regression guard for the capability-vs-interface design decision:
    // the P5 brief asks for "capability-oriented design" AND "fail
    // deterministically with a typed error/result" at once. That is only
    // possible if every adapter has the SAME method surface regardless of
    // what it supports (a missing method would force callers to
    // feature-detect per adapter instead of always getting a structured
    // result back). This checks the interface declares all eleven
    // operation methods as non-optional.
    const contents = readFileSync(join(repoRoot, "packages/core/src/environment-adapter.ts"), "utf8");
    const requiredMethods = [
      "describe",
      "health",
      "connect",
      "disconnect",
      "listObjects",
      "inspectObject",
      "createObject",
      "modifyObject",
      "deleteObject",
      "save",
      "checkpoint",
      "restore"
    ];
    for (const method of requiredMethods) {
      assert.doesNotMatch(
        contents,
        new RegExp(`${method}\\?\\s*[(:]`),
        `EnvironmentAdapter.${method} must not be an optional ("${method}?:") member`
      );
    }
  });
});

describe("P7 model provider: dependency direction, vendor SDK isolation, and authorization boundary", () => {
  it("declares @naqsh/core and @naqsh/schemas as dependencies of @naqsh/model-providers", () => {
    const modelProvidersPackageJson = readJson("packages/model-providers/package.json");
    const dependencies = modelProvidersPackageJson.dependencies as Record<string, string> | undefined;
    assert.ok(dependencies?.["@naqsh/core"], "@naqsh/model-providers must depend on @naqsh/core");
    assert.ok(dependencies?.["@naqsh/schemas"], "@naqsh/model-providers must depend on @naqsh/schemas");
  });

  it("does not let @naqsh/core depend on @naqsh/model-providers", () => {
    const corePackageJson = readJson("packages/core/package.json");
    const dependencies = (corePackageJson.dependencies ?? {}) as Record<string, string>;
    assert.equal(
      "@naqsh/model-providers" in dependencies,
      false,
      "@naqsh/core must stay dependency-free of @naqsh/model-providers -- core defines the ModelProvider contract, it never depends on a concrete implementation"
    );
  });

  it("no source file under packages/core/src imports from @naqsh/model-providers", () => {
    const actualImportPattern = /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/;
    for (const relativePath of listTsFiles("packages/core/src")) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, actualImportPattern, `${relativePath} must not import @naqsh/model-providers`);
    }
  });

  it("no source file under packages/core/src imports @google/genai or any other provider SDK", () => {
    // The P7 brief's central rule: "core must not become `import {
    // GoogleGenAI } from ...` throughout business logic." The ModelProvider
    // INTERFACE lives in core; the concrete Gemini SDK usage lives strictly
    // in packages/model-providers.
    const forbiddenImportPattern = /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/;
    for (const relativePath of listTsFiles("packages/core/src")) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenImportPattern, `${relativePath} must not import @google/genai`);
    }
  });

  it("model-provider files never import P4's authorization machinery", () => {
    // Mirrors the identical P5/P6 guard: a ModelProvider has no concept of
    // AutonomyLevel/Approval/AutonomyGrant. Authorization happens one layer
    // up, in executeTool's authorize hook, when a tool-call intent reaches
    // executeModelToolCall. If a model-provider file ever imports
    // authorization.ts/approval-store.ts/autonomy-grant-store.ts, that
    // means it has started making its own policy decisions.
    const forbiddenImports = ["./authorization.js", "./approval-store.js", "./autonomy-grant-store.js", "@naqsh/core/authorization"];
    const filesToCheck = [
      "packages/core/src/model-provider.ts",
      "packages/core/src/model-provider-contract.ts",
      ...listTsFiles("packages/model-providers/src")
    ];
    for (const relativePath of filesToCheck) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- a model provider is a mechanism, never its own policy decision point`
        );
      }
    }
  });

  it("model-provider files never import World Model transition/change machinery", () => {
    // A ModelProvider returns data; it never touches WorldModelState,
    // ChangeHistory, or updateWorldModel directly -- exactly the same
    // boundary already enforced for EnvironmentAdapter.
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    const filesToCheck = [
      "packages/core/src/model-provider.ts",
      "packages/core/src/model-provider-contract.ts",
      ...listTsFiles("packages/model-providers/src")
    ];
    for (const relativePath of filesToCheck) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- a model provider reports/produces data, it does not mutate the World Model itself`
        );
      }
    }
  });

  it("ModelProvider's methods are real methods, not conditionally present", () => {
    const contents = readFileSync(join(repoRoot, "packages/core/src/model-provider.ts"), "utf8");
    for (const method of ["describe", "generate"]) {
      assert.doesNotMatch(
        contents,
        new RegExp(`${method}\\?\\s*[(:]`),
        `ModelProvider.${method} must not be an optional ("${method}?:") member`
      );
    }
  });

  it("executeModelToolCall is the only core function that hands a ModelToolCallIntent to executeTool", () => {
    // Regression guard against a future shortcut: if some OTHER file in
    // core starts importing executeTool alongside a ModelToolCallIntent
    // type, that is a second, unaudited path from a model's intent to
    // actual execution -- exactly the bypass this boundary exists to
    // prevent.
    for (const relativePath of listTsFiles("packages/core/src")) {
      if (relativePath.endsWith("/execute-model-tool-call.ts") || relativePath.endsWith("/execute-tool.ts")) continue;
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      const importsExecuteTool = /from\s+["'`]\.\/execute-tool\.js["'`]/.test(contents);
      const importsToolCallIntent = /ModelToolCallIntent/.test(contents);
      assert.equal(
        importsExecuteTool && importsToolCallIntent,
        false,
        `${relativePath} must not combine executeTool with ModelToolCallIntent -- executeModelToolCall is the one sanctioned path`
      );
    }
  });
});

describe("P8 observation: read-only, environment-independent, and provider-independent", () => {
  // observation-tool.ts (the registered-tool wrapper around observeProject)
  // was removed as dead code -- nothing in apps/api ever registered it or
  // called it through executeTool; the live app calls observeProject
  // directly (engineeringWorkflow.ts's observeCurrentProject). The
  // invariant below still applies fully to the surviving file.
  const observationFiles = ["packages/core/src/observe-project.ts"];

  it("observation files never import the World Model WRITE path -- observation cannot mutate WorldModelState", () => {
    // The single most important P8 invariant: "An observation operation
    // must NEVER mutate the World Model." updateWorldModel is the ONLY
    // function that can produce a new WorldModelState; ChangeHistory/
    // recordTransition are how a mutation gets audited. If observation
    // code never imports any of them, it structurally CANNOT mutate
    // project state, no matter what a future caller does with its output.
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const relativePath of observationFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- observation must never be able to mutate the World Model`
        );
      }
    }
  });

  it("observation files never import a model-provider package or @google/genai -- Gemini never constructs an observation", () => {
    // Matches actual import/require statements only, not a doc comment
    // that merely MENTIONS "ModelProvider"/"ModelResponse" while explaining
    // the architecture (both files do this deliberately, the same way
    // several P5/P6/P7 files reference sibling concepts in prose) -- see
    // the identical reasoning on the "no source file under
    // packages/core/src imports from @naqsh/adapters" check above.
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/,
      /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/
    ];
    for (const relativePath of observationFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern} -- Gemini never constructs an ObservationResult`);
      }
    }
  });

  it("observation files never import an EnvironmentAdapter or a concrete adapter package -- observation stays environment-independent", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/adapters["'`]|require\s*\(\s*["'`]@naqsh\/adapters["'`]\s*\)/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const relativePath of observationFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(
          contents,
          pattern,
          `${relativePath} must not import ${pattern} -- observation reads WorldModelState only, never a concrete environment`
        );
      }
    }
  });

  it("observation files declare no module-level mutable state", () => {
    // No singleton "current project" -- every function takes WorldModelState
    // as an explicit argument. A module-level `let`/mutable Map/Set would
    // be exactly the hidden global state the P8 brief forbids.
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    for (const relativePath of observationFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not declare module-level mutable state`);
      }
    }
  });

  it("apps/api's observation service stays a thin pass-through -- no Gemini or adapter coupling in the API layer either", () => {
    const relativePath = "apps/api/src/observation-service.ts";
    if (!existsSync(join(repoRoot, relativePath))) return;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]/,
      /from\s+["'`]@google\/genai["'`]/,
      /from\s+["'`]@naqsh\/adapters["'`]/
    ];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
    }
  });
});

describe("P9 planning: non-mutating, environment-independent, and provider-implementation-independent", () => {
  // Mirrors P8's identical guard block above -- planning must be exactly as
  // structurally incapable of mutating the World Model, touching a concrete
  // environment, or depending on a concrete model-provider SDK as
  // observation already is. `planner.ts` imports the `ModelProvider`
  // INTERFACE (packages/core/src/model-provider.ts) -- a provider-agnostic
  // contract this package already owns -- never a concrete implementation.
  // plan-tool.ts (the registered-tool wrapper around generatePlanProposal)
  // was removed as dead code -- apps/api calls generatePlanProposal
  // directly (engineeringWorkflow.ts's generateProjectPlan), never through
  // executeTool.
  const planningFiles = ["packages/core/src/planner.ts", "packages/core/src/plan-semantics.ts", "packages/core/src/plan-query.ts"];

  it("planning files never import the World Model WRITE path -- generating a plan cannot mutate WorldModelState", () => {
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const relativePath of planningFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- planning must never be able to mutate the World Model`
        );
      }
    }
  });

  it("planning files never import a concrete model-provider package or @google/genai -- only the provider-agnostic ModelProvider interface", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/,
      /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/
    ];
    for (const relativePath of planningFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern} -- planning depends only on the ModelProvider interface`);
      }
    }
  });

  it("planning files never import an EnvironmentAdapter or a concrete adapter package -- planning stays environment-independent", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/adapters["'`]|require\s*\(\s*["'`]@naqsh\/adapters["'`]\s*\)/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const relativePath of planningFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(
          contents,
          pattern,
          `${relativePath} must not import ${pattern} -- planning never touches a concrete environment or FreeCAD`
        );
      }
    }
  });

  it("planning files declare no module-level mutable state", () => {
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    for (const relativePath of planningFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not declare module-level mutable state`);
      }
    }
  });

  it("no arbitrary code execution in the planning files -- a Plan can never carry an executable action", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of planningFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("apps/api's plan service stays a thin pass-through -- no Gemini or adapter coupling in the API layer either", () => {
    const relativePath = "apps/api/src/plan-service.ts";
    if (!existsSync(join(repoRoot, relativePath))) return;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]/,
      /from\s+["'`]@google\/genai["'`]/,
      /from\s+["'`]@naqsh\/adapters["'`]/
    ];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
    }
  });
});

describe("P10 proposals: non-mutating, non-executing, and environment-independent", () => {
  // Mirrors P8/P9's identical guard blocks above -- a Proposal describes
  // INTENT, never REALITY. Generating one must be exactly as structurally
  // incapable of mutating the World Model, executing a tool, touching a
  // concrete environment, or depending on a concrete model-provider SDK as
  // observation/planning already are. proposal-tool.ts (the registered-tool
  // wrapper around generateProposal) was removed as dead code -- apps/api
  // calls generateProposal directly (engineeringWorkflow.ts's
  // generateProjectProposal), never through executeTool.
  const proposalFiles = ["packages/core/src/proposal-generator.ts", "packages/core/src/proposal-semantics.ts"];

  it("proposal files never import the World Model WRITE path -- generating a proposal cannot mutate WorldModelState", () => {
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(
          contents.includes(forbidden),
          false,
          `${relativePath} must not import ${forbidden} -- proposing must never be able to mutate the World Model`
        );
      }
    }
  });

  it("proposal files never import executeTool/invokeRegisteredTool -- a proposal describes an action, it never invokes one", () => {
    // The single most important P10 invariant, checked structurally rather
    // than by convention: PLAN -> PROPOSED CHANGE stops at "proposed" --
    // PROPOSED CHANGE -> EXECUTION is Phase 11's job. If no P10 file ever
    // imports the tool-execution boundary, no P10 code path can reach it,
    // no matter what a future caller does with a generated Proposal.
    // Matches an actual import statement or function CALL, not a doc
    // comment that merely MENTIONS either name while explaining this exact
    // boundary (which every P10 file's own doc comments deliberately do)
    // -- the same reasoning the `@naqsh/adapters`/`@naqsh/model-providers`
    // checks elsewhere in this file already apply.
    const forbiddenPatterns = [/from\s+["'`]\.\/execute-tool\.js["'`]/, /invokeRegisteredTool\s*\(/];
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern} -- creating a proposal must never execute it`);
      }
    }
  });

  it("no P10 file defines an approveProposal/rejectProposal/executeProposal function -- approval and execution mechanics belong to later phases", () => {
    // Proves the "proposed -> executed" transition genuinely cannot happen
    // through any Phase 10 operation, not just that nothing currently
    // calls such a function -- the function itself must not exist. Matches
    // an actual function DEFINITION (name immediately followed by an
    // opening paren), not a doc comment that merely names the concept
    // while explaining this exact boundary (every P10 file's own doc
    // comments deliberately do this, in prose, with no trailing paren).
    const forbiddenPatterns = [/function\s+approveProposal\s*\(/, /function\s+rejectProposal\s*\(/, /function\s+executeProposal\s*\(/];
    for (const relativePath of [...proposalFiles, "packages/schemas/src/proposal-types.ts"]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not define ${pattern} -- that belongs to a later phase`);
      }
    }
  });

  it("no P10 file registers a tool literally named 'execute_proposal' -- that tool belongs to a later phase", () => {
    // Matches the specific shape a real registration would take
    // (`name: "execute_proposal"`, as `createTool`'s own input requires),
    // not a bare backtick-quoted mention in prose.
    const pattern = /name:\s*["'`]execute_proposal["'`]/;
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, pattern, `${relativePath} must not register a tool named "execute_proposal" -- that belongs to a later phase`);
    }
  });

  it("proposal files never import a concrete model-provider package or @google/genai -- only the provider-agnostic ModelProvider interface", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/,
      /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/
    ];
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern} -- proposal generation depends only on the ModelProvider interface`);
      }
    }
  });

  it("proposal files never import an EnvironmentAdapter or a concrete adapter package -- proposals stay environment-independent", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/adapters["'`]|require\s*\(\s*["'`]@naqsh\/adapters["'`]\s*\)/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(
          contents,
          pattern,
          `${relativePath} must not import ${pattern} -- a proposal never touches a concrete environment or FreeCAD`
        );
      }
    }
  });

  it("proposal files declare no module-level mutable state", () => {
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not declare module-level mutable state`);
      }
    }
  });

  it("no arbitrary code execution in the proposal files -- a Proposal can never carry an executable action", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of proposalFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("apps/api's proposal service stays a thin pass-through -- no Gemini, adapter, or tool-execution coupling in the API layer either", () => {
    const relativePath = "apps/api/src/proposal-service.ts";
    if (!existsSync(join(repoRoot, relativePath))) return;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]/,
      /from\s+["'`]@google\/genai["'`]/,
      /from\s+["'`]@naqsh\/adapters["'`]/
    ];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
    }
    assert.doesNotMatch(contents, /executeTool\s*\(/, `${relativePath} must not call executeTool -- proposing is not executing`);
  });
});

describe("P11 agent loop: approval-gated execution, no bypass", () => {
  // The controlled loop OBSERVE -> REASON -> PROPOSE -> APPROVAL -> EXECUTE
  // -> OBSERVE finally lets a proposal actually run -- which makes this
  // phase's structural guards the most safety-critical in the repository.
  // Every check below proves a specific way the "NO APPROVAL -> NO
  // MUTATION" invariant could be silently broken, structurally rather than
  // by convention.
  const agentLoopFiles = [
    "packages/core/src/agent-loop.ts",
    "packages/core/src/proposal-approval.ts",
    "packages/core/src/modify-object-tool.ts",
    "packages/core/src/modify-environment-object-tool.ts"
  ];

  it("agent-loop.ts never imports the World Model write path directly -- every mutation happens inside a registered tool's own handler, never as a shortcut in the orchestrator", () => {
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    const relativePath = "packages/core/src/agent-loop.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const forbidden of forbiddenImports) {
      assert.equal(
        contents.includes(forbidden),
        false,
        `${relativePath} must not import ${forbidden} -- the orchestrator itself must have no independent write path`
      );
    }
  });

  it("agent-loop.ts never calls invokeRegisteredTool directly -- executeTool is the one sanctioned execution boundary", () => {
    const relativePath = "packages/core/src/agent-loop.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /invokeRegisteredTool\s*\(/, `${relativePath} must not call invokeRegisteredTool directly`);
    assert.match(contents, /executeTool\s*\(/, `${relativePath} must call executeTool -- that is the one sanctioned execution boundary`);
  });

  it("agent-loop.ts checks proposal staleness and re-reads the approval's CURRENT status before ever executing", () => {
    // Structural proxy for "no unsafe execution": if these calls didn't
    // appear at all, there would be no code path capable of blocking a
    // stale proposal or a since-revoked approval -- this doesn't prove
    // correctness (the runtime test suite does), but it proves the
    // mechanism the runtime tests rely on genuinely exists in source.
    const relativePath = "packages/core/src/agent-loop.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /isProposalStale\s*\(/, `${relativePath} must check proposal staleness before executing`);
    assert.match(
      contents,
      /approvals\.getById\s*\(/,
      `${relativePath} must re-read the Approval by id from the ApprovalStore, never trust a run's own stale snapshot`
    );
  });

  it("modify-object-tool.ts mutates the World Model only through recordTransition -- it has no direct access to the bare updateWorldModel reducer", () => {
    const relativePath = "packages/core/src/modify-object-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /recordTransition\s*\(/, `${relativePath} must call recordTransition`);
    assert.doesNotMatch(
      contents,
      /from\s+["'`]\.\/transitions\.js["'`]/,
      `${relativePath} must not import ./transitions.js directly -- recordTransition is the sole audited write path`
    );
  });

  it("modify-environment-object-tool.ts never imports a concrete adapter package or a FreeCAD-specific module -- only the generic EnvironmentAdapter interface", () => {
    // Matches an actual import/require statement naming a freecad module,
    // not a doc comment that merely MENTIONS FreeCAD while explaining why
    // this tool stays generic (which this file's own header deliberately
    // does) -- the same precision-regex lesson the P8/P9/P10 audits already
    // applied to `@naqsh/adapters`/`@naqsh/model-providers` mentions in
    // prose elsewhere in this file.
    const relativePath = "packages/core/src/modify-environment-object-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/adapters["'`]/, `${relativePath} must not import @naqsh/adapters`);
    assert.doesNotMatch(
      contents,
      /from\s+["'`][^"'`]*freecad[^"'`]*["'`]|require\s*\(\s*["'`][^"'`]*freecad[^"'`]*["'`]\s*\)/i,
      `${relativePath} must not import a FreeCAD-specific module -- no CAD-specific dependency belongs in core orchestration`
    );
  });

  it("no P11 file registers a tool literally named 'execute_proposal' -- proposals execute as themselves (the real named tool), never through a generic execution wrapper", () => {
    const pattern = /name:\s*["'`]execute_proposal["'`]/;
    for (const relativePath of agentLoopFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, pattern, `${relativePath} must not register a tool named "execute_proposal"`);
    }
  });

  it("P11 files declare no module-level mutable state", () => {
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    for (const relativePath of agentLoopFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not declare module-level mutable state`);
      }
    }
  });

  it("apps/api's agent-loop service stays a thin pass-through -- no Gemini or adapter coupling in the API layer either", () => {
    const relativePath = "apps/api/src/agent-loop-service.ts";
    if (!existsSync(join(repoRoot, relativePath))) return;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [/from\s+["'`]@naqsh\/model-providers["'`]/, /from\s+["'`]@google\/genai["'`]/, /from\s+["'`]@naqsh\/adapters["'`]/];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
    }
  });
});

describe("P12 FreeCAD adapter: isolation, single subprocess boundary, no arbitrary execution", () => {
  // FreeCAD is the first REAL (non-mock) EnvironmentAdapter implementation
  // -- the risk this phase specifically introduces is a Python/subprocess
  // dependency leaking somewhere it shouldn't, or a "run this code" surface
  // appearing anywhere an agent (or a model) could reach it. Every check
  // below proves a specific way that could happen, structurally.

  it("no source file under packages/core/src or packages/schemas/src imports anything FreeCAD-specific -- the core stays environment-independent", () => {
    // Matches an actual import/require specifier naming a freecad module,
    // not a doc comment that merely MENTIONS FreeCAD/FreeCADAdapter while
    // explaining the architecture -- several P5/P11 files already do this
    // deliberately (e.g. environment-adapter.ts's own header names
    // "FreeCADAdapter in P12+" as the reason the interface is generic).
    // Same precision-regex lesson the P8/P9/P10 audits already applied to
    // `@naqsh/adapters`/`@naqsh/model-providers` mentions elsewhere in this
    // file -- a bare substring match would flag legitimate prose.
    const forbiddenPattern = /from\s+["'`][^"'`]*freecad[^"'`]*["'`]|require\s*\(\s*["'`][^"'`]*freecad[^"'`]*["'`]\s*\)/i;
    for (const relativePath of [...listTsFiles("packages/core/src"), ...listTsFiles("packages/schemas/src")]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must not import anything FreeCAD-specific -- the core/schemas layer must stay environment-independent`);
    }
  });

  it("declares @naqsh/core and @naqsh/schemas as dependencies of @naqsh/adapters, and does not let @naqsh/core depend on @naqsh/adapters (mirrors the P5 mock-adapter guard, re-verified for the real FreeCAD adapter)", () => {
    const adaptersPackageJson = readJson("packages/adapters/package.json");
    const adapterDependencies = adaptersPackageJson.dependencies as Record<string, string> | undefined;
    assert.ok(adapterDependencies?.["@naqsh/core"], "@naqsh/adapters must depend on @naqsh/core");
    assert.ok(adapterDependencies?.["@naqsh/schemas"], "@naqsh/adapters must depend on @naqsh/schemas");

    const corePackageJson = readJson("packages/core/package.json");
    const coreDependencies = (corePackageJson.dependencies ?? {}) as Record<string, string>;
    assert.equal("@naqsh/adapters" in coreDependencies, false, "@naqsh/core must stay dependency-free of @naqsh/adapters");
  });

  it("freecad-runtime.ts is the ONLY source file in the repo that imports node:child_process -- the subprocess boundary is not duplicated anywhere", () => {
    const forbiddenPattern = /from\s+["'`](?:node:)?child_process["'`]|require\s*\(\s*["'`](?:node:)?child_process["'`]\s*\)/;
    const allSourceFiles = [
      ...listTsFiles("packages/core/src"),
      ...listTsFiles("packages/schemas/src"),
      ...listTsFiles("packages/adapters/src"),
      ...listTsFiles("packages/model-providers/src"),
      ...listTsFiles("apps/api/src")
    ];
    const filesImportingChildProcess = allSourceFiles.filter((relativePath) =>
      forbiddenPattern.test(readFileSync(join(repoRoot, relativePath), "utf8"))
    );
    assert.deepEqual(
      filesImportingChildProcess,
      ["packages/adapters/src/freecad-runtime.ts"],
      "node:child_process must be imported by exactly freecad-runtime.ts and nowhere else -- that is the one sanctioned subprocess boundary"
    );
  });

  it("freecad-adapter.ts never imports node:child_process directly -- it must go through freecad-runtime.ts", () => {
    const relativePath = "packages/adapters/src/freecad-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /from\s+["'`](?:node:)?child_process["'`]/, `${relativePath} must not import child_process directly`);
    assert.match(contents, /from\s+["'`]\.\/freecad-runtime\.js["'`]/, `${relativePath} must delegate subprocess execution to freecad-runtime.ts`);
  });

  it("no source file anywhere in the repo contains eval(), new Function(), execSync(), or a bare spawn() outside the one sanctioned boundary", () => {
    // Re-asserts the repo-wide P3 "no arbitrary code execution" guard
    // specifically including the new freecad/ TypeScript sources, so this
    // phase's own new files are held to the identical standard rather than
    // assumed compliant.
    const forbiddenPatterns: RegExp[] = [/\beval\s*\(/, /new\s+Function\s*\(/, /\bexecSync\s*\(/, /\bspawn\s*\(/];
    for (const relativePath of ["packages/adapters/src/freecad-adapter.ts", "packages/adapters/src/freecad-runtime.ts"]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("runner.py dispatches through a fixed, named operation table -- no eval/exec, no generic 'run this Python' primitive", () => {
    const relativePath = "packages/adapters/freecad/runner.py";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /^OPERATIONS\s*=\s*\{/m, `${relativePath} must define a fixed OPERATIONS dispatch table`);
    const forbiddenPatterns: RegExp[] = [/\beval\s*\(/, /\bexec\s*\(/, /\b__import__\s*\(/, /\bcompile\s*\(/, /\bos\.system\s*\(/, /\bsubprocess\./];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern} -- no arbitrary-execution surface, even inside the adapter implementation`);
    }
  });

  it("FreeCAD's own EnvironmentAdapter never claims a delete capability -- no fabricated unbounded object lifecycle", () => {
    // Superseded from its original Phase 12 form ("exactly the save
    // capability") once Phase 14 deliberately added "modify", Phase 15
    // deliberately added "checkpoint", and a later audit fix deliberately
    // added a narrow "create" (Part::Box only, see the AUDIT FIX guard
    // block below) -- this guard still proves the one thing none of those
    // phases touched: delete remains unsupported.
    const relativePath = "packages/adapters/src/freecad-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(
      contents,
      /capabilities:\s*\[[^\]]*["'`]delete["'`]/,
      `${relativePath} must not declare the "delete" capability`
    );
  });

  it("apps/api never imports anything FreeCAD-specific or spawns a subprocess -- the application layer stays behind the adapter boundary too", () => {
    const forbiddenPattern = /from\s+["'`][^"'`]*freecad[^"'`]*["'`]|require\s*\(\s*["'`][^"'`]*freecad[^"'`]*["'`]\s*\)/i;
    const childProcessPattern = /from\s+["'`](?:node:)?child_process["'`]/;
    for (const relativePath of listTsFiles("apps/api/src")) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must not import anything FreeCAD-specific`);
      assert.doesNotMatch(contents, childProcessPattern, `${relativePath} must not import child_process directly`);
    }
  });
});

describe("P13 FreeCAD document/object/parameter/relationship inspection: generic contract, no FreeCAD-specific leakage, observe-only tools", () => {
  // Phase 13 extends Phase 12's read boundary (richer per-object fields,
  // hierarchy, differentiated relationships, bounded geometry, a new
  // inspectDocument() operation) without turning NAQSH into a FreeCAD-
  // specific application, adding arbitrary execution, or adding broad
  // autonomous CAD modification. Every check below proves one specific way
  // that could have happened, structurally -- not by re-reading the code
  // and trusting it.

  // The four Phase 13 inspection TOOL WRAPPERS (inspect-environment-
  // document/objects/object/relationships-tool.ts) were removed as dead
  // code: nothing in apps/api ever registered them, so they were never
  // reachable through executeTool. The live app calls
  // `runtime.environmentAdapter.listObjects(session)` directly
  // (engineeringWorkflow.ts's describeEnvironmentForModel) instead. The
  // checks below that specifically inspected those four files' own source
  // were removed with them; every check that applies more broadly (naming,
  // the Python runner's dispatch table, EnvironmentAdapter's own method
  // set) stays, unchanged.

  it("no source file under packages/core/src or packages/schemas/src names a FreeCAD-specific method/type (getFreeCADFeatureTree, getPartDesignBody, getSketchObject, ...) -- the inspection contract stays generic", () => {
    const forbiddenNames = ["getFreeCADFeatureTree", "getPartDesignBody", "getSketchObject", "runFreeCADPython", "runFreecadPython"];
    for (const relativePath of [...listTsFiles("packages/core/src"), ...listTsFiles("packages/schemas/src")]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const name of forbiddenNames) {
        assert.doesNotMatch(contents, new RegExp(name), `${relativePath} must not define/reference "${name}" -- FreeCAD-specific naming belongs only inside the adapter implementation, never in core/schemas`);
      }
    }
  });

  it("runner.py's OPERATIONS table still dispatches through the fixed, named table, including the new inspect_document operation -- no generic execution primitive was added", () => {
    const relativePath = "packages/adapters/freecad/runner.py";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /"inspect_document":\s*op_inspect_document/, `${relativePath} must register inspect_document in the fixed OPERATIONS table`);
    const forbiddenPatterns: RegExp[] = [/\beval\s*\(/, /\bexec\s*\(/, /\b__import__\s*\(/, /\bcompile\s*\(/, /\bos\.system\s*\(/, /\bsubprocess\./];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern} -- Phase 13's richer inspection must not introduce an execution surface`);
    }
  });

  it("EnvironmentAdapter still declares exactly six write-capable methods (create/modify/delete/save/checkpoint/restore) -- Phase 13 added inspectDocument as a read method, not a new write capability", () => {
    const relativePath = "packages/core/src/environment-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const method of ["createObject", "modifyObject", "deleteObject", "save", "checkpoint", "restore", "inspectDocument", "listObjects", "inspectObject"]) {
      assert.match(contents, new RegExp(`${method}\\s*\\(`), `${relativePath} must still declare ${method}`);
    }
  });

  it("FreeCAD's own EnvironmentAdapter still declares no delete capability -- Phase 13 is inspection-only, no new mutation capability was granted", () => {
    // Superseded from its original Phase 13 form the same way the P12
    // guard above was -- Phase 14 deliberately adds "modify", Phase 15
    // deliberately adds "checkpoint", and a later audit fix deliberately
    // adds a narrow "create"; this guard still proves Phase 13 itself
    // granted nothing beyond inspection/save, and delete remains unsupported.
    const relativePath = "packages/adapters/src/freecad-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(
      contents,
      /capabilities:\s*\[[^\]]*["'`]delete["'`]/,
      `${relativePath} must not declare the "delete" capability`
    );
  });
});

describe("P14 safe real CAD modification: narrow allowlist, validated before mutation, no arbitrary property writes", () => {
  // Phase 14 grants the FreeCAD adapter its FIRST genuine mutation
  // capability -- deliberately narrow (Step 8's explicit allowlist), with
  // every requested change validated (target/property/value/state) BEFORE
  // anything touches FreeCAD, and never through a generic "write any
  // property" escape hatch. Every check below proves one specific way
  // this narrowness/safety could have been silently lost, structurally.

  it("FreeCAD's own EnvironmentAdapter declares 'save' and 'modify' -- delete remains unsupported (checkpoint is Phase 15's own concern, create is a later audit fix's own concern, see the respective guard blocks below)", () => {
    const relativePath = "packages/adapters/src/freecad-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /capabilities:\s*\[[^\]]*["'`]save["'`][^\]]*\]/, `${relativePath} must declare "save"`);
    assert.match(contents, /capabilities:\s*\[[^\]]*["'`]modify["'`][^\]]*\]/, `${relativePath} must declare "modify"`);
    assert.doesNotMatch(
      contents,
      /capabilities:\s*\[[^\]]*["'`]delete["'`]/,
      `${relativePath} must not declare the "delete" capability`
    );
  });

  it("runner.py's mutation allowlist (SUPPORTED_MUTATIONS) is the ONLY path to setattr() on a FreeCAD object -- no generic property-write primitive exists", () => {
    const relativePath = "packages/adapters/freecad/runner.py";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /^SUPPORTED_MUTATIONS\s*=\s*\{/m, `${relativePath} must define an explicit SUPPORTED_MUTATIONS allowlist`);
    // The only setattr(obj, ...) call sites in this script must be inside
    // op_modify_object and op_create_object, both gated by that same
    // allowlist -- not a bare, unguarded "set any attribute the caller
    // names" helper anywhere else. Matches the real call shape
    // (`setattr(obj, key, value)`) specifically, not this file's own prose
    // mentions of "setattr()" in comments (the exact "match code, not
    // comments" precision-regex lesson this suite already applies
    // everywhere else -- see the P8-P13 guard blocks above).
    const setattrCallSites = contents.match(/setattr\s*\(\s*obj\s*,/g) ?? [];
    assert.equal(setattrCallSites.length, 2, `${relativePath} must contain exactly two real setattr(obj, ...) call sites (inside op_modify_object's and op_create_object's own validated loops)`);
  });

  it("no source file anywhere in the repo defines executePython/executeFreeCADScript/runFreeCADCode or an equivalent arbitrary-execution tool name", () => {
    const forbiddenNames = ["executePython", "executeFreeCADScript", "runFreeCADCode", "execute_python", "execute_freecad_script", "run_freecad_code"];
    const allSourceFiles = [
      ...listTsFiles("packages/core/src"),
      ...listTsFiles("packages/schemas/src"),
      ...listTsFiles("packages/adapters/src"),
      ...listTsFiles("packages/model-providers/src"),
      ...listTsFiles("apps/api/src")
    ];
    for (const relativePath of allSourceFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const name of forbiddenNames) {
        assert.doesNotMatch(contents, new RegExp(name, "i"), `${relativePath} must not define/reference "${name}"`);
      }
    }
    const runnerContents = readFileSync(join(repoRoot, "packages/adapters/freecad/runner.py"), "utf8");
    for (const name of forbiddenNames) {
      assert.doesNotMatch(runnerContents, new RegExp(name, "i"), `runner.py must not define/reference "${name}"`);
    }
  });

  it("modify_environment_object is classified mutation:'mutate' -- Phase 14's real mutation still goes through P4's approval-required path, not observe/suggest", () => {
    const relativePath = "packages/core/src/modify-environment-object-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /mutation:\s*["'`]mutate["'`]/, `${relativePath} must declare mutation: "mutate"`);
  });

  it("modify-environment-object-tool.ts never imports the World Model WRITE path -- an environment mutation still never touches the World Model directly", () => {
    // Same precision-import-specifier convention the P8/P9/P10 guards
    // above already use (matching an actual import specifier string, not
    // a bare word) -- this file's own doc comments legitimately DISCUSS
    // WorldModelState/reconciliation in prose (explaining what it
    // deliberately does NOT do), which a broader word-match regex would
    // wrongly flag.
    const relativePath = "packages/core/src/modify-environment-object-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const forbidden of forbiddenImports) {
      assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden}`);
    }
  });
});

describe("P15 checkpoints/snapshots/rollback/history: real capability, real audit trail, no bypass", () => {
  // Phase 15 grants the FreeCAD adapter its FIRST real recoverable-state
  // capability (checkpoint/restore) and gives core a genuine rollback
  // mutation (restore_checkpoint). Every check below proves one specific
  // way this could have silently become a bypass -- an unapproved
  // rollback, a fabricated snapshot, or a second competing history system
  // -- not by re-reading the code and trusting it.

  it("FreeCAD's own EnvironmentAdapter now declares 'checkpoint' -- a real capability, not still stubbed to unsupported_capability", () => {
    const relativePath = "packages/adapters/src/freecad-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /capabilities:\s*\[[^\]]*["'`]checkpoint["'`][^\]]*\]/, `${relativePath} must declare "checkpoint"`);
  });

  it("create_checkpoint is classified mutation:'suggest' (no approval required to capture a snapshot) -- restore_checkpoint is classified mutation:'mutate' (approval required to roll back)", () => {
    const createContents = readFileSync(join(repoRoot, "packages/core/src/create-checkpoint-tool.ts"), "utf8");
    assert.match(createContents, /mutation:\s*["'`]suggest["'`]/, "create-checkpoint-tool.ts must declare mutation: \"suggest\"");
    assert.doesNotMatch(createContents, /mutation:\s*["'`]mutate["'`]/, "create-checkpoint-tool.ts must never declare mutation: \"mutate\"");

    const restoreContents = readFileSync(join(repoRoot, "packages/core/src/restore-checkpoint-tool.ts"), "utf8");
    assert.match(restoreContents, /mutation:\s*["'`]mutate["'`]/, "restore-checkpoint-tool.ts must declare mutation: \"mutate\"");
  });

  it("restore_checkpoint reuses recordTransition/ChangeHistory -- rollback is recorded through the existing Change Model, not a second competing history system", () => {
    const relativePath = "packages/core/src/restore-checkpoint-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.ok(contents.includes("./record-transition.js"), `${relativePath} must reuse recordTransition, not reimplement audited writes`);
    assert.doesNotMatch(contents, /new\s+Map\s*<[^>]*Change[^>]*>|class\s+\w*History/, `${relativePath} must not define a parallel history/ledger data structure`);
  });

  it("Checkpoint is genuinely append-only: CheckpointStore/ArtifactStore expose no update/delete/overwrite method", () => {
    // Negative lookbehind for a preceding "." excludes a legitimate METHOD
    // CALL on some unrelated object (e.g. artifact-store.ts's own
    // `createHash(...).update(content, ...)`, Node's crypto API, nothing
    // to do with mutating a stored artifact) -- only an INTERFACE/object-
    // literal method DEFINITION named update/delete/remove/overwrite would
    // match this.
    for (const relativePath of ["packages/core/src/checkpoint-store.ts", "packages/core/src/artifact-store.ts"]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(
        contents,
        /(?<!\.)\bupdate\s*\(|(?<!\.)\bdelete\s*\(|(?<!\.)\bremove\s*\(|(?<!\.)\boverwrite\s*\(/,
        `${relativePath} must not expose an update/delete/remove/overwrite method`
      );
    }
  });

  it("runner.py's checkpoint/restore operations are plain file copies -- no eval/exec/shell/subprocess execution surface was added", () => {
    const relativePath = "packages/adapters/freecad/runner.py";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /def op_checkpoint/, `${relativePath} must define op_checkpoint`);
    assert.match(contents, /def op_restore/, `${relativePath} must define op_restore`);
    assert.match(contents, /shutil\.copy2/, `${relativePath} must implement checkpoint/restore via a real file copy`);
    const forbiddenPatterns: RegExp[] = [/\beval\s*\(/, /\bexec\s*\(/, /\b__import__\s*\(/, /\bcompile\s*\(/, /\bos\.system\s*\(/, /\bsubprocess\./, /\bos\.popen\s*\(/];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern} -- Phase 15's checkpoint/restore must not introduce an execution surface`);
    }
  });

  it("no source file under packages/core/src or packages/schemas/src references a FreeCAD-specific file extension or path (.FCStd, .naqsh_checkpoints) -- the checkpoint contract stays environment-independent", () => {
    const forbiddenPatterns = [/\.FCStd/i, /naqsh_checkpoints/i];
    for (const relativePath of [...listTsFiles("packages/core/src"), ...listTsFiles("packages/schemas/src")]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not reference FreeCAD-specific file naming -- that belongs only inside the adapter`);
      }
    }
  });

  it("restore-checkpoint-tool.ts validates checkpoint.projectId against current state BEFORE touching the environment or World Model -- cross-project restore is a structural rejection, not left to opaque-id luck", () => {
    const relativePath = "packages/core/src/restore-checkpoint-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /cross_project_forbidden/, `${relativePath} must reject a cross-project restore with a named, specific reason`);
  });
});

describe("P16 deterministic verification: pure evaluator, no arbitrary expressions, environment-independent", () => {
  // Phase 16's central architectural rule: "Gemini reasons and proposes.
  // Tools execute. Adapters observe. Verification independently
  // evaluates." verify.ts/evidence.ts are the PURE core of that rule --
  // every check below proves one specific way they could have silently
  // stopped being pure, environment-independent, or Gemini-independent.
  const verifierFiles = ["packages/core/src/verify.ts", "packages/core/src/evidence.ts"];
  const verificationToolFiles = ["packages/core/src/create-check-tool.ts", "packages/core/src/run-verification-tool.ts"];

  it("verify.ts/evidence.ts never import the World Model WRITE path -- the pure evaluator cannot mutate the World Model, a checkpoint, or anything else", () => {
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js", "./checkpoint-store.js", "./artifact-store.js"];
    for (const relativePath of verifierFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- verification must never be able to mutate anything`);
      }
    }
  });

  it("verify.ts/evidence.ts never import a model-provider package, @google/genai, or an EnvironmentAdapter/concrete adapter -- the verdict is never Gemini's, and the pure evaluator never talks to an environment itself", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/,
      /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/,
      /from\s+["'`]@naqsh\/adapters["'`]/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const relativePath of verifierFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern} -- the verdict must be deterministic, not Gemini's judgment, and evaluation itself never reaches into an environment`);
      }
    }
  });

  it("no source file under packages/core/src or packages/schemas/src imports anything FreeCAD-specific -- verification stays environment-independent (the P26 boundary this phase must not compromise)", () => {
    const forbiddenPattern = /from\s+["'`][^"'`]*freecad[^"'`]*["'`]|require\s*\(\s*["'`][^"'`]*freecad[^"'`]*["'`]\s*\)/i;
    for (const relativePath of [...verifierFiles, ...verificationToolFiles, "packages/schemas/src/verification-types.ts"]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must not import anything FreeCAD-specific`);
    }
  });

  it("verify.ts declares no module-level mutable state -- every evaluation is a pure function of its own arguments, never a hidden global", () => {
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    const contents = readFileSync(join(repoRoot, "packages/core/src/verify.ts"), "utf8");
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, "verify.ts must not declare module-level mutable state");
    }
  });

  it("no arbitrary code execution in the verifier -- a Check can never carry an executable expression", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of [...verifierFiles, ...verificationToolFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("run_verification is classified mutation:'verify'; create_check is classified mutation:'suggest' -- neither bypasses the approval boundary a real mutation would need", () => {
    const runContents = readFileSync(join(repoRoot, "packages/core/src/run-verification-tool.ts"), "utf8");
    assert.match(runContents, /mutation:\s*["'`]verify["'`]/, "run-verification-tool.ts must declare mutation: \"verify\"");
    assert.doesNotMatch(runContents, /mutation:\s*["'`]mutate["'`]/, "run-verification-tool.ts must never declare mutation: \"mutate\"");

    const createContents = readFileSync(join(repoRoot, "packages/core/src/create-check-tool.ts"), "utf8");
    assert.match(createContents, /mutation:\s*["'`]suggest["'`]/, "create-check-tool.ts must declare mutation: \"suggest\"");
    assert.doesNotMatch(createContents, /mutation:\s*["'`]mutate["'`]/, "create-check-tool.ts must never declare mutation: \"mutate\"");
  });

  it("run-verification-tool.ts never mutates via the EnvironmentAdapter -- it only calls the read-only inspectObject, never modifyObject/createObject/deleteObject", () => {
    const relativePath = "packages/core/src/run-verification-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /\.(modifyObject|createObject|deleteObject)\s*\(/, `${relativePath} must never call a mutating EnvironmentAdapter method`);
    assert.match(contents, /\.inspectObject\s*\(/, `${relativePath} must call inspectObject to observe current evidence`);
  });

  it("CheckStore/VerificationResultStore expose no update/delete/overwrite method -- Checks and VerificationResults are immutable/append-only, matching CheckpointStore's precedent", () => {
    for (const relativePath of ["packages/core/src/check-store.ts", "packages/core/src/verification-result-store.ts"]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(
        contents,
        /(?<!\.)\bupdate\s*\(|(?<!\.)\bdelete\s*\(|(?<!\.)\bremove\s*\(|(?<!\.)\boverwrite\s*\(/,
        `${relativePath} must not expose an update/delete/remove/overwrite method`
      );
    }
  });

  it("Check.kind is a closed allowlist (CHECK_KINDS), never an open string or an executable expression field", () => {
    const relativePath = "packages/schemas/src/verification-types.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /export const CHECK_KINDS:/, `${relativePath} must export a closed CHECK_KINDS allowlist`);
    for (const forbiddenField of ["expression", "formula", "script", "code"]) {
      assert.doesNotMatch(contents, new RegExp(`${forbiddenField}\\s*:`), `${relativePath} must not carry a "${forbiddenField}" field on Check -- checks are typed and allowlisted, never arbitrary expressions`);
    }
  });
});

describe("P17 objective satisfaction: pure aggregation engine, no re-verification, no LLM verdict, no arbitrary expressions", () => {
  // Phase 17's central architectural rule mirrors Phase 16's exactly one
  // level up: "Gemini reasons. Tools execute. Adapters observe.
  // Verification independently evaluates." objective-satisfaction.ts is
  // the PURE core of that rule at the objective level -- every check below
  // proves one specific way it could have silently stopped being pure,
  // FreeCAD-independent, Gemini-independent, or a re-implementation of
  // verification logic instead of a consumer of it.
  const engineFiles = ["packages/core/src/objective-satisfaction.ts"];
  const toolFiles = ["packages/core/src/evaluate-objective-satisfaction-tool.ts"];

  it("objective-satisfaction.ts never imports the World Model WRITE path, an EnvironmentAdapter, or a store -- the pure engine cannot mutate anything or perform its own I/O", () => {
    const forbiddenImports = [
      "./transitions.js",
      "./change-history.js",
      "./record-transition.js",
      "./bootstrap.js",
      "./checkpoint-store.js",
      "./artifact-store.js",
      "./check-store.js",
      "./verification-result-store.js",
      "./objective-satisfaction-store.js",
      "./environment-adapter.js"
    ];
    for (const relativePath of engineFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- the pure engine must never mutate anything or look anything up itself`);
      }
    }
  });

  it("objective-satisfaction.ts never imports a model-provider package, @google/genai, or anything FreeCAD-specific -- the verdict is never Gemini's, and stays environment-independent", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/,
      /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/,
      /from\s+["'`]@naqsh\/adapters["'`]/,
      /from\s+["'`][^"'`]*freecad[^"'`]*["'`]/i
    ];
    for (const relativePath of engineFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern}`);
      }
    }
  });

  it("objective-satisfaction.ts never re-implements deterministic verification -- it only consumes VerificationResult, it never imports or duplicates verify.ts's own check-evaluation logic", () => {
    const contents = readFileSync(join(repoRoot, "packages/core/src/objective-satisfaction.ts"), "utf8");
    assert.doesNotMatch(contents, /from\s+["'`]\.\/verify\.js["'`]/, "objective-satisfaction.ts must not import verify.ts -- P17 consumes VerificationResults, it never re-runs a Check itself");
    assert.doesNotMatch(contents, /from\s+["'`]\.\/evidence\.js["'`]/, "objective-satisfaction.ts must not import evidence.ts -- P17 never builds its own Evidence");
  });

  it("objective-satisfaction.ts declares no module-level mutable state", () => {
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    const contents = readFileSync(join(repoRoot, "packages/core/src/objective-satisfaction.ts"), "utf8");
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, "objective-satisfaction.ts must not declare module-level mutable state");
    }
  });

  it("no arbitrary code execution in the satisfaction engine or its tool -- an ObjectiveConditionOutcome can never carry an executable expression", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of [...engineFiles, ...toolFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("evaluate_objective_satisfaction is classified mutation:'verify' -- it never bypasses the approval boundary a real mutation would need", () => {
    const contents = readFileSync(join(repoRoot, "packages/core/src/evaluate-objective-satisfaction-tool.ts"), "utf8");
    assert.match(contents, /mutation:\s*["'`]verify["'`]/, "evaluate-objective-satisfaction-tool.ts must declare mutation: \"verify\"");
    assert.doesNotMatch(contents, /mutation:\s*["'`]mutate["'`]/, "evaluate-objective-satisfaction-tool.ts must never declare mutation: \"mutate\"");
  });

  it("evaluate-objective-satisfaction-tool.ts never imports an EnvironmentAdapter or a concrete adapter package -- P17 never touches the environment directly, only P16's already-produced VerificationResults", () => {
    const relativePath = "packages/core/src/evaluate-objective-satisfaction-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/adapters["'`]/, `${relativePath} must not import @naqsh/adapters`);
    assert.doesNotMatch(contents, /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/, `${relativePath} must not import the EnvironmentAdapter interface -- it has no business talking to an environment at all`);
  });

  it("evaluate-objective-satisfaction-tool.ts never imports the World Model WRITE path -- it only reads WorldModelState, never mutates it", () => {
    const relativePath = "packages/core/src/evaluate-objective-satisfaction-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const forbidden of forbiddenImports) {
      assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden}`);
    }
  });

  it("ObjectiveSatisfactionStore exposes no update/delete/overwrite method -- results are append-only, matching VerificationResultStore's precedent", () => {
    const relativePath = "packages/core/src/objective-satisfaction-store.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(
      contents,
      /(?<!\.)\bupdate\s*\(|(?<!\.)\bdelete\s*\(|(?<!\.)\bremove\s*\(|(?<!\.)\boverwrite\s*\(/,
      `${relativePath} must not expose an update/delete/remove/overwrite method`
    );
  });

  it("ObjectiveSatisfactionStatus is a closed allowlist (satisfied/not_satisfied/inconclusive), never an open string", () => {
    const relativePath = "packages/schemas/src/objective-satisfaction-types.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /export const OBJECTIVE_SATISFACTION_STATUSES:/, `${relativePath} must export a closed OBJECTIVE_SATISFACTION_STATUSES allowlist`);
    for (const forbiddenField of ["expression", "formula", "script", "code"]) {
      assert.doesNotMatch(contents, new RegExp(`${forbiddenField}\\s*:`), `${relativePath} must not carry a "${forbiddenField}" field -- satisfaction is computed from typed VerificationResults, never an arbitrary expression`);
    }
  });
});

describe("P18 natural language -> structured requirement: bounded interpretation, deterministic validation, no LLM authority", () => {
  // Phase 18's central architectural rule: "Natural language may propose
  // meaning. Structured state records meaning. Deterministic systems
  // validate what can be validated." requirement-interpreter.ts is the
  // bounded Gemini-facing half (never touches WorldModelState);
  // add-requirement-tool.ts is the approval-gated mutation half (never
  // trusts a candidate's shape without re-validating it). Every check
  // below proves one specific way that boundary could have silently
  // eroded. interpret-requirement-tool.ts (the registered-tool wrapper
  // around interpretRequirementFromText) was removed as dead code --
  // apps/api calls interpretRequirementFromText directly
  // (projectRuntime.ts), never through executeTool; the underlying
  // function's own guarantees are still fully covered below.
  const interpreterFiles = ["packages/core/src/requirement-interpreter.ts"];
  const addToolFiles = ["packages/core/src/add-requirement-tool.ts"];

  it("requirement-interpreter.ts never imports the World Model WRITE path -- interpreting text cannot mutate anything", () => {
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const relativePath of interpreterFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- interpretation must never be able to mutate the World Model`);
      }
    }
  });

  it("requirement-interpreter.ts never imports executeTool/invokeRegisteredTool, an EnvironmentAdapter, or a concrete adapter package -- interpreting text cannot execute a tool or touch an environment", () => {
    const forbiddenPatterns = [
      /from\s+["'`]\.\/execute-tool\.js["'`]/,
      /invokeRegisteredTool\s*\(/,
      /from\s+["'`]@naqsh\/adapters["'`]/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const relativePath of interpreterFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
      }
    }
  });

  it("add_requirement is classified mutation:'mutate' -- adding a requirement is a real World Model write, gated the same as any other", () => {
    const addContents = readFileSync(join(repoRoot, "packages/core/src/add-requirement-tool.ts"), "utf8");
    assert.match(addContents, /mutation:\s*["'`]mutate["'`]/, "add-requirement-tool.ts must declare mutation: \"mutate\" -- adding a requirement is a real World Model mutation, gated the same as any other");
  });

  it("add_requirement mutates the World Model only through recordTransition, reusing the EXISTING add_requirement transition -- no direct state.project.requirements.push, no new transition kind invented", () => {
    const relativePath = "packages/core/src/add-requirement-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /recordTransition\s*\(/, `${relativePath} must call recordTransition`);
    assert.match(contents, /kind:\s*["'`]add_requirement["'`]/, `${relativePath} must use the existing "add_requirement" transition kind`);
    assert.doesNotMatch(contents, /\.requirements\.push\s*\(/, `${relativePath} must never directly push onto project.requirements`);
    assert.doesNotMatch(
      contents,
      /from\s+["'`]\.\/transitions\.js["'`]/,
      `${relativePath} must not import ./transitions.js directly -- recordTransition is the sole audited write path`
    );
  });

  it("add_requirement rejects an ambiguous candidate outright -- an underspecified natural-language statement can never become an authoritative requirement", () => {
    const relativePath = "packages/core/src/add-requirement-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /ambiguous_candidate/, `${relativePath} must explicitly reject an ambiguous candidate`);
  });

  it("requirement-interpreter.ts never imports a concrete model-provider package or @google/genai -- only the provider-agnostic ModelProvider interface", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]|require\s*\(\s*["'`]@naqsh\/model-providers["'`]\s*\)/,
      /from\s+["'`]@google\/genai["'`]|require\s*\(\s*["'`]@google\/genai["'`]\s*\)/
    ];
    for (const relativePath of interpreterFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern} -- requirement interpretation depends only on the ModelProvider interface`);
      }
    }
  });

  it("requirement-interpreter.ts declares no module-level mutable state", () => {
    const forbiddenPatterns = [/^let\s+\w/m, /^const\s+\w+\s*=\s*new\s+Map/m, /^const\s+\w+\s*=\s*new\s+Set/m];
    for (const relativePath of interpreterFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not declare module-level mutable state`);
      }
    }
  });

  it("no arbitrary code execution anywhere in the P18 files -- natural-language input can never become executable input", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of [...interpreterFiles, ...addToolFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("RequirementCandidate carries no expression/formula/script field -- interpretation output is typed data, never an executable payload", () => {
    const relativePath = "packages/schemas/src/requirement-candidate-types.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const forbiddenField of ["expression", "formula", "script", "code"]) {
      assert.doesNotMatch(contents, new RegExp(`${forbiddenField}\\s*:`), `${relativePath} must not carry a "${forbiddenField}" field on RequirementCandidate`);
    }
  });

  it("add-requirement-tool.ts never imports an EnvironmentAdapter, a concrete adapter package, or a model-provider package -- accepting a requirement is a pure World Model write, not an environment or Gemini operation", () => {
    const relativePath = "packages/core/src/add-requirement-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/adapters["'`]/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/,
      /from\s+["'`]@naqsh\/model-providers["'`]/,
      /from\s+["'`]@google\/genai["'`]/
    ];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern}`);
    }
  });

  it("apps/api's requirement service stays a thin pass-through -- no adapter coupling, no direct executeTool/invokeRegisteredTool path in the API layer either", () => {
    const relativePath = "apps/api/src/requirement-service.ts";
    if (!existsSync(join(repoRoot, relativePath))) return;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [/from\s+["'`]@naqsh\/adapters["'`]/, /invokeRegisteredTool\s*\(/, /from\s+["'`]\.\/execute-tool\.js["'`]/];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
    }
  });

  it("P16/P17 boundary: P18 creates requirements, it never verifies or evaluates objective satisfaction itself", () => {
    // Phase 18 stops at producing a candidate and, once accepted, a real
    // Requirement -- it must never re-implement or reach into P16
    // (deterministic verification) or P17 (objective satisfaction). The
    // pipeline stays Requirement -> Verification -> Objective Satisfaction,
    // never collapsed or short-circuited by this phase.
    const forbiddenImports = [
      "./verify.js",
      "./evidence.js",
      "./verification-result-store.js",
      "./run-verification-tool.js",
      "./objective-satisfaction.js",
      "./objective-satisfaction-store.js",
      "./evaluate-objective-satisfaction-tool.js"
    ];
    for (const relativePath of [...interpreterFiles, ...addToolFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- P18 never performs verification or objective satisfaction`);
      }
    }
  });

  it("add_requirement never declares a Requirement 'satisfied'/'violated' itself -- only P16/P17 (via a separate, later pipeline stage) determine that", () => {
    const relativePath = "packages/core/src/add-requirement-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /status:\s*["'`](satisfied|violated)["'`]/, `${relativePath} must not itself assign a satisfied/violated status to the Requirement it creates`);
  });
});

describe("P19 requirement clarification: deterministic completeness analysis, bounded re-interpretation, no LLM authority over completeness", () => {
  // Phase 19's central architectural rule mirrors P18's exactly one level
  // up: "NAQSH must ASK when information is genuinely missing. It must
  // NOT invent engineering assumptions to make the requirement look
  // complete." requirement-completeness.ts is the PURE, Gemini-free half
  // (decides WHETHER to ask); answer-clarification-tool.ts is the bounded
  // Gemini-facing half (re-interprets an answer, via the EXISTING P18
  // pipeline, never a new prompt); clarification-store.ts never touches
  // the World Model. Every check below proves one specific way this
  // boundary could have silently eroded.
  const analyzerFiles = ["packages/core/src/requirement-completeness.ts"];
  const analyzeToolFiles = ["packages/core/src/analyze-requirement-completeness-tool.ts"];
  const answerToolFiles = ["packages/core/src/answer-clarification-tool.ts"];
  const dismissToolFiles = ["packages/core/src/dismiss-clarification-tool.ts"];
  const storeFiles = ["packages/core/src/clarification-store.ts"];
  const allP19Files = [...analyzerFiles, ...analyzeToolFiles, ...answerToolFiles, ...dismissToolFiles, ...storeFiles];

  it("requirement-completeness.ts (the pure analyzer) never imports a model-provider package, @google/genai, or the World Model write path -- completeness analysis is fully deterministic, no Gemini call", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]/,
      /from\s+["'`]@google\/genai["'`]/,
      /from\s+["'`]\.\/transitions\.js["'`]/,
      /from\s+["'`]\.\/change-history\.js["'`]/,
      /from\s+["'`]\.\/record-transition\.js["'`]/,
      /from\s+["'`]\.\/execute-tool\.js["'`]/,
      /from\s+["'`]@naqsh\/adapters["'`]/
    ];
    const contents = readFileSync(join(repoRoot, analyzerFiles[0]!), "utf8");
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${analyzerFiles[0]} must not reference ${pattern} -- completeness analysis must stay pure and Gemini-free`);
    }
  });

  it("none of the P19 files import the World Model WRITE path -- clarification (asking, answering, or dismissing) can never itself mutate WorldModelState", () => {
    const forbiddenImports = ["./transitions.js", "./change-history.js", "./record-transition.js", "./bootstrap.js"];
    for (const relativePath of allP19Files) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- P19 never mutates the World Model directly`);
      }
    }
  });

  it("answer-clarification-tool.ts reuses interpretRequirementFromText (P18) unchanged -- P19 never defines its own Gemini prompt/system instruction", () => {
    const contents = readFileSync(join(repoRoot, answerToolFiles[0]!), "utf8");
    assert.match(contents, /from\s+["'`]\.\/requirement-interpreter\.js["'`]/, "answer-clarification-tool.ts must import interpretRequirementFromText from requirement-interpreter.js (P18)");
    assert.doesNotMatch(contents, /systemInstruction\s*[:=]/, "answer-clarification-tool.ts must not define its own systemInstruction -- it reuses P18's");
    assert.doesNotMatch(contents, /from\s+["'`]@google\/genai["'`]/, "answer-clarification-tool.ts must not import @google/genai directly");
  });

  it("all three P19 tools are classified mutation:'suggest' -- never 'mutate'; none touches the environment adapter", () => {
    for (const relativePath of [...analyzeToolFiles, ...answerToolFiles, ...dismissToolFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.match(contents, /mutation:\s*["'`]suggest["'`]/, `${relativePath} must declare mutation: "suggest"`);
      assert.doesNotMatch(contents, /mutation:\s*["'`]mutate["'`]/, `${relativePath} must never declare mutation: "mutate"`);
      assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/adapters["'`]/, `${relativePath} must not import @naqsh/adapters`);
      assert.doesNotMatch(contents, /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/, `${relativePath} must not import an EnvironmentAdapter -- clarification can never touch CAD`);
    }
  });

  it("dismiss_clarification and clarification-store.ts never call interpretRequirementFromText or import a model-provider package -- only answer_clarification is Gemini-facing", () => {
    for (const relativePath of [...dismissToolFiles, ...storeFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, /interpretRequirementFromText/, `${relativePath} must not call interpretRequirementFromText`);
      assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/model-providers["'`]/, `${relativePath} must not import @naqsh/model-providers`);
    }
  });

  it("no arbitrary code execution anywhere in the P19 files -- a clarification answer can never become executable input", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of allP19Files) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("Clarification carries no expression/formula/script field -- a clarification is typed data, never an executable payload", () => {
    const relativePath = "packages/schemas/src/clarification-types.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const forbiddenField of ["expression", "formula", "script", "code"]) {
      assert.doesNotMatch(contents, new RegExp(`${forbiddenField}\\s*:`), `${relativePath} must not carry a "${forbiddenField}" field on Clarification`);
    }
  });

  it("answer_clarification rejects a candidate that is still 'ambiguous' after re-interpretation -- an unresolved answer can never become authoritative", () => {
    const contents = readFileSync(join(repoRoot, answerToolFiles[0]!), "utf8");
    assert.match(contents, /answer_insufficient/, "answer-clarification-tool.ts must explicitly reject an answer that leaves the candidate ambiguous");
  });

  it("analyze_requirement_completeness never itself creates a Requirement -- only add_requirement (P18, unmodified) does", () => {
    const contents = readFileSync(join(repoRoot, analyzeToolFiles[0]!), "utf8");
    assert.doesNotMatch(contents, /createRequirement\s*\(/, "analyze-requirement-completeness-tool.ts must not call createRequirement");
  });

  it("no P19 file duplicates P16/P17's verification/objective-satisfaction machinery", () => {
    const forbiddenImports = [
      "./verify.js",
      "./evidence.js",
      "./verification-result-store.js",
      "./run-verification-tool.js",
      "./objective-satisfaction.js",
      "./objective-satisfaction-store.js",
      "./evaluate-objective-satisfaction-tool.js"
    ];
    for (const relativePath of allP19Files) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- P19 never performs verification or objective satisfaction`);
      }
    }
  });
});

describe("P20 intent -> requirements -> plan -> design -> build -> verify: environment-independent design, bounded build, no verification duplication", () => {
  // Phase 20's central architectural rule: "P20 is NOT 'generate random CAD
  // from a prompt'. P20 IS 'transform a validated engineering intent into
  // a structured, inspectable, bounded design/build workflow.'"
  // design-generator.ts/design-semantics.ts are the PURE, Gemini-bounded
  // half (never touch WorldModelState or an environment); create-environment-object-tool.ts/
  // build-executor.ts are the bounded EXECUTION half (real mutations, only
  // through the EXISTING P3/P4 boundary); build_success is NEVER conflated
  // with verification/objective satisfaction (P16/P17, untouched). Every
  // check below proves one specific way these boundaries could have
  // silently eroded.
  const designGeneratorFiles = ["packages/core/src/design-generator.ts"];
  const designSemanticsFiles = ["packages/core/src/design-semantics.ts"];
  const designStoreFiles = ["packages/core/src/design-specification-store.ts"];
  const createEnvObjectToolFiles = ["packages/core/src/create-environment-object-tool.ts"];
  const buildOperationsFiles = ["packages/core/src/build-operations.ts"];
  const buildExecutorFiles = ["packages/core/src/build-executor.ts"];
  const buildResultStoreFiles = ["packages/core/src/build-result-store.ts"];
  const allP20Files = [
    ...designGeneratorFiles,
    ...designSemanticsFiles,
    ...designStoreFiles,
    ...createEnvObjectToolFiles,
    ...buildOperationsFiles,
    ...buildExecutorFiles,
    ...buildResultStoreFiles
  ];

  it("design-generator.ts/design-semantics.ts never import the World Model write path, executeTool, or an EnvironmentAdapter -- generating/validating a design cannot mutate or execute anything", () => {
    const forbiddenPatterns = [
      /from\s+["'`]\.\/transitions\.js["'`]/,
      /from\s+["'`]\.\/change-history\.js["'`]/,
      /from\s+["'`]\.\/record-transition\.js["'`]/,
      /from\s+["'`]\.\/execute-tool\.js["'`]/,
      /from\s+["'`]@naqsh\/adapters["'`]/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const relativePath of [...designGeneratorFiles, ...designSemanticsFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern} -- design generation/validation must stay pure`);
      }
    }
  });

  it("design-specification-types.ts is environment-independent -- no FreeCAD-specific concept in the CODE itself (doc comments are allowed to name FreeCAD when explaining the boundary, e.g. 'never carries a FreeCAD document-object reference')", () => {
    const relativePath = "packages/schemas/src/design-specification-types.ts";
    const raw = readFileSync(join(repoRoot, relativePath), "utf8");
    // Strip block comments (/** ... */) and line comments (// ...) so the
    // check inspects only actual field names/types/logic, not the doc
    // prose that legitimately explains what FreeCAD-specific data this
    // file deliberately excludes.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").toLowerCase();
    for (const forbidden of ["freecad", "part::feature", "part::box", "activedocument", "@google/genai"]) {
      assert.equal(code.includes(forbidden), false, `${relativePath}'s actual code (outside doc comments) must not reference "${forbidden}" -- the design representation must remain environment-independent (P26 depends on this)`);
    }
  });

  it("create_environment_object is classified mutation:'mutate', target:'environment' -- a real, permission-gated environment mutation, never a World Model write", () => {
    const relativePath = "packages/core/src/create-environment-object-tool.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /mutation:\s*["'`]mutate["'`]/, `${relativePath} must declare mutation: "mutate"`);
    assert.match(contents, /target:\s*["'`]environment["'`]/, `${relativePath} must declare target: "environment"`);
    assert.doesNotMatch(contents, /from\s+["'`]\.\/transitions\.js["'`]/, `${relativePath} must not import the World Model write path`);
  });

  it("build-operations.ts (the deterministic DesignSpecification -> BuildOperation translator) never imports a model-provider package, @google/genai, executeTool, or an EnvironmentAdapter -- planning build operations is mechanical, not a new Gemini call or an execution path", () => {
    const relativePath = buildOperationsFiles[0]!;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/model-providers["'`]/,
      /from\s+["'`]@google\/genai["'`]/,
      /from\s+["'`]\.\/execute-tool\.js["'`]/,
      /from\s+["'`]@naqsh\/adapters["'`]/,
      /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/
    ];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern}`);
    }
  });

  it("build-executor.ts mutates the environment ONLY through executeTool (the existing P3/P4 boundary) -- no direct EnvironmentAdapter import, no second execution mechanism, no direct World Model write", () => {
    const relativePath = buildExecutorFiles[0]!;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /from\s+["'`]\.\/execute-tool\.js["'`]/, `${relativePath} must call the existing executeTool boundary`);
    assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/adapters["'`]/, `${relativePath} must not import a concrete adapter package`);
    assert.doesNotMatch(contents, /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/, `${relativePath} must not import EnvironmentAdapter directly -- it only knows the generic Tool boundary`);
    assert.doesNotMatch(contents, /from\s+["'`]\.\/transitions\.js["'`]/, `${relativePath} must not import the World Model write path`);
    assert.doesNotMatch(contents, /from\s+["'`]\.\/record-transition\.js["'`]/, `${relativePath} must not import recordTransition`);
  });

  it("Step 14: BuildResult (build-types.ts) is never conflated with verification/objective satisfaction -- no P16/P17 type or store imported by the build layer", () => {
    const forbiddenImports = [
      "./verify.js",
      "./evidence.js",
      "./verification-result-store.js",
      "./run-verification-tool.js",
      "./objective-satisfaction.js",
      "./objective-satisfaction-store.js",
      "./evaluate-objective-satisfaction-tool.js"
    ];
    for (const relativePath of [...buildOperationsFiles, ...buildExecutorFiles, ...buildResultStoreFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden} -- build_success is never verification or objective satisfaction`);
      }
    }
    const buildTypesContents = readFileSync(join(repoRoot, "packages/schemas/src/build-types.ts"), "utf8");
    for (const forbidden of ["verificationResult", "objectiveSatisfaction", "verificationPassed", "objectiveSatisfied"]) {
      assert.equal(buildTypesContents.includes(forbidden), false, `build-types.ts must not carry a "${forbidden}" field -- BuildResult only ever claims build_success`);
    }
  });

  it("no arbitrary code execution anywhere in the P20 files -- a design/build cannot become executable input", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of allP20Files) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("design-generator.ts never imports a concrete model-provider package or @google/genai -- only the provider-agnostic ModelProvider interface, same discipline as every prior Gemini-facing file", () => {
    const relativePath = designGeneratorFiles[0]!;
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    const forbiddenPatterns = [/from\s+["'`]@naqsh\/model-providers["'`]/, /from\s+["'`]@google\/genai["'`]/];
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${relativePath} must not import ${pattern}`);
    }
  });

  it("DesignSpecificationStore/BuildResultStore are immutable-once-saved -- no update/delete method exists on either interface", () => {
    for (const relativePath of [...designStoreFiles, ...buildResultStoreFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, /^\s*update\s*\(/m, `${relativePath} must not expose an update() method`);
      assert.doesNotMatch(contents, /^\s*delete\s*\(/m, `${relativePath} must not expose a delete() method`);
    }
  });
});

describe("P21 traceable engineering research: bounded provider boundary, no arbitrary network/execution code, external content stays untrusted data, no second provenance system", () => {
  // Phase 21's central architectural rule: research is an EXPLICIT,
  // typed, permission-gated capability -- never something Gemini "just
  // knows." research-provider.ts/research-provider-contract.ts are the
  // PURE boundary contract (core never depends on a concrete provider,
  // never touches @naqsh/adapters); create-environment-object-tool.ts's
  // P20 precedent repeats here for create-source/evidence writes; and
  // research content is proven, structurally, to remain inert data (no
  // eval, no dynamic tool invocation, no permission bypass). Every check
  // below proves one specific way that boundary could have silently eroded.
  // create-research-request-tool.ts and research-request-store.ts (the
  // registered-tool wrapper and its backing store) were removed as dead
  // code -- no live caller ever invoked create_research_request through
  // executeTool. research_search/research_fetch/add_source/add_evidence
  // remain the real, wired-in P21 surface and are still fully covered
  // below.
  const researchProviderFiles = ["packages/core/src/research-provider.ts", "packages/core/src/research-provider-contract.ts"];
  const researchToolFiles = [
    "packages/core/src/research-search-tool.ts",
    "packages/core/src/research-fetch-tool.ts",
    "packages/core/src/add-source-tool.ts",
    "packages/core/src/add-evidence-tool.ts"
  ];
  const researchCacheFiles = ["packages/core/src/research-cache.ts"];
  const mockResearchProviderFiles = ["packages/adapters/src/mock-research-provider.ts"];
  const allP21CoreFiles = [...researchProviderFiles, ...researchToolFiles, ...researchCacheFiles];

  /** Strips block comments (`/** ... *​/`) and line comments (`// ...`) so a
   * source-scan checks only actual CODE, not doc prose explaining a
   * boundary (which legitimately names the very things it excludes --
   * e.g. "no node:http/https/fetch() call anywhere in this file"). Mirrors
   * the identical fix applied to the P20 FreeCAD-leakage guard above. */
  function stripComments(raw: string): string {
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("core's research-provider.ts and every research tool never import @naqsh/adapters or a concrete node networking module", () => {
    const forbiddenPatterns = [
      /from\s+["'`]@naqsh\/adapters["'`]/,
      /from\s+["'`]node:http["'`]/,
      /from\s+["'`]node:https["'`]/,
      /from\s+["'`]node:net["'`]/,
      /from\s+["'`]node:dns["'`]/
    ];
    for (const relativePath of allP21CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not reference ${pattern} -- P21's core layer stays provider-agnostic and never performs network I/O itself`);
      }
    }
  });

  it("no arbitrary code execution anywhere in the P21 files (core or the mock provider) -- a search/fetch result cannot become executable input", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of [...allP21CoreFiles, ...mockResearchProviderFiles]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("research_search/research_fetch are classified suggest/research; add_source/add_evidence are classified mutate/world_model -- the external-retrieval vs World-Model-write distinction (brief Section 15) is a real, checkable fact, not merely documented", () => {
    const suggestTargets: Record<string, string> = {
      "packages/core/src/research-search-tool.ts": "research_search",
      "packages/core/src/research-fetch-tool.ts": "research_fetch"
    };
    for (const relativePath of Object.keys(suggestTargets)) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.match(contents, /mutation:\s*["'`]suggest["'`]/, `${relativePath} must declare mutation: "suggest"`);
      assert.match(contents, /target:\s*["'`]research["'`]/, `${relativePath} must declare target: "research"`);
    }
    for (const relativePath of ["packages/core/src/add-source-tool.ts", "packages/core/src/add-evidence-tool.ts"]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.match(contents, /mutation:\s*["'`]mutate["'`]/, `${relativePath} must declare mutation: "mutate"`);
      assert.match(contents, /target:\s*["'`]world_model["'`]/, `${relativePath} must declare target: "world_model"`);
    }
  });

  it("research-provider.ts's CODE (outside doc comments) declares no AutonomyLevel/Approval/AutonomyGrant concept -- permission is enforced one layer up, by the tools, exactly like ModelProvider/EnvironmentAdapter", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/research-provider.ts"), "utf8"));
    for (const forbidden of ["AutonomyLevel", "ApprovalStore", "AutonomyGrantStore", "evaluateToolAuthorization"]) {
      assert.equal(code.includes(forbidden), false, `research-provider.ts's actual code must not reference ${forbidden} -- a provider is a dumb request/response mechanism, never a policy decision point`);
    }
  });

  it("Source/ResearchEvidence traceability reuses the EXISTING EntityRelationship mechanism (P8) -- no new relationship/traceability type was introduced", () => {
    const contents = readFileSync(join(repoRoot, "packages/schemas/src/research-types.ts"), "utf8");
    assert.doesNotMatch(contents, /interface\s+(Claim|ResearchRelationship|EvidenceLink|Traceability)\b/, "research-types.ts must not define a second traceability/relationship entity -- EntityRelationship (P8) already covers this");
  });

  it("no P21 file duplicates P16/P17's verification/objective-satisfaction machinery, or P9's Plan/PlanStep machinery", () => {
    const forbiddenImports = [
      "./verify.js",
      "./evidence.js", // P16's Evidence -- never re-implemented or aliased by P21's ResearchEvidence
      "./verification-result-store.js",
      "./objective-satisfaction.js",
      "./plan-semantics.js",
      "./planner.js"
    ];
    for (const relativePath of allP21CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden}`);
      }
    }
  });

  it("the mock research provider's CODE (outside doc comments) performs no real network I/O -- deterministic, in-process only, matching the P6/P7 mock precedent. 'fetch(' itself is deliberately NOT scanned here -- it is the provider's own legitimately-named interface method (ResearchProvider.fetch), not a network call.", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/adapters/src/mock-research-provider.ts"), "utf8"));
    for (const forbidden of ["node:http", "node:https", "node:net", "node:dns", "XMLHttpRequest", "WebSocket"]) {
      assert.equal(code.includes(forbidden), false, `mock-research-provider.ts's actual code must not reference ${forbidden} -- it must stay a deterministic, network-free provider`);
    }
  });

  it("Evidence naming does not collide with P16's Evidence -- ResearchEvidence is a distinct exported type, never re-exported as bare Evidence", () => {
    const contents = readFileSync(join(repoRoot, "packages/schemas/src/research-types.ts"), "utf8");
    assert.doesNotMatch(contents, /export\s+interface\s+Evidence\b/, "research-types.ts must not export a bare `Evidence` interface -- that name is already P16's (verification-types.ts); this file's equivalent concept must stay named ResearchEvidence");
  });
});

describe("P22 multiple candidate designs / experimentation: no duplicated models, no bypassed authorization, no accidentally-implemented P23 ranking, correct tool classifications, no arbitrary execution", () => {
  // Phase 22's central architectural rules: (1) `Candidate` REFERENCES every
  // existing entity it relates to (Objective/Requirement/Plan/Proposal/
  // DesignSpecification/Experiment/ResearchEvidence) by id, never
  // duplicating one; (2) candidate EXECUTION goes through the exact same
  // executeTool/authorize boundary as everything else -- no second
  // execution mechanism, no direct EnvironmentAdapter calls; (3) candidate
  // COMPARISON is structural only -- no scoring/ranking/"winner" logic,
  // which is explicitly P23's job, not this phase's. Every check below
  // proves one specific way that boundary could have silently eroded.
  const p22CoreFiles = [
    "packages/core/src/candidate-semantics.ts",
    "packages/core/src/candidate-store.ts",
    "packages/core/src/create-candidate-tool.ts",
    "packages/core/src/add-experiment-tool.ts",
    "packages/core/src/update-experiment-tool.ts",
    "packages/core/src/experiment-executor.ts",
    "packages/core/src/candidate-comparison.ts",
    "packages/core/src/candidate-comparison-tool.ts"
  ];

  function stripComments(raw: string): string {
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("no arbitrary code execution anywhere in the P22 files", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of p22CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("no P22 core file imports @naqsh/adapters -- core stays adapter-agnostic, same boundary every prior phase already enforces", () => {
    for (const relativePath of p22CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/adapters["'`]/, `${relativePath} must not import @naqsh/adapters`);
    }
  });

  it("create_candidate is classified suggest/world_model; compare_candidates is classified observe/world_model -- neither ever mutates the World Model or the environment", () => {
    const createCandidateContents = readFileSync(join(repoRoot, "packages/core/src/create-candidate-tool.ts"), "utf8");
    assert.match(createCandidateContents, /mutation:\s*["'`]suggest["'`]/, "create-candidate-tool.ts must declare mutation: \"suggest\"");
    assert.match(createCandidateContents, /target:\s*["'`]world_model["'`]/, "create-candidate-tool.ts must declare target: \"world_model\"");

    const compareCandidatesContents = readFileSync(join(repoRoot, "packages/core/src/candidate-comparison-tool.ts"), "utf8");
    assert.match(compareCandidatesContents, /mutation:\s*["'`]observe["'`]/, "candidate-comparison-tool.ts must declare mutation: \"observe\"");
    assert.match(compareCandidatesContents, /target:\s*["'`]world_model["'`]/, "candidate-comparison-tool.ts must declare target: \"world_model\"");
  });

  it("CandidateStore is immutable-once-saved -- no update/delete method exists, matching DesignSpecificationStore/CheckStore's identical discipline", () => {
    const contents = readFileSync(join(repoRoot, "packages/core/src/candidate-store.ts"), "utf8");
    assert.doesNotMatch(contents, /^\s*update\s*\(/m, "candidate-store.ts must not expose an update() method");
    assert.doesNotMatch(contents, /^\s*delete\s*\(/m, "candidate-store.ts must not expose a delete() method");
  });

  it("experiment-executor.ts never touches an EnvironmentAdapter directly -- it only reaches the environment through executeTool, the same boundary every other tool call goes through", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/experiment-executor.ts"), "utf8"));
    assert.doesNotMatch(code, /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/, "experiment-executor.ts must not import environment-adapter.js/environment-adapter-contract.ts -- it must call the environment only through registered, authorized tools");
    assert.doesNotMatch(code, /invokeRegisteredTool/, "experiment-executor.ts must not call invokeRegisteredTool directly -- executeTool is the only sanctioned entry point");
  });

  it("experiment-executor.ts routes checkpoint capture through the registered create_checkpoint TOOL, not a direct CheckpointStore/ArtifactStore write", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/experiment-executor.ts"), "utf8"));
    assert.doesNotMatch(code, /from\s+["'`]\.\/checkpoint-store\.js["'`]/, "experiment-executor.ts must not import checkpoint-store.js directly");
    assert.doesNotMatch(code, /from\s+["'`]\.\/artifact-store\.js["'`]/, "experiment-executor.ts must not import artifact-store.js directly");
    assert.match(code, /toolName:\s*["'`]create_checkpoint["'`]/, "experiment-executor.ts must capture its isolation baseline via the create_checkpoint tool");
  });

  it("AUDIT FIX: experiment-executor.ts records add_experiment/update_experiment through the registered TOOLS (executeTool), never a direct recordTransition call with its own getState/setState/history -- an earlier version bypassed the authorize hook for exactly these two writes", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/experiment-executor.ts"), "utf8"));
    assert.doesNotMatch(code, /from\s+["'`]\.\/record-transition\.js["'`]/, "experiment-executor.ts must not import record-transition.js directly");
    assert.doesNotMatch(code, /from\s+["'`]\.\/change-history\.js["'`]/, "experiment-executor.ts must not import change-history.js directly");
    assert.match(code, /toolName:\s*["'`]add_experiment["'`]/, "experiment-executor.ts must record the experiment via the add_experiment tool");
    assert.match(code, /toolName:\s*["'`]update_experiment["'`]/, "experiment-executor.ts must record the outcome via the update_experiment tool");
  });

  it("add_experiment and update_experiment are both classified mutation:'mutate', target:'world_model' -- Experiment lives in Project.experiments exactly like Requirement/Source, so recording/updating one requires the same real approval any other World Model write does", () => {
    for (const relativePath of ["packages/core/src/add-experiment-tool.ts", "packages/core/src/update-experiment-tool.ts"]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.match(contents, /mutation:\s*["'`]mutate["'`]/, `${relativePath} must declare mutation: "mutate"`);
      assert.match(contents, /target:\s*["'`]world_model["'`]/, `${relativePath} must declare target: "world_model"`);
    }
  });

  it("update_experiment cannot repurpose itself into rewriting an experiment's identity -- its input schema declares no id/candidateId/checkpointBeforeId/objective/hypothesis/source/createdAt property", () => {
    const contents = readFileSync(join(repoRoot, "packages/core/src/update-experiment-tool.ts"), "utf8");
    const schemaStart = contents.indexOf("const inputSchema");
    const schemaEnd = contents.indexOf("const outputSchema");
    assert.ok(schemaStart >= 0 && schemaEnd > schemaStart, "update-experiment-tool.ts must declare inputSchema before outputSchema");
    const inputSchemaText = contents.slice(schemaStart, schemaEnd);
    for (const forbiddenField of ["candidateId:", "checkpointBeforeId:", "objective:", "hypothesis:", "source:", "createdAt:"]) {
      assert.equal(inputSchemaText.includes(forbiddenField), false, `update-experiment-tool.ts's inputSchema must not declare a "${forbiddenField}" property -- an experiment's identity is fixed at creation`);
    }
  });

  it("candidate-comparison.ts and candidate-comparison-tool.ts define no scoring/ranking FIELD or sort-based ranking operation -- that is explicitly P23's job, not this phase's. (Prose that merely explains what is deliberately NOT done -- e.g. this file's own \"never declares a winner\" tool description -- is not scanned; only actual structural code is.)", () => {
    const forbiddenStructural = [
      /\b(score|rank|winner|optimal|recommended|pareto)\s*[:?]\s*(number|string|boolean)/i, // a field DECLARATION
      /\.sort\s*\(/, // any sort-based ordering of candidates
      /interface\s+\w*(Score|Rank|Ranking)\b/i
    ];
    for (const relativePath of ["packages/core/src/candidate-comparison.ts", "packages/core/src/candidate-comparison-tool.ts"]) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      for (const pattern of forbiddenStructural) {
        assert.doesNotMatch(code, pattern, `${relativePath} must not define a scoring/ranking field or sort-based ordering`);
      }
    }
  });

  it("candidate-types.ts references every related entity by id only -- it never re-declares Requirement/Constraint/Plan/Proposal/DesignSpecification/Experiment/ResearchEvidence as a nested/duplicated shape", () => {
    const contents = readFileSync(join(repoRoot, "packages/schemas/src/candidate-types.ts"), "utf8");
    assert.doesNotMatch(
      contents,
      /export\s+interface\s+(Requirement|Constraint|Plan|PlanStep|Proposal|DesignSpecification|Experiment|ResearchEvidence|Source)\b/,
      "candidate-types.ts must not define a second, duplicate entity -- Candidate references every related entity by id"
    );
  });

  it("no P22 core file defines a second Gemini-calling orchestration function for candidate generation -- candidate creation happens through the agent's own normal tool-calling loop, not a bespoke generateCandidate()", () => {
    for (const relativePath of p22CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, /function\s+generateCandidate/, `${relativePath} must not define a generateCandidate() orchestration function`);
      assert.doesNotMatch(contents, /from\s+["'`]\.\/model-provider\.js["'`]/, `${relativePath} must not import ModelProvider -- P22 does not call Gemini directly`);
    }
  });

  it("no P22 core file duplicates P16/P17's verification machinery or P9's Plan machinery -- both are reused unmodified", () => {
    const forbiddenImports = ["./verify.js", "./evidence.js", "./objective-satisfaction.js", "./planner.js"];
    for (const relativePath of p22CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden}`);
      }
    }
  });
});

describe("P23 multi-objective optimization: deterministic-only math, no Gemini verdicts, no World Model bypass, no P24/P25/P26 leakage", () => {
  // Phase 23's central architectural rule: "NAQSH may optimize based on
  // VERIFIED/MEASURED engineering results. It must NOT optimize based on
  // arbitrary LLM opinions." Every check below proves one specific way that
  // boundary could have silently eroded: the deterministic engine never
  // touches a ModelProvider/EnvironmentAdapter, a "measured" metric can only
  // ever be traced to a real VerificationResult, and Pareto/optimization
  // results never carry a hidden "best candidate" verdict.
  const p23CoreFiles = [
    "packages/core/src/optimization-semantics.ts",
    "packages/core/src/optimization-engine.ts",
    "packages/core/src/optimization-metric-store.ts",
    "packages/core/src/optimization-problem-store.ts",
    "packages/core/src/optimization-result-store.ts",
    "packages/core/src/create-optimization-problem-tool.ts",
    "packages/core/src/record-candidate-metric-value-tool.ts",
    "packages/core/src/run-optimization-tool.ts"
  ];

  function stripComments(raw: string): string {
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("no arbitrary code execution anywhere in the P23 files", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of p23CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("no P23 core file imports @naqsh/adapters -- core stays adapter-agnostic, same boundary every prior phase already enforces", () => {
    for (const relativePath of p23CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/adapters["'`]/, `${relativePath} must not import @naqsh/adapters`);
    }
  });

  it("the deterministic engine (optimization-engine.ts) never imports ModelProvider or EnvironmentAdapter -- Pareto dominance, feasibility, and weighted scores are computed by deterministic code only, never by Gemini or a live environment call", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/optimization-engine.ts"), "utf8"));
    assert.doesNotMatch(code, /from\s+["'`]\.\/model-provider(-contract)?\.js["'`]/, "optimization-engine.ts must not import ModelProvider");
    assert.doesNotMatch(code, /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/, "optimization-engine.ts must not import EnvironmentAdapter");
    assert.doesNotMatch(code, /invokeRegisteredTool/, "optimization-engine.ts must not call invokeRegisteredTool -- it is a pure function, not an orchestrator");
  });

  it("no P23 core file imports ModelProvider or EnvironmentAdapter -- not just the engine, every P23 file stays out of the Gemini/environment path entirely (defense in depth, not just the single most obvious file)", () => {
    for (const relativePath of p23CoreFiles) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      assert.doesNotMatch(code, /from\s+["'`]\.\/model-provider(-contract)?\.js["'`]/, `${relativePath} must not import ModelProvider`);
      assert.doesNotMatch(code, /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/, `${relativePath} must not import EnvironmentAdapter`);
    }
  });

  it("AUDIT FIX: computeOptimizationResult defends its own structural invariants (no duplicate objective metricKey, no duplicate candidateId) rather than silently trusting an unvalidated caller -- mirrors compareCandidates's (P22) identical defensive precedent", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/optimization-engine.ts"), "utf8"));
    assert.match(code, /WorldModelValidationError/, "optimization-engine.ts must defensively reject a malformed problem, not silently produce wrong output");
  });

  it("AUDIT FIX: the unit-compatibility check exactly mirrors P16's verify.ts checkUnitCompatible semantics -- a metric with no recorded unit is UNUSABLE when a unit is declared, never silently assumed compatible", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/optimization-engine.ts"), "utf8"));
    assert.doesNotMatch(
      code,
      /declaredUnit\s*!==\s*null\s*&&\s*metric\.unit\s*!==\s*null\s*&&\s*declaredUnit\s*!==\s*metric\.unit/,
      "optimization-engine.ts must not reintroduce the earlier buggy 'both sides must be non-null to detect a mismatch' condition"
    );
    assert.match(code, /unitsCompatible/, "optimization-engine.ts must use the shared unitsCompatible helper for both usability and mismatch-reason checks");
  });

  it("all three P23 tools are classified suggest/optimization -- none of them ever mutate the World Model or the environment", () => {
    const toolFiles: Record<string, string> = {
      "packages/core/src/create-optimization-problem-tool.ts": "create_optimization_problem",
      "packages/core/src/record-candidate-metric-value-tool.ts": "record_candidate_metric_value",
      "packages/core/src/run-optimization-tool.ts": "run_optimization"
    };
    for (const [relativePath, toolName] of Object.entries(toolFiles)) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.match(contents, /mutation:\s*["'`]suggest["'`]/, `${relativePath} (${toolName}) must declare mutation: "suggest"`);
      assert.match(contents, /target:\s*["'`]optimization["'`]/, `${relativePath} (${toolName}) must declare target: "optimization"`);
    }
  });

  it("record-candidate-metric-value-tool.ts actually cross-checks a claimed verification_result against the real VerificationResultStore, and rejects an inconclusive one -- the central integrity gate is real code, not merely documented", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/record-candidate-metric-value-tool.ts"), "utf8"));
    assert.match(code, /verificationResultStore\.getById/, "record-candidate-metric-value-tool.ts must look up the claimed verificationResultId in a real VerificationResultStore");
    assert.match(code, /"inconclusive"/, "record-candidate-metric-value-tool.ts must reject an inconclusive VerificationResult");
    assert.match(code, /verificationResult\.actual/, "record-candidate-metric-value-tool.ts must derive the metric value from the VerificationResult's own actual field, not trust a caller-supplied one");
  });

  it("AUDIT FIX: record-candidate-metric-value-tool.ts rejects a VerificationResult belonging to a DIFFERENT project than the candidate -- VerificationResultStore is not project-scoped, mirroring ObjectiveSatisfactionResult's (P17) already-established verification_result_wrong_project check for the identical cross-reference", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/record-candidate-metric-value-tool.ts"), "utf8"));
    assert.match(code, /verification_result_wrong_project/, "record-candidate-metric-value-tool.ts must reject a cross-project VerificationResult reference");
    assert.match(code, /verificationResult\.projectId\s*!==\s*candidate\.projectId/, "record-candidate-metric-value-tool.ts must actually compare verificationResult.projectId against candidate.projectId");
  });

  it("optimization-types.ts references every related entity (Requirement/Constraint/Candidate/Experiment/VerificationResult/ResearchEvidence) by id only -- it never re-declares one as a duplicated shape", () => {
    const contents = readFileSync(join(repoRoot, "packages/schemas/src/optimization-types.ts"), "utf8");
    assert.doesNotMatch(
      contents,
      /export\s+interface\s+(Requirement|Constraint|Candidate|Experiment|VerificationResult|ResearchEvidence|Objective)\b/,
      "optimization-types.ts must not define a second, duplicate entity -- P23 types reference every related entity by id"
    );
  });

  it("OptimizationResult / candidate-comparison.ts never define a scoring/ranking/'winner' FIELD or sort-based ranking operation outside the one explicit, opt-in weightedScore -- Pareto analysis never silently declares a single best candidate", () => {
    const forbiddenFieldDeclaration = /\b(winner|bestCandidateId|recommendation|rank)\s*[:?]\s*(number|string|boolean)/i;
    for (const relativePath of ["packages/schemas/src/optimization-types.ts", "packages/core/src/optimization-engine.ts"]) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      assert.doesNotMatch(code, forbiddenFieldDeclaration, `${relativePath} must not define a winner/bestCandidateId/recommendation/rank field`);
    }
  });

  it("no P23 core file implements long-term memory, autonomous/background experimentation, or a new environment adapter -- those are P24/P25/P26, out of scope this phase", () => {
    const forbiddenPatterns = [/setInterval\s*\(/, /setTimeout\s*\(/, /class\s+\w*Memory\b/i, /new\s+EnvironmentAdapter\b/];
    for (const relativePath of p23CoreFiles) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(code, pattern, `${relativePath} must not contain ${pattern} -- that would be P24/P25/P26 scope creep`);
      }
    }
  });

  it("no P23 core file duplicates P16's verification machinery or P9's planning machinery -- both are reused unmodified (P23 legitimately reuses verify.ts's compareNumeric directly, which is not duplication)", () => {
    const forbiddenImports = ["./evidence.js", "./objective-satisfaction.js", "./planner.js", "./design-generator.js"];
    for (const relativePath of p23CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        assert.equal(contents.includes(forbidden), false, `${relativePath} must not import ${forbidden}`);
      }
    }
  });
});

describe("P24 long-term engineering memory: memory is not the World Model, no fabricated grounding, deterministic-only retrieval, no P25/P26 leakage", () => {
  // Phase 24's central architectural rule: "MEMORY IS NOT THE WORLD MODEL."
  // Every check below proves one specific way that boundary could have
  // silently eroded: a MemoryRecord never lives in WorldModelState or goes
  // through the Change Model, a memory claiming grounded provenance can
  // only ever exist with a real reference into the store/entity it claims,
  // search/ranking never depends on a model call, and project isolation is
  // enforced by every read/write tool, not merely documented.
  // memory-search-tool.ts, memory-archive-tool.ts, and
  // memory-supersede-tool.ts (registered-tool wrappers around
  // searchMemoryRecords/archive/supersede) were removed as dead code --
  // no live caller ever invoked them through executeTool. memory-add-tool.ts
  // and memory-get-tool.ts remain the real, wired-in P24 tool surface.
  const p24CoreFiles = [
    "packages/core/src/memory-store.ts",
    "packages/core/src/memory-semantics.ts",
    "packages/core/src/memory-add-tool.ts",
    "packages/core/src/memory-get-tool.ts"
  ];

  function stripComments(raw: string): string {
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("no arbitrary code execution anywhere in the P24 files", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of p24CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("no P24 core file imports @naqsh/adapters -- core stays adapter-agnostic, same boundary every prior phase already enforces", () => {
    for (const relativePath of p24CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/adapters["'`]/, `${relativePath} must not import @naqsh/adapters`);
    }
  });

  it("no P24 core file imports ModelProvider or EnvironmentAdapter -- memory search/ranking is deterministic code only, never a model call, matching the brief's explicit 'Do NOT use an LLM to secretly decide which memory is relevant'", () => {
    for (const relativePath of p24CoreFiles) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      assert.doesNotMatch(code, /from\s+["'`]\.\/model-provider(-contract)?\.js["'`]/, `${relativePath} must not import ModelProvider`);
      assert.doesNotMatch(code, /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/, `${relativePath} must not import EnvironmentAdapter`);
    }
  });

  it("MEMORY IS NOT THE WORLD MODEL: no P24 file imports the transition/reducer machinery or calls updateWorldModel/recordTransition -- a MemoryRecord is never written via the Change Model", () => {
    for (const relativePath of p24CoreFiles) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      assert.doesNotMatch(code, /from\s+["'`]\.\/transitions\.js["'`]/, `${relativePath} must not import the World Model transition/reducer machinery`);
      assert.doesNotMatch(code, /updateWorldModel\s*\(/, `${relativePath} must not call updateWorldModel`);
      assert.doesNotMatch(code, /recordTransition\s*\(/, `${relativePath} must not call recordTransition`);
    }
  });

  it("memory-types.ts references every related entity (Decision/Preference/Requirement/Constraint/Experiment/Candidate/VerificationResult/OptimizationResult/ResearchEvidence/Source/Checkpoint/Change) by id only -- it never re-declares one as a duplicated shape", () => {
    const contents = readFileSync(join(repoRoot, "packages/schemas/src/memory-types.ts"), "utf8");
    assert.doesNotMatch(
      contents,
      /export\s+interface\s+(Decision|Preference|Requirement|Constraint|Experiment|Candidate|VerificationResult|OptimizationResult|ResearchEvidence|Source|Checkpoint|Change)\b/,
      "memory-types.ts must not define a second, duplicate entity -- P24 types reference every related entity by id"
    );
  });

  it("both real P24 tools are classified into the 'memory' target, with the read tool observe and the write tool suggest -- neither ever mutates the World Model or the environment", () => {
    const toolClassifications: Record<string, string> = {
      "packages/core/src/memory-add-tool.ts": "suggest",
      "packages/core/src/memory-get-tool.ts": "observe"
    };
    for (const [relativePath, mutation] of Object.entries(toolClassifications)) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.match(contents, new RegExp(`mutation:\\s*["'\`]${mutation}["'\`]`), `${relativePath} must declare mutation: "${mutation}"`);
      assert.match(contents, /target:\s*["'`]memory["'`]/, `${relativePath} must declare target: "memory"`);
    }
  });

  it("record-candidate-metric-value-tool.ts-style grounding gate is real code: assertMemoryRecord enforces confidence is null unless provenanceKind is model_synthesis, and requires a real reference for verification_result/optimization_result/experiment_result/research_evidence/change_model provenance", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/schemas/src/validators.ts"), "utf8"));
    assert.match(code, /memoryRecord\.confidence must be null unless provenanceKind is "model_synthesis"/, "assertMemoryRecord must reject a stray confidence outside model_synthesis provenance");
    assert.match(code, /groundingRequirements/, "assertMemoryRecord must enforce a real reference for each grounded provenanceKind");
  });

  it("MemoryStore.supersede defends against cycles -- the check is real code, not merely documented", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/memory-store.ts"), "utf8"));
    assert.match(code, /isReachableViaSupersession/, "memory-store.ts must actually check reachability before applying a supersede transition");
    assert.match(code, /would create a cycle/, "memory-store.ts must reject a supersede call that would create a cycle");
  });

  it("PROJECT ISOLATION IS CRITICAL: every P24 tool reads projectId from live WorldModelState (never a caller-supplied field) and scopes its store access to the current project", () => {
    const toolFiles = [
      "packages/core/src/memory-add-tool.ts",
      "packages/core/src/memory-get-tool.ts"
    ];
    for (const relativePath of toolFiles) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      assert.match(code, /getState\s*\(\s*\)/, `${relativePath} must read live WorldModelState via getState()`);
      assert.match(
        code,
        /listForProject\s*\(\s*state\.project\.id\s*\)|\.projectId\s*!==\s*state\.project\.id/,
        `${relativePath} must scope its memory access to the current project (listForProject or an explicit projectId comparison)`
      );
    }
  });

  it("no P24 core file implements bounded autonomous experimentation or an environment-independent agent loop -- those are P25/P26, out of scope this phase", () => {
    const forbiddenPatterns = [/setInterval\s*\(/, /setTimeout\s*\(/, /class\s+\w*Autonomous\w*\b/i, /new\s+EnvironmentAdapter\b/];
    for (const relativePath of p24CoreFiles) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(code, pattern, `${relativePath} must not contain ${pattern} -- that would be P25/P26 scope creep`);
      }
    }
  });

  it("searchMemoryRecords and getRelatedMemoryRecords are bounded -- MAX_MEMORY_SEARCH_RESULTS is real code, not merely documented", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/memory-semantics.ts"), "utf8"));
    assert.match(code, /MAX_MEMORY_SEARCH_RESULTS/, "memory-semantics.ts must define and use a real upper bound on search results");
    assert.match(code, /Math\.min\s*\(\s*requestedLimit,\s*MAX_MEMORY_SEARCH_RESULTS\s*\)/, "searchMemoryRecords must actually clamp the requested limit");
  });
});

describe("P25 bounded background experimentation: no unbounded execution, no second agent loop, no autonomy/authorization bypass, no P26 leakage", () => {
  // Phase 25's central architectural rule: "P25 is NOT 'make the agent
  // autonomous.' P25 is: BOUNDED BACKGROUND ENGINEERING WORK." Every check
  // below proves one specific way that boundary could have silently
  // eroded: no unbounded loop construct exists anywhere in the P25 files,
  // budget enforcement and the one-running-job-per-project concurrency
  // policy are real code (not merely documented), cancellation is
  // cooperative (no forced-kill primitive), P25 consumes P4's existing
  // authorization/P22's existing experiment executor unmodified rather
  // than reimplementing either, and no P25 file defines a second,
  // competing agent loop or reaches into P26 territory.
  const p25CoreFiles = [
    "packages/core/src/background-job-store.ts",
    "packages/core/src/job-event-store.ts",
    "packages/core/src/background-job-budget.ts",
    "packages/core/src/background-job-runner.ts",
    "packages/core/src/submit-background-job-tool.ts",
    "packages/core/src/get-background-job-tool.ts",
    "packages/core/src/cancel-background-job-tool.ts"
  ];

  function stripComments(raw: string): string {
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("no arbitrary code execution anywhere in the P25 files", () => {
    const forbiddenPatterns: RegExp[] = [
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /require\s*\(\s*["'`]child_process["'`]\s*\)/,
      /from\s+["'`]child_process["'`]/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /import\s*\(\s*[a-zA-Z_$]/
    ];
    for (const relativePath of p25CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(contents, pattern, `${relativePath} must not contain ${pattern}`);
      }
    }
  });

  it("no P25 core file imports @naqsh/adapters -- core stays adapter-agnostic, same boundary every prior phase already enforces", () => {
    for (const relativePath of p25CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, /from\s+["'`]@naqsh\/adapters["'`]/, `${relativePath} must not import @naqsh/adapters`);
    }
  });

  it("no P25 core file imports ModelProvider or a concrete EnvironmentAdapter -- the runner never calls a model or an environment directly, only through the existing executeTool/executeExperimentForCandidate boundary", () => {
    for (const relativePath of p25CoreFiles) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      assert.doesNotMatch(code, /from\s+["'`]\.\/model-provider(-contract)?\.js["'`]/, `${relativePath} must not import ModelProvider`);
      assert.doesNotMatch(code, /from\s+["'`]\.\/environment-adapter(-contract)?\.js["'`]/, `${relativePath} must not import EnvironmentAdapter`);
    }
  });

  it("NO UNBOUNDED EXECUTION: no P25 file contains a while(true)/for(;;) construct, or a raw setInterval/setTimeout that could drive an unbounded background loop", () => {
    const forbiddenPatterns = [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/, /setInterval\s*\(/, /setTimeout\s*\(/];
    for (const relativePath of p25CoreFiles) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(code, pattern, `${relativePath} must not contain ${pattern} -- P25 execution must always be bounded by a finite candidate list plus checkBudgetExhausted, never a driving timer/infinite loop`);
      }
    }
  });

  it("background-job-runner.ts's candidate loop is a bounded for-of over job.candidateIds (a finite array), and actually calls checkBudgetExhausted before every iteration -- budget enforcement is real code, not merely documented", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/background-job-runner.ts"), "utf8"));
    assert.match(code, /for\s*\(\s*const\s+candidateId\s+of\s+job\.candidateIds\s*\)/, "background-job-runner.ts must loop over the job's own finite candidateIds array");
    assert.match(code, /checkBudgetExhausted\s*\(/, "background-job-runner.ts must actually call checkBudgetExhausted");
  });

  it("CONCURRENCY POLICY IS REAL CODE: runBackgroundJob actually consults getRunningJobForProject and rejects starting a second job for the same project, not merely documented", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/background-job-runner.ts"), "utf8"));
    assert.match(code, /getRunningJobForProject\s*\(/, "background-job-runner.ts must call jobStore.getRunningJobForProject");
    assert.match(code, /project_job_conflict/, "background-job-runner.ts must reject a second concurrent job for the same project");
  });

  it("COOPERATIVE CANCELLATION, NEVER A FORCED KILL: no P25 file references process.kill, a Worker/child process termination API, or AbortController-driven forced termination -- cancellation is checked cooperatively via job status alone", () => {
    const forbiddenPatterns = [/process\.kill/, /\.terminate\s*\(/, /new\s+Worker\s*\(/, /AbortController/];
    for (const relativePath of p25CoreFiles) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(code, pattern, `${relativePath} must not contain ${pattern} -- P25 cancellation is cooperative (checked via job.status) only`);
      }
    }
    const runnerCode = stripComments(readFileSync(join(repoRoot, "packages/core/src/background-job-runner.ts"), "utf8"));
    assert.match(runnerCode, /status\s*===\s*["'`]cancelling["'`]/, "background-job-runner.ts must cooperatively check job status for cancellation");
  });

  it("NO SECOND, COMPETING AGENT LOOP: background-job-runner.ts never imports agent-loop.ts, and never calls a ModelProvider directly to decide what to do next -- it orchestrates the EXISTING executeExperimentForCandidate (P22) over a caller-supplied candidate list, it never invents its own model-driven decision loop", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/background-job-runner.ts"), "utf8"));
    assert.doesNotMatch(code, /from\s+["'`]\.\/agent-loop\.js["'`]/, "background-job-runner.ts must not import agent-loop.ts -- P25 reuses P22's executor, it does not reimplement or wrap P11's agent loop");
    assert.match(code, /executeExperimentForCandidate\s*\(/, "background-job-runner.ts must call the existing, unmodified executeExperimentForCandidate (P22)");
  });

  it("NO NEW AUTONOMY MODEL: background-job-runner.ts consumes the existing createExecuteToolAuthorizer (P4) unmodified, and never redefines AutonomyLevel/Approval/AutonomyGrant evaluation logic itself", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/background-job-runner.ts"), "utf8"));
    assert.match(code, /createExecuteToolAuthorizer\s*\(/, "background-job-runner.ts must call the existing createExecuteToolAuthorizer (P4)");
    assert.doesNotMatch(code, /function\s+evaluateToolAuthorization\b/, "background-job-runner.ts must not redefine evaluateToolAuthorization -- P4's authorization logic is reused, not duplicated");
  });

  it("NO SECOND CHECKPOINT SYSTEM: no P25 file imports checkpoint-store.ts or artifact-store.ts directly -- checkpoint/restore only ever happens through the real, registered create_checkpoint/restore_checkpoint TOOLS (via executeTool), reused from P15/P22 unmodified", () => {
    for (const relativePath of p25CoreFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, /from\s+["'`]\.\/checkpoint-store\.js["'`]/, `${relativePath} must not import checkpoint-store.ts directly`);
      assert.doesNotMatch(contents, /from\s+["'`]\.\/artifact-store\.js["'`]/, `${relativePath} must not import artifact-store.ts directly`);
    }
  });

  it("all three P25 tools are classified into the 'job' target, with the read tool observe and the lifecycle tools suggest -- none of them ever mutate the World Model or the environment", () => {
    const toolClassifications: Record<string, string> = {
      "packages/core/src/submit-background-job-tool.ts": "suggest",
      "packages/core/src/get-background-job-tool.ts": "observe",
      "packages/core/src/cancel-background-job-tool.ts": "suggest"
    };
    for (const [relativePath, mutation] of Object.entries(toolClassifications)) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.match(contents, new RegExp(`mutation:\\s*["'\`]${mutation}["'\`]`), `${relativePath} must declare mutation: "${mutation}"`);
      assert.match(contents, /target:\s*["'`]job["'`]/, `${relativePath} must declare target: "job"`);
    }
  });

  it("background-job-types.ts references every related entity (Candidate/Experiment/Checkpoint/BuildResult/VerificationResult/OptimizationResult/ObjectiveSatisfactionResult) by id only -- it never re-declares one as a duplicated shape", () => {
    const contents = readFileSync(join(repoRoot, "packages/schemas/src/background-job-types.ts"), "utf8");
    assert.doesNotMatch(
      contents,
      /export\s+interface\s+(Candidate|Experiment|Checkpoint|BuildResult|VerificationResult|OptimizationResult|ObjectiveSatisfactionResult)\b/,
      "background-job-types.ts must not define a second, duplicate entity -- P25 types reference every related entity by id"
    );
  });

  it("BackgroundJob's JobBudget has no way to express 'unlimited' -- every dimension is a required, non-optional number, never an optional/nullable field that a caller could omit to mean infinity", () => {
    const contents = readFileSync(join(repoRoot, "packages/schemas/src/background-job-types.ts"), "utf8");
    const budgetInterfaceMatch = contents.match(/export interface JobBudget \{[\s\S]*?\n\}/);
    assert.ok(budgetInterfaceMatch, "expected to find the JobBudget interface in packages/schemas/src/background-job-types.ts");
    assert.doesNotMatch(budgetInterfaceMatch![0], /\?\s*:/, "JobBudget must declare every field as required (no '?:' optional fields)");
  });

  it("PROJECT ISOLATION IS CRITICAL: every P25 tool reads projectId from live WorldModelState (never a caller-supplied field) and scopes its store access to the current project", () => {
    const toolFiles = ["packages/core/src/submit-background-job-tool.ts", "packages/core/src/get-background-job-tool.ts", "packages/core/src/cancel-background-job-tool.ts"];
    for (const relativePath of toolFiles) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      assert.match(code, /getState\s*\(\s*\)/, `${relativePath} must read live WorldModelState via getState()`);
      assert.match(
        code,
        /projectId\s*!==\s*state\.project\.id|projectId:\s*state\.project\.id/,
        `${relativePath} must scope its job access to the current project`
      );
    }
  });

  it("no P25 core file implements a second, environment-independent engineering agent or a UI -- that is P26, out of scope this phase", () => {
    const forbiddenPatterns = [/class\s+\w*EnvironmentIndependentAgent\w*\b/i, /from\s+["'`]react["'`]/, /from\s+["'`]express["'`]/];
    for (const relativePath of p25CoreFiles) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(code, pattern, `${relativePath} must not contain ${pattern} -- that would be P26 scope creep`);
      }
    }
  });

  it("AUDIT FIX (HONEST STATUS): background-job-runner.ts never transitions a job to 'paused' -- pause/resume exists in the state machine for a future caller, but this phase's own runner and tools must not falsely claim to implement it", () => {
    const runnerCode = stripComments(readFileSync(join(repoRoot, "packages/core/src/background-job-runner.ts"), "utf8"));
    assert.doesNotMatch(runnerCode, /["'`]paused["'`]/, "background-job-runner.ts must not reference the literal 'paused' status -- it never produces that transition");
    for (const relativePath of ["packages/core/src/submit-background-job-tool.ts", "packages/core/src/get-background-job-tool.ts", "packages/core/src/cancel-background-job-tool.ts"]) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      assert.doesNotMatch(code, /transition\s*\([^)]*["'`]paused["'`]/, `${relativePath} must not transition any job to 'paused'`);
    }
  });
});

describe("P26 environment-independent engineering agent: no vendor concepts in core, no environment-kind conditionals, registry stays below the core boundary", () => {
  // P26's central rule: "The Naqsh agent operates on an abstract
  // engineering environment through a stable EnvironmentAdapter boundary.
  // FreeCAD is one implementation of that boundary, not the definition of
  // the agent." Every check below proves one specific way that boundary
  // could have silently eroded -- most of the underlying guarantees
  // (no FreeCAD leakage into core/schemas, capability-gated contract tests,
  // generic tool naming) were ALREADY established and enforced by the
  // P5/P12/P13 sections above; this section covers what's NEW in P26: the
  // environment registry stays out of core, orchestration files contain no
  // environment-KIND conditional, and the create/modify build-operation
  // branch (P26's own addition) is real, exercised code.
  const orchestrationFiles = [
    "packages/core/src/agent-loop.ts",
    "packages/core/src/experiment-executor.ts",
    "packages/core/src/background-job-runner.ts",
    "packages/core/src/build-executor.ts",
    "packages/core/src/build-operations.ts",
    "packages/core/src/optimization-engine.ts"
  ];

  function stripComments(raw: string): string {
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("no core orchestration file imports @naqsh/adapters or an environment registry -- core never selects a concrete environment by name", () => {
    const forbiddenPatterns = [/from\s+["'`]@naqsh\/adapters["'`]/, /from\s+["'`][^"'`]*environment-registry[^"'`]*["'`]/i];
    for (const relativePath of orchestrationFiles) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(code, pattern, `${relativePath} must not import ${pattern} -- core receives an already-constructed EnvironmentAdapter, it never selects one by name`);
      }
    }
  });

  it("no core orchestration file branches on an environment kind string (\"freecad\"/\"mock_cad\"/\"mock_simulation\") -- polymorphism/capabilities only, never environment-name conditionals", () => {
    const forbiddenPatterns = [/===\s*["'`]freecad["'`]/, /===\s*["'`]mock_cad["'`]/, /===\s*["'`]mock_simulation["'`]/, /\.kind\s*===\s*["'`]freecad["'`]/];
    for (const relativePath of orchestrationFiles) {
      const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(code, pattern, `${relativePath} must not branch on a specific environment kind -- use supportsCapability()/structured errors instead`);
      }
    }
  });

  it("environment-registry.ts lives in @naqsh/adapters, not @naqsh/core, and uses a Map (not a switch statement) for lookup", () => {
    const relativePath = "packages/adapters/src/environment-registry.ts";
    assert.equal(existsSync(join(repoRoot, relativePath)), true, "the environment registry must live in @naqsh/adapters");
    const code = stripComments(readFileSync(join(repoRoot, relativePath), "utf8"));
    assert.doesNotMatch(code, /\bswitch\s*\(/, "environment-registry.ts must not use a switch statement -- Map-based registration only");
    assert.match(code, /new Map/, "environment-registry.ts must use a Map for kind -> registration lookup");
  });

  it("build-operations.ts's create-vs-modify branch (P26) is real code, not merely documented -- it actually checks targetObjectId and plans modify_environment_object", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/core/src/build-operations.ts"), "utf8"));
    assert.match(code, /targetObjectId/, "build-operations.ts must reference ExpectedBuildOutput.targetObjectId");
    assert.match(code, /modify_environment_object/, "build-operations.ts must be able to plan a modify_environment_object operation");
  });

  it("ExpectedBuildOutput.targetObjectId defaults to null in the factory -- every design specification predating P26 keeps its exact prior (create-only) behavior", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/schemas/src/factories.ts"), "utf8"));
    assert.match(code, /targetObjectId:\s*input\.targetObjectId\s*\?\?\s*null/, "createExpectedBuildOutput must default targetObjectId to null");
  });

  it("mock_cad and mock_simulation declare genuinely different EnvironmentCapability sets -- the contract suite is proven capability-driven, not just running twice against identical profiles", () => {
    const cadCode = stripComments(readFileSync(join(repoRoot, "packages/adapters/src/mock-cad-environment.ts"), "utf8"));
    const simCode = stripComments(readFileSync(join(repoRoot, "packages/adapters/src/mock-simulation-environment.ts"), "utf8"));
    assert.match(cadCode, /capabilities:\s*\[\s*["'`]create["'`]/, "mock-cad-environment.ts must declare 'create' among its capabilities");
    assert.doesNotMatch(simCode, /capabilities:\s*\[\s*["'`]create["'`]|capabilities:\s*\[[^\]]*["'`]create["'`]/, "mock-simulation-environment.ts must NOT declare 'create' -- fixed topology");
  });

  it("no P26 test file fabricates FreeCAD test results -- freecad-adapter.integration.test.ts must genuinely skip (not fake-pass) when FreeCAD is unavailable", () => {
    const code = stripComments(readFileSync(join(repoRoot, "packages/adapters/test/freecad-adapter.integration.test.ts"), "utf8"));
    assert.match(code, /skip/i, "freecad-adapter.integration.test.ts must genuinely skip when a real FreeCAD installation is unavailable, never fake a pass");
  });
});

describe("real engineering agent execution phase: the browser reaches the architecture ONLY through HTTP", () => {
  /** `listTsFiles` (top of this file) only matches `.ts`, so it silently
   * misses every `.tsx` file under apps/web/src -- which is most of it.
   * A local walker that also matches `.tsx` so this guard actually
   * covers the UI, not just the handful of plain `.ts` files there. */
  function listWebSourceFiles(relativeDir: string): string[] {
    const results: string[] = [];
    const walk = (currentRelativeDir: string): void => {
      const absoluteDir = join(repoRoot, currentRelativeDir);
      for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
        const entryRelativePath = `${currentRelativeDir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(entryRelativePath);
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
          results.push(entryRelativePath);
        }
      }
    };
    walk(relativeDir);
    return results;
  }

  it("no file under apps/web/src imports @naqsh/core, @naqsh/adapters, @naqsh/model-providers, or @google/genai -- the browser must reach the architecture only through apps/api's HTTP server, never a direct package import", () => {
    // The brief's explicit boundary for the real-engineering-agent-execution
    // phase: apps/web talks to the real Plan -> Proposal -> Approve ->
    // Execute -> Verify workflow exclusively via `apps/web/src/api/client.ts`
    // (fetch calls to apps/api), never by importing the packages that
    // implement it directly. `.test.tsx` files are exempt -- they mock the
    // HTTP transport (`api/client.ts`) and are free to import real
    // `@naqsh/schemas` factories to build fixtures, but even test files
    // must not reach past the HTTP boundary into core/adapters/model-providers.
    const forbiddenPattern = /from\s+["'`](@naqsh\/core|@naqsh\/adapters|@naqsh\/model-providers|@google\/genai)["'`]/;
    for (const relativePath of listWebSourceFiles("apps/web/src")) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must not import @naqsh/core, @naqsh/adapters, @naqsh/model-providers, or @google/genai -- apps/web must reach the architecture only through apps/api's HTTP server`);
    }
  });

  it("apps/web/src/api/client.ts is the only file that talks HTTP to apps/api -- every engineering-workflow action (approve/reject/execute/rollback) goes through it, not an inline fetch elsewhere", () => {
    const clientPath = "apps/web/src/api/client.ts";
    const clientCode = readFileSync(join(repoRoot, clientPath), "utf8");
    for (const exportName of ["apiApproveProposal", "apiRejectProposal", "apiExecuteProposal", "apiRollback"]) {
      assert.match(clientCode, new RegExp(`export function ${exportName}\\(`), `${clientPath} must export ${exportName}`);
    }
    for (const relativePath of listWebSourceFiles("apps/web/src")) {
      if (relativePath === clientPath) continue;
      if (relativePath.includes("/test/")) continue;
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, /fetch\s*\(/, `${relativePath} must not call fetch() directly -- route HTTP calls through api/client.ts`);
    }
  });
});
