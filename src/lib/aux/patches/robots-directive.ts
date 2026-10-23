import { isAllowed, parseRobots, type ParsedRobots, type RobotsRule } from "../robots.js";
import { AI_CRAWLER_AGENTS } from "../site-files.js";
import { unifiedDiff } from "./diff.js";
import { sha256Tag } from "./precondition.js";
import { PatchRejectedError, type PatchDraft } from "./types.js";

// STORY-053 AC5 (aux-and-geo-analysis.md section 5, schemas/geo-and-vectors.md `kind='robots'`).
//
// A crawler-directive patch is parsed and re-serialised, must parse cleanly, and must NOT REDUCE ACCESS for any agent relative to the
// file it patches. A patch that would newly block an agent is rejected outright, whichever rule produced it.
//
// The guard is on the OUTCOME. `finaliseRobotsPatch` compares the two whole files agent by agent and path by path, so it holds for
// a generator that is correct today, for one that is changed tomorrow, and for a draft nobody here wrote. A rule that fires on an
// over-permissive configuration must never be able to emit a directive that blocks an agent: that would be the product causing the
// harm it measures.

/** An agent no group names: it is bound by `*` alone, so it stands for "every agent the file does not mention". */
const UNLISTED_AGENT = "nominara-unlisted-agent";
/**
 * NOT FROM THE REFERENCE. Bounds on what the comparison will verify, chosen so it is a few tens of millions of comparisons at worst.
 * A file over them is refused rather than waved through: an unverifiable patch is not a safe one.
 */
const MAX_VERIFIABLE_RULES = 1000;
const MAX_VERIFIABLE_AGENTS = 200;

const rulesOf = (parsed: ParsedRobots): RobotsRule[] => parsed.groups.flatMap((g) => g.rules);

/** Concrete paths that exercise `pattern`: the pattern with each `*` filled in, a path below it, and the literal prefix. */
function probesFor(pattern: string): string[] {
  const body = pattern.endsWith("$") ? pattern.slice(0, -1) : pattern;
  const filled = body.replace(/\*+/g, "x");
  const prefix = body.split("*")[0]!;
  const lead = (p: string): string => (p.startsWith("/") ? p : `/${p}`);
  return [lead(filled), lead(filled + "/x"), lead(prefix)];
}

/** Throws would_reduce_access when any agent that may fetch a path in `before` may not in `after`. Any other direction passes. */
export function assertAccessNotReduced(before: string, after: string): void {
  const a = parseRobots(before);
  const b = parseRobots(after);
  if (rulesOf(a).length > MAX_VERIFIABLE_RULES || rulesOf(b).length > MAX_VERIFIABLE_RULES) {
    throw new PatchRejectedError("malformed_robots", `robots.txt has more than ${MAX_VERIFIABLE_RULES} rules, too many to verify a patch against`);
  }
  const agents = new Set<string>([...AI_CRAWLER_AGENTS.map((x) => x.toLowerCase()), "*", UNLISTED_AGENT]);
  for (const parsed of [a, b]) for (const group of parsed.groups) for (const agent of group.agents) agents.add(agent);
  if (agents.size > MAX_VERIFIABLE_AGENTS) {
    throw new PatchRejectedError("malformed_robots", `robots.txt names more than ${MAX_VERIFIABLE_AGENTS} agents, too many to verify a patch against`);
  }
  const paths = new Set<string>(["/", "/x"]);
  for (const rule of [...rulesOf(a), ...rulesOf(b)]) for (const probe of probesFor(rule.pattern)) paths.add(probe);

  for (const agent of agents) {
    for (const path of paths) {
      if (isAllowed(a, agent, path) && !isAllowed(b, agent, path)) {
        throw new PatchRejectedError("would_reduce_access", `the patch would stop ${agent} fetching ${path}`, { agent, path });
      }
    }
  }
}

export interface FinaliseRobotsInput {
  readonly ruleCode: string;
  readonly targetUrl: string;
  readonly before: string;
  readonly beforeHash: Buffer;
  /** The text to append. Starts with a newline (a blank line between groups). */
  readonly appended: string;
  readonly explanation: string;
}

