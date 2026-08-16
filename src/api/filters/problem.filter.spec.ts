import type { ArgumentsHost } from "@nestjs/common";
import { HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { TenantContextMissingError } from "../../tenancy/errors.js";
import { ProblemFilter } from "./problem.filter.js";

function makeHost(): { host: ArgumentsHost; status: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, send };
}

// STORY-022 — ProblemFilter is an explicit minimal stub (real ISO-08 taxonomy
// lands in STORY-024); this only proves the stub's current shape/behavior,
// not a new taxonomy.
describe("STORY-022 · ProblemFilter", () => {
  it("maps an HttpException to its own status and message", () => {
    const filter = new ProblemFilter();
    const { host, status, send } = makeHost();

    filter.catch(new HttpException("nope", HttpStatus.FORBIDDEN), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(send).toHaveBeenCalledWith({
      type: "about:blank",
      status: HttpStatus.FORBIDDEN,
      title: "FORBIDDEN",
      detail: "nope",
    });
  });

  it("maps a generic Error to a 500 without leaking its message", () => {
    const filter = new ProblemFilter();
    const { host, status, send } = makeHost();

    filter.catch(new Error("raw internal detail"), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(send).toHaveBeenCalledWith({
      type: "about:blank",
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      title: "INTERNAL_SERVER_ERROR",
      detail: "internal server error",
    });
  });

  it("maps TenantContextMissingError (a plain Error, not an HttpException) to a well-formed 500", () => {
    const filter = new ProblemFilter();
    const { host, status, send } = makeHost();

    filter.catch(new TenantContextMissingError("req.tenant is unset"), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(send).toHaveBeenCalledWith({
      type: "about:blank",
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      title: "INTERNAL_SERVER_ERROR",
      detail: "internal server error",
    });
  });
});
