import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { StripeUpstreamError } from "./stripe-gateway.js";
import { StripeHttpGateway } from "./stripe-http.gateway.js";

// The service-period fix reads the plan line of an invoice. `invoices.retrieve` embeds only the first page of lines, so
// the adapter pages the rest in. A stubbed SDK client: no network.

function gatewayWith(client: unknown): StripeHttpGateway {
  const gateway = new StripeHttpGateway({ secretKey: "sk_test_Zx9QpLmN2vB8cD4eF6gH1jK3", webhookSecret: "whsec_Tq7RsUvW5xYz0AbC2dEf4GhI6jKl" });
  (gateway as unknown as { client: unknown }).client = client;
  return gateway;
}

describe("fetchObject(invoice) · lines", () => {
  it("an invoice whose embedded lines say has_more is returned with ALL its lines, the listing paged in", async () => {
    const all = [{ id: "il_1" }, { id: "il_2" }, { id: "il_3" }];
    const autoPagingToArray = vi.fn(() => Promise.resolve(all));
    const listLineItems = vi.fn(() => ({ autoPagingToArray }));
    const retrieve = vi.fn(() => Promise.resolve({ id: "in_1", lines: { data: [{ id: "il_1" }], has_more: true } }));
    const out = await gatewayWith({ invoices: { retrieve, listLineItems } }).fetchObject("invoice", "in_1");
    expect(listLineItems).toHaveBeenCalledWith("in_1", { limit: 100 });
    expect(out?.raw.lines).toMatchObject({ data: all, has_more: false });
  });

  it("an invoice with a complete embedded list is not listed again", async () => {
    const listLineItems = vi.fn();
    const retrieve = vi.fn(() => Promise.resolve({ id: "in_1", lines: { data: [{ id: "il_1" }], has_more: false } }));
    const out = await gatewayWith({ invoices: { retrieve, listLineItems } }).fetchObject("invoice", "in_1");
    expect(listLineItems).not.toHaveBeenCalled();
    expect(out?.raw.lines).toMatchObject({ data: [{ id: "il_1" }] });
  });

  it("a failure while paging the lines is a StripeUpstreamError, not a half-read invoice", async () => {
    const listLineItems = () => ({ autoPagingToArray: () => Promise.reject(Object.assign(new Error("x"), { statusCode: 500 })) });
    const retrieve = () => Promise.resolve({ id: "in_1", lines: { data: [], has_more: true } });
    await expect(gatewayWith({ invoices: { retrieve, listLineItems } }).fetchObject("invoice", "in_1")).rejects.toBeInstanceOf(StripeUpstreamError);
  });

  it("a listing that reaches the 1000-line cap is returned with has_more still true, and a warning (counts only, no id) is logged", async () => {
    const all = Array.from({ length: 1000 }, (_, i) => ({ id: `il_${i}` }));
    const autoPagingToArray = vi.fn(() => Promise.resolve(all));
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const retrieve = () => Promise.resolve({ id: "in_secret_1", lines: { data: [{ id: "il_0" }], has_more: true } });
    const out = await gatewayWith({ invoices: { retrieve, listLineItems: () => ({ autoPagingToArray }) } }).fetchObject("invoice", "in_secret_1");
    expect(autoPagingToArray).toHaveBeenCalledWith({ limit: 1000 });
    expect(out?.raw.lines).toMatchObject({ has_more: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("in_secret_1");
    warn.mockRestore();
  });

  it("a listing under the cap logs no warning", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const retrieve = () => Promise.resolve({ id: "in_1", lines: { data: [], has_more: true } });
    await gatewayWith({ invoices: { retrieve, listLineItems: () => ({ autoPagingToArray: () => Promise.resolve([{ id: "il_1" }]) }) } }).fetchObject("invoice", "in_1");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