/** The gate. Every robots draft passes through it. */
export function finaliseRobotsPatch(input: FinaliseRobotsInput): PatchDraft {
  const { before, appended } = input;
  // The text added to the file is the separator that starts a new line (when the file has no trailing newline) plus the block.
  const added = before === "" || before.endsWith("\n") ? appended : `\n${appended}`;
  const after = `${before}${added}`;

  const block = parseRobots(appended);
  if (block.unparseable.length > 0 || block.groups.length === 0) {
    throw new PatchRejectedError("malformed_robots", "the appended block does not parse as robots directives", { line: block.unparseable[0]?.line ?? null });
  }
  if (parseRobots(after).unparseable.length > parseRobots(before).unparseable.length) {
    throw new PatchRejectedError("malformed_robots", "the patched file has an unparseable line the original did not");
  }
  assertAccessNotReduced(before, after);

  return {
    ruleCode: input.ruleCode,
    kind: "robots",
    targetUrl: input.targetUrl,
    contentBeforeHash: input.beforeHash,
    contentAfter: after,
    unifiedDiff: unifiedDiff("robots.txt", before, after),
    jsonldBlocks: null,
    reversal: { operation: "remove_block", content: added },
    preconditions: [{ kind: "file_hash", value: sha256Tag(input.beforeHash) }],
    explanation: input.explanation,
    derivation: "Nominara template: one Allow block per AI crawler token the file currently excludes. The only site-derived content is the file's own wildcard restrictions, carried over unchanged.",
    requiresHumanReview: false,
    reviewReason: null,
    riskFlags: [],
  };
}

const lineOf = (rule: RobotsRule): string => [rule.allow ? "Allow" : "Disallow", rule.pattern].join(": ");
const isRootDisallow = (rule: RobotsRule): boolean => !rule.allow && (rule.pattern === "/" || rule.pattern === "/*");

export interface BuildRobotsInput {
  readonly ruleCode: string;
  readonly targetUrl: string;
  readonly body: string;
  /** sha256 of the bytes as fetched (the audit's `robots_hash`). */
  readonly bodyHash: Buffer;
}

/**
 * AUX-R-001 / AUX-R-002: open the AI crawler tokens the file excludes. null when there is nothing to open.
 *
 * A token the file NAMES already has its own group, so an `Allow: /` appended to it wins the tie against a `Disallow: /`. A token the
 * file does not name inherits `*`, and a group that names it REPLACES `*` for it: so its block carries over the wildcard's other rules,
 * or opening "/" would also open the paths the site restricted for everyone.
 */
export function buildRobotsPatch(input: BuildRobotsInput): PatchDraft | null {
  const parsed = parseRobots(input.body);
  const wildcardRules = parsed.groups.filter((g) => g.agents.includes("*")).flatMap((g) => g.rules);
  const restrictiveWildcard = wildcardRules.some((r) => !r.allow && r.pattern !== "");
  const carried = wildcardRules.filter((r) => !isRootDisallow(r) && r.pattern !== "");

  const blocks: string[] = [];
  const opened: string[] = [];
  for (const agent of AI_CRAWLER_AGENTS) {
    const named = parsed.groups.some((g) => g.agents.includes(agent.toLowerCase()));
    const blockedAtRoot = !isAllowed(parsed, agent, "/");
    const inherits = !named && restrictiveWildcard;
    if (!blockedAtRoot && !(input.ruleCode === "AUX-R-002" && inherits)) continue;
    const lines = [`User-agent: ${agent}`, ...(named ? [] : carried.map(lineOf)), "Allow: /"];
    blocks.push(lines.join("\n"));
    opened.push(agent);
  }
  if (blocks.length === 0) return null;

  const draft = finaliseRobotsPatch({
    ruleCode: input.ruleCode,
    targetUrl: input.targetUrl,
    before: input.body,
    beforeHash: input.bodyHash,
    appended: `\n${blocks.join("\n\n")}\n`,
    explanation:
      `${opened.join(", ")} ${opened.length === 1 ? "is" : "are"} currently excluded by robots.txt. ` +
      "Explicit Allow blocks for named agents take precedence in every major crawler's matching algorithm.",
  });
  // A patch that does not do what it says is worse than none: every token it claims to open must now be allowed at the root.
  const after = parseRobots(draft.contentAfter);
  const stillBlocked = opened.filter((agent) => !isAllowed(after, agent, "/"));
  if (stillBlocked.length > 0) {
    throw new PatchRejectedError("ineffective", `an Allow: / block would not open ${stillBlocked.join(", ")}`, { agents: stillBlocked });
  }
  return draft;
}
