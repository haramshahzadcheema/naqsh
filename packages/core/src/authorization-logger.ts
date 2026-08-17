import type { AuthorizationDecision } from "@naqsh/schemas";

/**
 * A minimal, opt-in `onDecision` implementation
 * (`CreateExecuteToolAuthorizerConfig.onDecision`, `authorization.ts`) that
 * turns every authorization decision -- allowed or denied -- into one
 * structured, JSON-serializable log record.
 *
 * `evaluateToolAuthorization`/`createExecuteToolAuthorizer` deliberately
 * expose `onDecision` as an optional hook rather than logging themselves
 * (P4's own "P4 does not persist decisions itself" design, see
 * `authorization.ts`'s doc comment) -- `core` stays free of a logging
 * framework dependency. This file does not change that: it is a small,
 * REUSABLE reference implementation of the hook, not a change to
 * `evaluateToolAuthorization`'s own behavior. A caller wires it in with
 * `createExecuteToolAuthorizer({ ..., onDecision: createAuthorizationLogger() })`.
 *
 * `sink` defaults to `console.log`; tests (and any caller that wants
 * decisions routed to a real log aggregator instead of stdout) supply
 * their own.
 */
export interface AuthorizationLogRecord {
  timestamp: string;
  decisionId: string;
  toolName: string;
  target: AuthorizationDecision["target"];
  autonomyLevel: string;
  source: string;
  requestId: string;
  allowed: boolean;
  denialReason: string | null;
  message: string;
}

export function formatAuthorizationLogRecord(decision: AuthorizationDecision): AuthorizationLogRecord {
  return {
    timestamp: decision.createdAt,
    decisionId: decision.id,
    toolName: decision.toolName,
    target: decision.target,
    autonomyLevel: decision.autonomyLevel,
    source: decision.source,
    requestId: decision.requestId,
    allowed: decision.allowed,
    denialReason: decision.denialReason,
    message: decision.message
  };
}

export function createAuthorizationLogger(sink: (line: string) => void = (line) => console.log(line)): (decision: AuthorizationDecision) => void {
  return (decision) => {
    sink(JSON.stringify(formatAuthorizationLogRecord(decision)));
  };
}
