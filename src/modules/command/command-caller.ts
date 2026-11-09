import type { ExecuteMembership } from "../../lib/command/execute-access.js";

/**
 * Who is asking, as the controller read it from the request the guards already validated. Passed explicitly so the
 * service has no request object and a test can build any caller (a viewer, a scoped manager) without a guard chain.
 */
export interface CommandCaller {
  readonly workspaceId: string;
  /** The tenant context's actor: the user (or key actor) the parse id is bound to. */
  readonly actorId: string;
  readonly membership: ExecuteMembership | undefined;
  readonly lastStrongAuthAt: Date | null;
}
