import { ConsoleLogger } from "@nestjs/common";
import { isHighEntropySecret, REDACTED, SECRET_KEY_PATTERN } from "../crypto/redact.js";

// STORY-005 AC2 - the redaction transport. Every line the application logs passes through the SAME deny-list and
// high-entropy detector the audit chain uses (src/lib/crypto/redact.ts), so no build logs a secret. Wired where the
// logger is constructed (main.ts, worker.ts, gateway.ts), which is before any application code runs.
//
// It is NOT redactState(): that function is shaped for audit rows, and applied to logs it would strip what operators
// and tests read. Two deliberate differences, each pinned by redacting-logger.spec.ts:
//  - an identifier is not a secret. A UUID is exempt from the entropy detector (a random UUID scores like a secret),
//    and a UUID under an `*_id` key is exempt from the key deny-list (`share_token_id` matches `token`).
//  - only a STRING can be a credential. A number or boolean under `tokens_in` or `token_count` is a count; the audit
//    redactor blanks it, here it survives (and null / 0 / undefined stay distinct).
// A free-text line is scanned token by token, because a secret in prose has whitespace around it and the whole-value
// detector skips anything containing whitespace.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ID_KEY = /(?:^ids?|_ids?|Ids?)$/u;
const NUMERIC = /^-?\d+(?:\.\d+)?$/u;
// `at Foo (/app/src/x.service.ts:12:3)` - a path is long and high-entropy but is the point of a stack trace.
const STACK_LOCATION = /^\(?(?:file:\/\/)?[\w@./\\-]+:\d+(?::\d+)?\)?$/u;
// `nominara_billing_addon_change_total`, `workspace.deletion_scheduled`: a name made of short lowercase WORDS joined by
// separators. It scores as high-entropy and is exactly what a metric line and an event name are made of. A random
// secret does not look like this: it has digits or capitals, or one long unbroken run (each word is capped at 16).
const WORDS_NAME = /^[a-z]{1,16}(?:[_.:-][a-z]{1,16})+$/u;
const BEARER = /\b(Bearer|Basic)\s+\S+/giu;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):[^\s@]+@/giu;
const URL_QUERY_PARAM = /([?&])([^=&\s#]+)=([^&\s#]*)/gu;

const isUuid = (value: string): boolean => UUID.test(value);
const isIdentifierShaped = (value: string): boolean => isUuid(value) || WORDS_NAME.test(value);

/** A key=value value: secret by the deny-list on its key, or by entropy. Identifiers and plain numbers are not. */
function valueIsSecret(key: string, value: string): boolean {
  if (value === "" || NUMERIC.test(value)) return false;
  if (SECRET_KEY_PATTERN.test(key)) return !(ID_KEY.test(key) && isUuid(value));
  return !isIdentifierShaped(value) && isHighEntropySecret(value);
}

function redactToken(token: string): string {
  if (token.includes("://")) {
    return token.replace(URL_QUERY_PARAM, (whole, sep: string, key: string, value: string) => (valueIsSecret(key, value) ? `${sep}${key}=${REDACTED}` : whole));
  }
  if (STACK_LOCATION.test(token) || isIdentifierShaped(token)) return token;
  const eq = token.indexOf("=");
  if (eq > 0) {
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    return valueIsSecret(key, value) ? `${key}=${REDACTED}` : token;
  }
  return isHighEntropySecret(token) ? REDACTED : token;
}

export function redactLogString(text: string): string {
  return text
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(URL_CREDENTIALS, `$1:${REDACTED}@`)
    .replace(/\S+/gu, redactToken);
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactLogString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (value instanceof Error) {
      const copy = new Error(redactLogString(value.message));
      copy.name = value.name;
      if (value.stack !== undefined) copy.stack = redactLogString(value.stack);
      return copy;
    }
    if (Array.isArray(value)) return value.map((item) => redact(item, seen));
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const secretKey = SECRET_KEY_PATTERN.test(key);
      if (!secretKey || child === null || child === undefined || typeof child === "number" || typeof child === "boolean") {
        result[key] = redact(child, seen);
      } else if (ID_KEY.test(key) && typeof child === "string" && isUuid(child)) {
        result[key] = child;
      } else if (typeof child === "string" || typeof child === "object") {
        result[key] = REDACTED;
      } else {
        result[key] = redact(child, seen);
      }
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Redacts one log argument (a message, an object, an Error) without mutating it. */
export function redactLogArgument(value: unknown): unknown {
  return redact(value, new WeakSet());
}

function redactArguments(message: unknown, optionalParams: unknown[]): [unknown, unknown[]] {
  // Nest's Logger appends the context as the LAST parameter; a context is a class name, never a secret, and a long
  // CamelCase one can score as high-entropy.
  const last = optionalParams.length - 1;
  const hasContext = last >= 0 && typeof optionalParams[last] === "string";
  return [
    redactLogArgument(message),
    optionalParams.map((param, index) => (hasContext && index === last ? param : redactLogArgument(param))),
  ];
}

export class RedactingLogger extends ConsoleLogger {
  override log(message: unknown, ...optionalParams: unknown[]): void {
    const [m, rest] = redactArguments(message, optionalParams);
    super.log(m, ...rest);
  }
  override error(message: unknown, ...optionalParams: unknown[]): void {
    const [m, rest] = redactArguments(message, optionalParams);
    super.error(m, ...rest);
  }
  override warn(message: unknown, ...optionalParams: unknown[]): void {
    const [m, rest] = redactArguments(message, optionalParams);
    super.warn(m, ...rest);
  }
  override debug(message: unknown, ...optionalParams: unknown[]): void {
    const [m, rest] = redactArguments(message, optionalParams);
    super.debug(m, ...rest);
  }
  override verbose(message: unknown, ...optionalParams: unknown[]): void {
    const [m, rest] = redactArguments(message, optionalParams);
    super.verbose(m, ...rest);
  }
  override fatal(message: unknown, ...optionalParams: unknown[]): void {
    const [m, rest] = redactArguments(message, optionalParams);
    super.fatal(m, ...rest);
  }
}
