import type { BuildResult } from "@naqsh/schemas";

/**
 * Failed builds, with the REAL adapter error that caused each one.
 *
 * AUDIT FIX. Before this, `BuildResult`s were persisted server-side,
 * carried a precise error message, and were rendered nowhere at all --
 * there wasn't even an endpoint to fetch them. Reproduced live: three
 * consecutive candidate builds failed with
 * `"freecad" does not support "create"`, and the workspace showed
 * nothing whatsoever. The exploration simply looked like it had done
 * nothing, which is the single most misleading state this app could
 * present: real work was attempted, it really failed, and the reason was
 * known and specific the whole time.
 *
 * Renders nothing when no build has failed -- an empty "no failures"
 * panel would just be noise on the happy path.
 */
export function BuildFailures({ buildResults }: { buildResults: BuildResult[] }): JSX.Element | null {
  const failed = buildResults.filter((build) => build.status === "failed");
  if (failed.length === 0) return null;

  return (
    <section className="build-failures" aria-label="Failed builds">
      <h2 className="view-section-title">
        {failed.length === 1 ? "1 build failed" : `${failed.length} builds failed`}
      </h2>
      <ul className="build-failures__list">
        {failed.map((build) => {
          // A build can fail with NO operations at all -- the honest
          // "this specification had nothing to build" case the backend
          // deliberately refuses to report as a success. Say that
          // plainly rather than rendering an empty card.
          const failedOperations = build.operations.filter((operation) => operation.status === "failed");
          const reason = typeof build.metadata?.reason === "string" ? build.metadata.reason : null;

          return (
            <li key={build.id} className="build-failures__item">
              <div className="build-failures__head">
                <span className="badge badge--danger">failed</span>
                <span className="mono build-failures__id">{build.id}</span>
              </div>

              {failedOperations.length > 0 ? (
                <ul className="build-failures__ops">
                  {failedOperations.map((operation) => (
                    <li key={operation.id} className="build-failures__op">
                      <span className="mono build-failures__tool">{operation.toolName}</span>
                      <span className="build-failures__message">{operation.error?.message ?? "Failed with no reported reason."}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="build-failures__message">{reason ?? "This build produced no operations and no reported reason."}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
