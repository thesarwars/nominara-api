import type { FastifyReply } from "fastify";
import { SSE_HEADERS } from "./sse-stream.js";

// STORY-079 - turns a Fastify reply into the sink the SSE helper writes to.
//
// `reply.hijack()` takes the response out of Fastify's hands, so nothing appends a body or a status to a stream already in flight. The headers the
// hooks have already set (CORS, request id, security headers) are carried across: writing to `reply.raw` would otherwise drop them, and a browser
// would refuse an EventSource whose response lacks its CORS headers.
export interface SseReplySink {
  write(chunk: string): unknown;
  end(): unknown;
  onClose(callback: () => void): void;
}

export function openSseReply(reply: FastifyReply): SseReplySink {
  const inherited = Object.fromEntries(Object.entries(reply.getHeaders()).filter((entry): entry is [string, string | number | string[]] => entry[1] !== undefined));
  reply.hijack();
  reply.raw.writeHead(200, { ...inherited, ...SSE_HEADERS });
  reply.raw.flushHeaders();
  return {
    write: (chunk) => reply.raw.write(chunk),
    end: () => reply.raw.end(),
    onClose: (callback) => {
      reply.raw.on("close", callback);
    },
  };
}
