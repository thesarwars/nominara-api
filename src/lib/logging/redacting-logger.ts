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
// `ip-10-0-12-7.ec2.internal`, `queue-valkey.test.invalid`: lowercase DNS labels ending in an alphabetic label. Real hostnames
// are what connection errors are about, and they score as high-entropy.
const HOSTNAME = /^(?=.{3,80}$)(?:[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?\.)+[a-z]{2,24}$/u;
// A token is judged without the quotes, brackets and sentence punctuation around it: `"rollup.category_benchmark"` and
// `(getaddrinfo` are the same word as without them. The wrappers are kept in the output.
const WRAPPER = /^([("'`[{<,;:]*)(.*?)([)"'`\]}>,;:.!?]*)$/su;
const BEARER = /\b(Bearer|Basic)\s+\S+/giu;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):[^\s@]+@/giu;
const URL_QUERY_PARAM = /([?&])([^=&\s#]+)=([^&\s#]*)/gu;

// `password: x`, `"apiKey":"x"`, `x-api-key: x`, `secret=x`: a key, optional quotes, `:` or `=`, then a quoted or bare value. Only a
// key the deny-list matches is touched (the callback decides), and the key and quotes are kept so the line stays readable.
const KEY_VALUE = /(["']?)([\w.-]+)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',;&}\]]+)/gu;
// A prefixed identifier is `name:uuid`, `queue/uuid`, `ws:uuid`: every `:` / `/` segment is a UUID or a plain word.
const WORD = /^[a-z]{1,16}(?:[_.-][a-z]{1,16})*$/u;

// `audit-export-2026-11-16T02-55-00-123Z.jsonl`: a file or directory name of short lowercase words, numbers and timestamp
// fragments joined by `-` `_` `.`. A random path secret is one unbroken mixed run, so it has no such parts.
const PATH_NAME_PART = /^(?:[a-z]{1,16}|\d{1,6}|\d{2}T\d{2}|\d{3}Z)$/u;

const isUuid = (value: string): boolean => UUID.test(value);
const isIdentifierShaped = (value: string): boolean => isUuid(value) || WORDS_NAME.test(value) || HOSTNAME.test(value);

/** A key=value value: secret by the deny-list on its key, or by entropy. Identifiers and plain numbers are not. */
function valueIsSecret(key: string, value: string): boolean {
  if (value === "" || NUMERIC.test(value)) return false;
  if (SECRET_KEY_PATTERN.test(key)) return !(ID_KEY.test(key) && isUuid(value));
  return !isIdentifierShaped(value) && isHighEntropySecret(value);
}

function redactKeyValues(text: string): string {
  return text.replace(KEY_VALUE, (whole, quote: string, key: string, glue: string, raw: string) => {
    if (!SECRET_KEY_PATTERN.test(key) || raw === REDACTED) return whole;
    const wrapper = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : "";
    const value = wrapper === "" ? raw : raw.slice(1, -1);
    if (value === REDACTED || !valueIsSecret(key, value)) return whole;
    return `${quote}${key}${quote}${glue}${wrapper}${REDACTED}${wrapper}`;
  });
}

function isPrefixedIdentifier(token: string): boolean {
  const segments = token.split(/[:/]/u);
  return segments.length > 1 && segments.every((segment) => isUuid(segment) || WORD.test(segment));
}

/** `scheme://host/seg/seg?query`: scheme and host are kept; each path segment is judged on its own; query params by key. */
function redactUrl(token: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)(.*)$/isu.exec(token);
  if (match === null) return token;
  const [, origin = "", path = "", rest = ""] = match;
  const safePath = path
    .split("/")
    .map((segment) => (segment === "" || STACK_LOCATION.test(segment) || isIdentifierShaped(segment) || segment.split(/[-_.]/u).every((part) => PATH_NAME_PART.test(part)) ? segment : isHighEntropySecret(segment) ? REDACTED : segment))
    .join("/");
  const safeRest = rest.replace(URL_QUERY_PARAM, (whole, sep: string, key: string, value: string) => (valueIsSecret(key, value) ? `${sep}${key}=${REDACTED}` : whole));
  return `${origin}${safePath}${safeRest}`;
}

function redactToken(token: string): string {
  const [, open = "", core = token, close = ""] = WRAPPER.exec(token) ?? [];
  return core === "" ? token : `${open}${redactCore(core)}${close}`;
}

function redactCore(token: string): string {
  if (token.includes("://")) {
    return redactUrl(token);
  }
  if (STACK_LOCATION.test(token) || isIdentifierShaped(token) || isPrefixedIdentifier(token)) return token;
  const eq = token.indexOf("=");
  if (eq > 0) {
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    return valueIsSecret(key, value) ? `${key}=${REDACTED}` : token;
  }
  return isHighEntropySecret(token) ? REDACTED : token;
}

export function redactLogString(text: string): string {
  const keyed = redactKeyValues(text.replace(BEARER, `$1 ${REDACTED}`).replace(URL_CREDENTIALS, `$1:${REDACTED}@`));
  // A token is split at each redaction already made, so a marker inside `{"apiKey":"[redacted]"}` does not make the
  // entropy check blank the whole token, and a second secret in the same token is still judged.
  return keyed.replace(/\S+/gu, (token) => (token.includes("://") ? redactToken(token) : token.split(REDACTED).map(redactToken).join(REDACTED)));
}

function redactEntry(key: string, child: unknown, seen: WeakSet<object>): unknown {
  const secretKey = SECRET_KEY_PATTERN.test(key);
  if (!secretKey || child === null || child === undefined || typeof child === "number" || typeof child === "boolean") return redact(child, seen);
  if (ID_KEY.test(key) && typeof child === "string" && isUuid(child)) return child;
  if (typeof child === "string" || typeof child === "object") return REDACTED;
  return redact(child, seen);
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
      // code, detail, constraint, statusCode, $metadata: the properties that say WHY it failed. Each goes through the same
      // per-key rules as a plain object. `cause` is non-enumerable when set by the constructor, so it is read explicitly.
      for (const [key, child] of Object.entries(value)) {
        if (key !== "message" && key !== "stack") Object.assign(copy, { [key]: redactEntry(key, child, seen) });
      }
      if ("cause" in value && value.cause !== undefined) {
        Object.defineProperty(copy, "cause", { value: redact(value.cause, seen), enumerable: false, writable: true, configurable: true });
      }
      return copy;
    }
    if (Array.isArray(value)) return value.map((item) => redact(item, seen));
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) result[key] = redactEntry(key, child, seen);
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
