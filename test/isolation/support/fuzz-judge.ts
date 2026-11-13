// STORY-012 AC5 / ISO-08 over HTTP - the judgement of ONE replayed request, as a pure function so test/isolation/meta/fuzz-judge.spec.ts can plant each failure and
// show it is reported (the same anti-vacuity rule as live-keys.ts). http-fuzz.spec.ts only supplies the responses.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;

/** The answer with what legitimately differs per request removed: the request id (and trace id), the identifiers the request itself named, timestamps. */
export function normaliseBody(body: string, requestIds: readonly string[]): string {
  let text = body;
  try {
    const volatile = new Set(["request_id", "trace_id"]);
    const strip = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(strip)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).filter(([key]) => !volatile.has(key)).map(([key, inner]) => [key, strip(inner)]))
          : value;
    text = JSON.stringify(strip(JSON.parse(body)));
  } catch {
    // not JSON: compared as text
  }
  for (const id of requestIds) text = text.split(id).join("<requested>");
  return text.replace(UUID, "<uuid>").replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/gu, "<ts>");
}

export interface ReplayInput {
  readonly label: string;
  readonly status: number;
  readonly body: string;
  /** The identifiers the request itself named (an echo of one is not a leak). */
  readonly used: readonly string[];
  /** What "does not exist" looks like for this route (and, for a mixed-ownership replay, for this parent): status and body already normalised. */
  readonly baseline: { readonly status: number; readonly body: string };
  /** True where B's own identifier made the route answer 2xx: a foreign one must then be exactly 403 or 404. */
  readonly resolves: boolean;
  /** Every identifier that belongs to another tenant. */
  readonly foreignIds: ReadonlySet<string>;
}

/** Zero or more failures for one replay. Empty means the replay was a refusal indistinguishable from a missing identifier. */
export function judgeReplay(input: ReplayInput): string[] {
  const { label, status, body, used, baseline } = input;
  if (status >= 500) return [`${label}: a server error`];
  if (status === 429) return [`${label}: throttled, so the replay proves nothing`];
  const failures: string[] = [];
  if (status < 400 && baseline.status >= 400) failures.push(`${label}: succeeded where a missing id is refused (${String(baseline.status)})`);
  if (input.resolves && status !== 403 && status !== 404) failures.push(`${label}: a resolving route must refuse a foreign id with 403 or 404`);
  const echoed = new Set(used);
  const leaked = (body.match(UUID) ?? []).filter((id) => input.foreignIds.has(id) && !echoed.has(id));
  if (leaked.length > 0) failures.push(`${label}: the body carries a foreign identifier (${leaked[0]!})`);
  const normalised = normaliseBody(body, used);
  if (status !== baseline.status || normalised !== baseline.body) {
    failures.push(`${label}: differs from the answer for an identifier that does not exist (${String(baseline.status)}): got ${normalised.slice(0, 160)} / want ${baseline.body.slice(0, 160)}`);
  }
  return failures;
}
