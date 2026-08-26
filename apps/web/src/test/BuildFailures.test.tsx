import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BuildFailures } from "../components/experiments/BuildFailures.js";
import type { BuildResult } from "@naqsh/schemas";

/**
 * The regression these tests exist for is not cosmetic: before the audit
 * a build that really failed, for a known and specific reason, produced
 * no UI at all -- indistinguishable from one that never ran.
 */
function build(overrides: Partial<BuildResult>): BuildResult {
  return { id: "build_1", projectId: "proj_1", status: "failed", operations: [], metadata: {}, ...overrides } as unknown as BuildResult;
}

describe("BuildFailures", () => {
  it("renders nothing at all when no build has failed -- no empty panel on the happy path", () => {
    const { container } = render(<BuildFailures buildResults={[build({ status: "completed" })]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the REAL adapter error, verbatim -- the exact message that was invisible before", () => {
    render(
      <BuildFailures
        buildResults={[
          build({
            operations: [
              { id: "op_1", toolName: "create_environment_object", status: "failed", error: { kind: "execution_failure", message: '"freecad" does not support "create"' } }
            ] as never
          })
        ]}
      />
    );
    expect(screen.getByText('"freecad" does not support "create"')).toBeInTheDocument();
    expect(screen.getByText("create_environment_object")).toBeInTheDocument();
  });

  it("explains a build that failed with NO operations instead of rendering an empty card", () => {
    render(<BuildFailures buildResults={[build({ metadata: { reason: "DesignSpecification has no expectedOutputs -- there is nothing to build." } as never })]} />);
    expect(screen.getByText(/no expectedOutputs/)).toBeInTheDocument();
  });

  it("counts multiple failures accurately", () => {
    render(<BuildFailures buildResults={[build({ id: "b1" }), build({ id: "b2" }), build({ id: "b3", status: "completed" })]} />);
    expect(screen.getByText("2 builds failed")).toBeInTheDocument();
  });

  it("never claims a failure reason it does not have", () => {
    render(<BuildFailures buildResults={[build({ operations: [{ id: "op_1", toolName: "x", status: "failed", error: null }] as never })]} />);
    expect(screen.getByText("Failed with no reported reason.")).toBeInTheDocument();
  });
});
