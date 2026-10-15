import type { Env } from "../../config/env.schema.js";

// Group C item 3 — the resolved storage configuration. The env schema validates the raw variables at boot
// (src/config/env.schema.ts); this turns them into the one object the adapter and the tenant layer take.
//
// null means NOT CONFIGURED: the API boots (like Stripe and the portal) and every storage call then answers 503
// `degraded` - it fails closed, it never falls back to some default endpoint or to the local disk.

export type StorageSse = "AES256" | "aws:kms";

export interface StorageConfig {
  /** Unset = the AWS regional endpoint. LocalStack sets it (http://localhost:4566), and that is the ONLY production difference. */
  readonly endpoint?: string;
  readonly region: string;
  /** LocalStack needs path-style (bucket in the path); AWS does not. */
  readonly forcePathStyle: boolean;
  readonly buckets: { readonly raw: string; readonly reports: string };
  /** Unset = the SDK's default credential chain (an IAM role in production: no static keys, security-and-tenancy.md). */
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly sse: StorageSse;
  readonly kmsKeyId?: string;
  /** The `{env}` segment of every key (system-architecture.md section 6). Defaults to NODE_ENV. */
  readonly keyEnv: string;
}

type StorageEnv = Partial<
  Pick<
    Env,
    | "NODE_ENV"
    | "STORAGE_ENDPOINT"
    | "STORAGE_REGION"
    | "STORAGE_BUCKET_RAW"
    | "STORAGE_BUCKET_REPORTS"
    | "STORAGE_ACCESS_KEY_ID"
    | "STORAGE_SECRET_ACCESS_KEY"
    | "STORAGE_FORCE_PATH_STYLE"
    | "STORAGE_SSE"
    | "STORAGE_KMS_KEY_ID"
    | "STORAGE_KEY_ENV"
  >
>;

export function resolveStorageConfig(env: StorageEnv): StorageConfig | null {
  if (env.STORAGE_BUCKET_RAW === undefined || env.STORAGE_BUCKET_REPORTS === undefined) return null;

  // Built so that JSON.stringify / String / util.inspect of the config can never print the secret: the credential
  // pair is a non-enumerable property. Credentials are never logged (Group C item 3).
  const config: { -readonly [K in keyof StorageConfig]: StorageConfig[K] } = {
    ...(env.STORAGE_ENDPOINT !== undefined ? { endpoint: env.STORAGE_ENDPOINT } : {}),
    region: env.STORAGE_REGION ?? "us-east-1",
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE === "true",
    buckets: { raw: env.STORAGE_BUCKET_RAW, reports: env.STORAGE_BUCKET_REPORTS },
    sse: env.STORAGE_SSE ?? "aws:kms",
    ...(env.STORAGE_KMS_KEY_ID !== undefined ? { kmsKeyId: env.STORAGE_KMS_KEY_ID } : {}),
    keyEnv: env.STORAGE_KEY_ENV ?? env.NODE_ENV ?? "development",
  };
  if (env.STORAGE_ACCESS_KEY_ID !== undefined && env.STORAGE_SECRET_ACCESS_KEY !== undefined) {
    Object.defineProperty(config, "credentials", {
      value: { accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY },
      enumerable: false,
    });
  }
  return config;
}
