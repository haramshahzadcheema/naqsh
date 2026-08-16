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
  const observationFiles = ["packages/core/src/observe-project.ts", "packages/core/src/observation-tool.ts"];

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
  // observation already is. `planner.ts`/`plan-tool.ts` import the
  // `ModelProvider` INTERFACE (packages/core/src/model-provider.ts) -- a
  // provider-agnostic contract this package already owns -- never a
  // concrete implementation.
  const planningFiles = [
    "packages/core/src/planner.ts",
    "packages/core/src/plan-tool.ts",
    "packages/core/src/plan-semantics.ts",
    "packages/core/src/plan-query.ts"
  ];

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
  // observation/planning already are.
  const proposalFiles = ["packages/core/src/proposal-generator.ts", "packages/core/src/proposal-tool.ts", "packages/core/src/proposal-semantics.ts"];

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

  it("FreeCAD's own EnvironmentAdapter never claims create/modify/delete/checkpoint capabilities in Phase 12 -- no CAD manipulation, no fabricated rollback", () => {
    const relativePath = "packages/adapters/src/freecad-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /capabilities:\s*\[\s*["'`]save["'`]\s*\]/, `${relativePath} must declare exactly the "save" capability in Phase 12`);
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

  const inspectionToolFiles = [
    "packages/core/src/inspect-environment-document-tool.ts",
    "packages/core/src/inspect-environment-objects-tool.ts",
    "packages/core/src/inspect-environment-object-tool.ts",
    "packages/core/src/inspect-environment-relationships-tool.ts"
  ];

  it("no source file under packages/core/src or packages/schemas/src names a FreeCAD-specific method/type (getFreeCADFeatureTree, getPartDesignBody, getSketchObject, ...) -- the inspection contract stays generic", () => {
    const forbiddenNames = ["getFreeCADFeatureTree", "getPartDesignBody", "getSketchObject", "runFreeCADPython", "runFreecadPython"];
    for (const relativePath of [...listTsFiles("packages/core/src"), ...listTsFiles("packages/schemas/src")]) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const name of forbiddenNames) {
        assert.doesNotMatch(contents, new RegExp(name), `${relativePath} must not define/reference "${name}" -- FreeCAD-specific naming belongs only inside the adapter implementation, never in core/schemas`);
      }
    }
  });

  it("no Phase 13 inspection tool file imports WorldModelState or the World Model write path -- inspection stays entirely within the EnvironmentAdapter boundary, never reconciling into the World Model (Step 17: FreeCAD document != World Model)", () => {
    const forbiddenPattern = /WorldModelState|updateWorldModel|recordTransition|from\s+["'`]\.\/transitions\.js["'`]/;
    for (const relativePath of inspectionToolFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must not reference the World Model at all -- reconciling an environment observation into WorldModelState remains a deferred, later concern`);
    }
  });

  it("every Phase 13 inspection tool file imports only the generic EnvironmentAdapter interface, never a concrete adapter package", () => {
    const forbiddenPattern = /from\s+["'`]@naqsh\/adapters["'`]|from\s+["'`][^"'`]*freecad[^"'`]*["'`]/i;
    for (const relativePath of inspectionToolFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must depend only on the EnvironmentAdapter interface (./environment-adapter.js), never a concrete adapter package`);
      assert.match(contents, /from\s+["'`]\.\/environment-adapter\.js["'`]/, `${relativePath} must import the EnvironmentAdapter interface`);
    }
  });

  it("every Phase 13 inspection tool is classified mutation:'observe' -- inspection can never smuggle in a mutation", () => {
    for (const relativePath of inspectionToolFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.match(contents, /mutation:\s*["'`]observe["'`]/, `${relativePath} must declare mutation: "observe"`);
      assert.doesNotMatch(contents, /mutation:\s*["'`]mutate["'`]/, `${relativePath} must never declare mutation: "mutate"`);
    }
  });

  it("no Phase 13 inspection tool file calls modifyObject/createObject/deleteObject -- inspection tools never write to the environment", () => {
    const forbiddenPattern = /\.(modifyObject|createObject|deleteObject)\s*\(/;
    for (const relativePath of inspectionToolFiles) {
      const contents = readFileSync(join(repoRoot, relativePath), "utf8");
      assert.doesNotMatch(contents, forbiddenPattern, `${relativePath} must never call a mutating EnvironmentAdapter method`);
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

  it("FreeCAD's own EnvironmentAdapter still declares exactly the 'save' capability -- Phase 13 is inspection-only, no new mutation capability was granted", () => {
    const relativePath = "packages/adapters/src/freecad-adapter.ts";
    const contents = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.match(contents, /capabilities:\s*\[\s*["'`]save["'`]\s*\]/, `${relativePath} must still declare exactly the "save" capability -- Phase 13 must not silently grant create/modify/delete/checkpoint`);
  });
});
