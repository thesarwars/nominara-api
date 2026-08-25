// STORY-024 T10 — every non-exempt success response is now wrapped in
// api-specification.md §1's envelope, `{ data, pagination?, meta }`. Tests
// that assert on the RESOURCE read it through here rather than reaching for
// `.json().something`, so the unwrapping has one definition.
export function dataOf<T>(response: { json: () => unknown }): T {
  const body = response.json();
  if (body !== null && typeof body === "object" && "data" in body && "meta" in body) {
    return (body as { data: T }).data;
  }
  // An exempt route (the health probes) or an error body is not enveloped;
  // returning it as-is keeps one helper usable for both.
  return body as T;
}
