// Types for scripts/dev-env.mjs (a dependency-free Node script, so it can run before `pnpm install`).
/** Every key that names a vendor credential. A generated .env sets none of them. */
export declare const VENDOR_KEYS: readonly string[];
/** KEY=VALUE lines into a record; comments and blank lines skipped; the first `=` splits. */
export declare function parseEnvText(text: string): Record<string, string>;
/** .env.example's text with every REPLACE_ placeholder filled by a locally generated secret, and OTP_DEV_LOG_CODES=true. */
export declare function generateDevEnv(exampleText: string): string;
export interface ComposeHostUrls {
  readonly databaseUrl: string;
  readonly databaseUrlPooled: string;
  readonly apiUrl: string;
  readonly gatewayUrl: string;
}
/** The host-side URLs of the compose stack, from the same port variables docker-compose.yml interpolates. */
export declare function composeHostUrls(env: Readonly<Record<string, string | undefined>>): ComposeHostUrls;
/** Writes `<dir>/.env` from `<dir>/.env.example` when absent; never overwrites one. Refuses a .env still holding a placeholder. */
export declare function ensureDevEnv(dir: string): { readonly created: boolean; readonly path: string };
