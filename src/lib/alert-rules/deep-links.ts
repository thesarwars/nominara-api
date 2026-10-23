// STORY-068 RED stub — replaced by the implementation.
import type { NotificationDeepLink } from "../../../contracts/notifications/index.js";
export interface DeepLinkFacts { readonly projectId: string | null; readonly engine?: string; readonly windowDays?: number; readonly findingId?: string; readonly displacementId?: string; readonly domain?: string }
export function alertDeepLink(_code: string, _facts: DeepLinkFacts): NotificationDeepLink { return { path: "/", query: {} }; }
