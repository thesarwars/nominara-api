import { describe, expect, it } from "vitest";
import { parseResyncArgs, ResyncUsageError } from "./invoices-resync.js";

describe("billing:invoices-resync · arguments", () => {
  it("--operator and --ticket are both required, as plan:set's are", () => {
    expect(parseResyncArgs(["--operator", "alice", "--ticket", "TCK-9"])).toEqual({ operator: "alice", ticket: "TCK-9" });
    expect(() => parseResyncArgs([])).toThrow(ResyncUsageError);
    expect(() => parseResyncArgs(["--operator", "alice"])).toThrow(/--ticket/u);
    expect(() => parseResyncArgs(["--ticket", "T"])).toThrow(/--operator/u);
    expect(() => parseResyncArgs(["--operator", "  ", "--ticket", "T"])).toThrow(/--operator/u);
    expect(() => parseResyncArgs(["--operator", "--ticket", "T"])).toThrow(/needs a value/u);
  });
});
