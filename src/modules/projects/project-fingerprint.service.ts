import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  FINGERPRINT_BUDGET_MS,
  type FingerprintRequest,
  type FingerprintResponse,
} from "../../../contracts/projects/index.js";
import { UnsafeTargetError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { detectPlatform } from "../../lib/discovery/platform.js";
import { GuardedFetchRefusal, guardedFetch } from "../../lib/net/guarded-fetch.js";
import { UnparsableHostError } from "../../lib/net/registrable-domain.js";
import { UrlGuard } from "../../lib/net/url-guard.service.js";
import { NOMINARA_USER_AGENT } from "../../lib/net/user-agent.js";
import { incrementCounter, observeValue } from "../../lib/telemetry/metrics.js";

// STORY-195, owner decision 87(b): `POST /projects/fingerprint`, a free, pre-creation suggestion for a root URL (FR-ONB-04).
//
// THE ONE REQUEST-PATH FETCH, AND WHY IT IS SAFE TO ALLOW. NFR-ARCH-01 says a request handler enqueues and never fetches a crawl target; the owner
// decided this endpoint answers inline ("bounded in time", STORY-195), because a suggestion that arrives after the user has moved on is no suggestion.
// What keeps the exception small:
//   - the route is TENANT-LESS (`@SkipTenantContext()`), so no database transaction is open, and none is opened here (ADR-0003: nothing waits on an
//     external service inside a transaction). This service touches no table at all;
//   - the URL passes the SSRF guard BEFORE any socket is opened, and the fetch is the guarded one (scheme, port, address and redirect rules);
//   - the wait is capped at FINGERPRINT_BUDGET_MS, below the fetcher's own 20 s ceiling, and a slow or dead site is an ANSWER (`unavailable`), not an
//     error: onboarding is submittable without it (FR-ONB-04);
//   - one page, the root document, once. It writes nothing and charges nothing.
//
// WHAT IT CANNOT SAY. The category and the verticals are not derived (the taxonomy is STORY-189, not built); the response names them in `not_derived`.

type FetchPage = typeof guardedFetch;
export const FINGERPRINT_FETCH = Symbol("FINGERPRINT_FETCH");

const tracer = trace.getTracer("nominara.projects");

@Injectable()
export class ProjectFingerprintService {
  private readonly logger = new Logger(ProjectFingerprintService.name);

  constructor(
    private readonly urls: UrlGuard,
    @Optional() @Inject(FINGERPRINT_FETCH) private readonly fetchPage: FetchPage = guardedFetch,
  ) {}

  async fingerprint(input: FingerprintRequest): Promise<FingerprintResponse> {
    return tracer.startActiveSpan("projects.fingerprint", async (span) => {
      const started = performance.now();
      try {
        // The SSRF guard resolves DNS and opens no socket: an unsafe URL is refused before anything is requested.
        try {
          await this.urls.validateAndNormalize(input.root_url);
        } catch (error) {
          if (error instanceof GuardedFetchRefusal) {
            throw new UnsafeTargetError({ message: "this URL cannot be fetched", details: { reason: error.reason } });
          }
          if (error instanceof UnparsableHostError) {
            throw new ValidationFailedError({ message: "root_url has no registrable domain", details: { issues: [{ path: ["root_url"], message: "not a domain anyone can own" }] } });
          }
          throw error;
        }

        const read = await this.read(input.root_url);
        const durationMs = Math.round(performance.now() - started);
        const platform = read.kind === "html" ? detectPlatform(read.html) : undefined;
        const response: FingerprintResponse = {
          root_url: input.root_url,
          status: read.kind === "html" ? "complete" : "unavailable",
          reason: read.kind === "html" ? null : read.reason,
          category: null,
          verticals: [],
          platform: platform === undefined ? null : { value: platform.value, confidence: platform.confidence },
          not_derived: ["category", "verticals"],
          duration_ms: durationMs,
          credits_charged: 0,
        };
        incrementCounter("nominara_projects_fingerprint_total", { status: response.status, reason: response.reason ?? "none" });
        observeValue("nominara_projects_fingerprint_duration_ms", durationMs, { status: response.status });
        // Never the URL, the host or page text: the line says what happened, not about whom.
        this.logger.log({ event: "project.fingerprint", status: response.status, reason: response.reason, platform: platform?.value ?? null, duration_ms: durationMs });
        return response;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /** The root document, or why it could not be read. Never throws for a site-side problem, and never carries the underlying error's message. */
  private async read(rootUrl: string): Promise<{ kind: "html"; html: string } | { kind: "unavailable"; reason: "budget_exceeded" | "unreachable" | "http_error" | "not_html" }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<"budget">((resolve) => {
      timer = setTimeout(() => resolve("budget"), FINGERPRINT_BUDGET_MS);
    });
    try {
      const attempt = this.fetchPage(rootUrl, { headers: { "user-agent": NOMINARA_USER_AGENT, accept: "text/html,application/xhtml+xml" }, truncateAtCap: true }).catch(() => "failed" as const);
      const result = await Promise.race([attempt, budget]);
      if (result === "budget") return { kind: "unavailable", reason: "budget_exceeded" };
      if (result === "failed") return { kind: "unavailable", reason: "unreachable" };
      if (result.status < 200 || result.status >= 300) return { kind: "unavailable", reason: "http_error" };
      const type = String(Array.isArray(result.headers["content-type"]) ? result.headers["content-type"][0] : (result.headers["content-type"] ?? "")).toLowerCase();
      if (!type.includes("html")) return { kind: "unavailable", reason: "not_html" };
      return { kind: "html", html: result.body.toString("utf8") };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
