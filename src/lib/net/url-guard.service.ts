import { Injectable } from "@nestjs/common";
import { assertSafeUrl } from "./guarded-fetch.js";
import { toRegistrableDomain } from "./registrable-domain.js";

// STORY-043 — the two STORY-131 functions a request path needs, behind an
// injectable so a caller can be unit-tested.
//
// `assertSafeUrl` RESOLVES DNS. Imported as a module function it is
// unstubbable, which would make every ProjectsService unit test perform a live
// lookup: slow, offline-broken, and — worse — quietly dependent on whether the
// hostname in the fixture happens to exist. A test written against
// `https://example-brand.test` would fail for the wrong reason while one
// against `https://hubspot.com` passed for the wrong reason.
//
// Deliberately thin. It adds no policy of its own; the rules stay in
// STORY-131's modules where the SSRF suite tests them directly.
@Injectable()
export class UrlGuard {
  /** Refuses an unsafe URL (`GuardedFetchRefusal`) and returns its registrable domain. */
  async validateAndNormalize(rawUrl: string): Promise<{ readonly rootDomain: string }> {
    await assertSafeUrl(rawUrl);
    return { rootDomain: toRegistrableDomain(rawUrl) };
  }
}
