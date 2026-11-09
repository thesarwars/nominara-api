import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Pool } from "pg";
import {
  FINGERPRINT_BUDGET_MS,
  LOW_CONFIDENCE_THRESHOLD,
  type FingerprintRequest,
  type FingerprintResponse,
} from "../../../contracts/projects/index.js";
import { UnsafeTargetError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { loadEnv } from "../../config/env.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { classifyCategory, type TextEmbedder } from "../../lib/categories/classify.js";
import { loadTaxonomy } from "../../lib/categories/taxonomy.js";
import { classificationTextFromHtml } from "../../lib/discovery/discover.js";
import { detectPlatform } from "../../lib/discovery/platform.js";
import { GuardedFetchRefusal, guardedFetch } from "../../lib/net/guarded-fetch.js";
import { UnparsableHostError } from "../../lib/net/registrable-domain.js";
import { UrlGuard } from "../../lib/net/url-guard.service.js";
import { NOMINARA_USER_AGENT } from "../../lib/net/user-agent.js";
import { textEmbedderFor } from "../../lib/queue/handlers/embed-batch.handler.js";
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
// THE CATEGORY (decisions 88 and 92). The taxonomy is STORY-189's. The category is the nearest match of the page's text to it, by the SAME classifier and the
// SAME text `crawl.discover` uses, and the SAME 0.60 line (LOW_CONFIDENCE_THRESHOLD): below it there is no category value. The taxonomy read (a global table, one
// pool query, no transaction) and the embedding call run under the SAME single deadline as the fetch, never a second one, and a failure or the deadline
// leaves the category absent: the page was still read, so the answer is `complete`, and `category` stays in `not_derived` ("could not say"). A confident or
// low-confidence answer is a looked-and-decided one, so `category` leaves `not_derived`. The provider is reached through `textEmbedderFor`, the one
// function the embed.batch file exports for it (NFR-ARCH-01), as alignment's request path already reaches `selectedEmbeddingModel`.
//
// WHAT IT CANNOT SAY. The verticals are not derived (the taxonomy carries no verticals); the response names them in `not_derived`.

type FetchPage = typeof guardedFetch;
export const FINGERPRINT_FETCH = Symbol("FINGERPRINT_FETCH");
export const FINGERPRINT_EMBEDDER = Symbol("FINGERPRINT_EMBEDDER");

type CategoryOutcome = "proposed" | "low_confidence" | "none" | "absent" | "skipped";

const tracer = trace.getTracer("nominara.projects");

@Injectable()
export class ProjectFingerprintService {
  private readonly logger = new Logger(ProjectFingerprintService.name);

  constructor(
    private readonly urls: UrlGuard,
    @Optional() @Inject(FINGERPRINT_FETCH) private readonly fetchPage: FetchPage = guardedFetch,
    @Optional() @Inject(PG_POOL) private readonly pool?: Pool,
    @Optional() @Inject(FINGERPRINT_EMBEDDER) private embedder?: TextEmbedder,
  ) {}

  async fingerprint(input: FingerprintRequest): Promise<FingerprintResponse> {
    return tracer.startActiveSpan("projects.fingerprint", async (span) => {
      const started = performance.now();
      try {
        // Preflight (the SSRF guard resolves DNS and opens no socket) and fetch run under ONE deadline.
        const budget = this.startBudget();
        let read;
        let category: { value: string; confidence: number } | null = null;
        let categoryOutcome: CategoryOutcome = "skipped";
        try {
          read = await this.read(input.root_url, budget.expired);
          if (read.kind === "html") {
            const classified = await this.classify(read.html, budget.expired);
            category = classified.category;
            categoryOutcome = classified.outcome;
          }
        } finally {
          budget.stop();
        }
        const durationMs = Math.round(performance.now() - started);
        const platform = read.kind === "html" ? detectPlatform(read.html) : undefined;
        // Verticals are never derived. The category leaves `not_derived` exactly when it was decided (proposed, or too uncertain to propose).
        const categoryDecided = categoryOutcome === "proposed" || categoryOutcome === "low_confidence" || categoryOutcome === "none";
        const response: FingerprintResponse = {
          root_url: input.root_url,
          status: read.kind === "html" ? "complete" : "unavailable",
          reason: read.kind === "html" ? null : read.reason,
          category,
          verticals: [],
          platform: platform === undefined ? null : { value: platform.value, confidence: platform.confidence },
          not_derived: categoryDecided ? ["verticals"] : ["category", "verticals"],
          duration_ms: durationMs,
          credits_charged: 0,
        };
        incrementCounter("nominara_projects_fingerprint_total", { status: response.status, reason: response.reason ?? "none" });
        observeValue("nominara_projects_fingerprint_duration_ms", durationMs, { status: response.status });
        if (read.kind === "html") incrementCounter("nominara_projects_fingerprint_category_total", { outcome: categoryOutcome });
        // Never the URL, the host or page text: the line says what happened, not about whom.
        this.logger.log({ event: "project.fingerprint", status: response.status, reason: response.reason, platform: platform?.value ?? null, category_outcome: categoryOutcome, duration_ms: durationMs });
        return response;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /** The ONE deadline of the request: it starts here and covers the preflight, the fetch, the taxonomy read and the embedding. */
  private startBudget(): { expired: Promise<"budget">; stop: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"budget">((resolve) => {
      timer = setTimeout(() => resolve("budget"), FINGERPRINT_BUDGET_MS);
    });
    return { expired, stop: () => clearTimeout(timer) };
  }

  /**
   * The SSRF preflight, then the root document, under the ONE deadline, or why the page could not be read. A real refusal (address, port,
   * scheme) throws 422; a name that does not resolve is a site-side problem and an ANSWER (`unreachable`), like a dead host. Never carries an error's message.
   */
  private async read(rootUrl: string, expired: Promise<"budget">): Promise<{ kind: "html"; html: string } | { kind: "unavailable"; reason: "budget_exceeded" | "unreachable" | "http_error" | "not_html" }> {
    const result = await Promise.race([this.preflightThenFetch(rootUrl), expired]);
    return result === "budget" ? { kind: "unavailable", reason: "budget_exceeded" } : result;
  }

  /**
   * The category suggestion: the taxonomy nearest match of the page's text, inside what is left of the ONE deadline. No tenant transaction is open on this route.
   * Never throws: a provider failure, an unconfigured provider or the deadline leave the category absent (`absent`); an empty taxonomy is the same.
   */
  private async classify(html: string, expired: Promise<"budget">): Promise<{ category: { value: string; confidence: number } | null; outcome: CategoryOutcome }> {
    const pool = this.pool;
    if (pool === undefined) return { category: null, outcome: "skipped" };
    return tracer.startActiveSpan("projects.fingerprint.classify_category", async (span) => {
      try {
        const work = (async () => {
          const taxonomy = await loadTaxonomy(pool);
          if (taxonomy.length === 0) return "failed" as const;
          return classifyCategory(classificationTextFromHtml(html), taxonomy, (this.embedder ??= textEmbedderFor(loadEnv())));
        })().catch(() => "failed" as const);
        const result = await Promise.race([work, expired]);
        if (result === "budget" || result === "failed") {
          span.setAttribute("nominara.fingerprint.category_outcome", "absent");
          return { category: null, outcome: "absent" as const };
        }
        if (result === null) return { category: null, outcome: "none" as const };
        if (result.confidence < LOW_CONFIDENCE_THRESHOLD) return { category: null, outcome: "low_confidence" as const };
        return { category: { value: result.slug, confidence: result.confidence }, outcome: "proposed" as const };
      } finally {
        span.end();
      }
    });
  }

  private async preflightThenFetch(rootUrl: string): Promise<{ kind: "html"; html: string } | { kind: "unavailable"; reason: "unreachable" | "http_error" | "not_html" }> {
    try {
      await this.urls.validateAndNormalize(rootUrl);
    } catch (error) {
      if (error instanceof GuardedFetchRefusal) {
        if (error.reason === "dns_resolution_failed") return { kind: "unavailable", reason: "unreachable" };
        throw new UnsafeTargetError({ message: "this URL cannot be fetched", details: { reason: error.reason } });
      }
      if (error instanceof UnparsableHostError) {
        throw new ValidationFailedError({ message: "root_url has no registrable domain", details: { issues: [{ path: ["root_url"], message: "not a domain anyone can own" }] } });
      }
      throw error;
    }
    const result = await this.fetchPage(rootUrl, { headers: { "user-agent": NOMINARA_USER_AGENT, accept: "text/html,application/xhtml+xml" }, truncateAtCap: true }).catch(() => "failed" as const);
    if (result === "failed") return { kind: "unavailable", reason: "unreachable" };
    if (result.status < 200 || result.status >= 300) return { kind: "unavailable", reason: "http_error" };
    const type = String(Array.isArray(result.headers["content-type"]) ? result.headers["content-type"][0] : (result.headers["content-type"] ?? "")).toLowerCase();
    if (!type.includes("html")) return { kind: "unavailable", reason: "not_html" };
    return { kind: "html", html: result.body.toString("utf8") };
  }
}
