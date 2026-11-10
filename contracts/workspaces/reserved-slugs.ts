// Owner decision 96(c), 2026-11-10 (STORY-195 AC2) - workspace addresses that can never be claimed. A short list of names that read as the
// product's own (admin, api, www, app, support, help, billing, status), plus the first path segments the router already owns on the web
// app and the API (auth, sso, sign-in, sign-up, onboarding, settings, portal, agency, v1, health, workspaces, projects, tools, p), so a
// workspace address can never shadow a route. `POST /workspaces` refuses a supplied one with `409 slug_reserved`; a slug derived from the
// name skips them. Exported so the client can warn before it asks.
export const RESERVED_WORKSPACE_SLUGS: readonly string[] = [
  "admin",
  "api",
  "www",
  "app",
  "support",
  "help",
  "billing",
  "status",
  "auth",
  "sso",
  "sign-in",
  "sign-up",
  "onboarding",
  "settings",
  "portal",
  "agency",
  "v1",
  "health",
  "workspaces",
  "projects",
  "tools",
  "p",
];

export function isReservedWorkspaceSlug(slug: string): boolean {
  return RESERVED_WORKSPACE_SLUGS.includes(slug.toLowerCase());
}
