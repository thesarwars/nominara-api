import cookie from "@fastify/cookie";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

// STORY-017 — nothing in the repo parses/sets cookies before this story.
// Extracted so `main.ts` and every test that builds a NestFastifyApplication
// register the plugin identically, rather than re-deriving the call.
export async function registerCookiePlugin(app: NestFastifyApplication): Promise<void> {
  await app.register(cookie);
}
