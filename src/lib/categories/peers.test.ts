import { describe, expect, it } from "vitest";
import { MAX_PROPOSED_COMPETITORS } from "../discovery/competitors.js";
import { CATEGORY_PEER_BASIS, CURATED_PEER_CONFIDENCE, mergeCategoryPeers, type CategoryPeer } from "./peers.js";

// STORY-189 AC5 and decision 91: curated peers are proposed with the basis "category peer", confidence 1.0, AFTER the site's own
// comparison links, inside the limit of five, never including the project's own domain.

const own = (name: string, confidence = 0.8) => ({ name, confidence, basis: "own comparison page" });
const peer = (name: string, root_domain: string): CategoryPeer => ({ name, root_domain });

describe("STORY-189 · mergeCategoryPeers", () => {
  it("names the basis 'category peer' (singular, as STORY-189 AC5 says) and carries confidence 1.0 (decision 91)", () => {
    expect(CATEGORY_PEER_BASIS).toBe("category peer");
    expect(CURATED_PEER_CONFIDENCE).toBe(1);
    const [first] = mergeCategoryPeers({ own: [], peers: [peer("Pipedrive", "pipedrive.com")], ownDomain: "hubspot.com" });
    expect(first).toEqual({ name: "Pipedrive", root_domain: "pipedrive.com", confidence: 1, basis: "category peer" });
  });

  it("puts the site's own comparison links first, then the peers", () => {
    const merged = mergeCategoryPeers({ own: [own("Salesforce")], peers: [peer("Pipedrive", "pipedrive.com")], ownDomain: "hubspot.com" });
    expect(merged.map((c) => c.name)).toEqual(["Salesforce", "Pipedrive"]);
    expect(merged.map((c) => c.basis)).toEqual(["own comparison page", "category peer"]);
  });

  it("never exceeds five in total: peers fill only the slots the comparison links left", () => {
    const peers = ["a", "b", "c", "d", "e", "f"].map((n) => peer(n.toUpperCase(), `${n}.com`));
    expect(mergeCategoryPeers({ own: [], peers, ownDomain: "x.com" })).toHaveLength(MAX_PROPOSED_COMPETITORS);
    expect(mergeCategoryPeers({ own: [own("One"), own("Two")], peers, ownDomain: "x.com" })).toHaveLength(MAX_PROPOSED_COMPETITORS);
    expect(mergeCategoryPeers({ own: [1, 2, 3, 4, 5].map((n) => own(`N${String(n)}`)), peers, ownDomain: "x.com" }).every((c) => c.basis === "own comparison page")).toBe(true);
  });

  it("removes the project's own domain, and any subdomain of it, from the peers", () => {
    const merged = mergeCategoryPeers({
      own: [],
      peers: [peer("HubSpot", "hubspot.com"), peer("HubSpot Blog", "blog.hubspot.com"), peer("Pipedrive", "pipedrive.com")],
      ownDomain: "hubspot.com",
    });
    expect(merged.map((c) => c.name)).toEqual(["Pipedrive"]);
  });

  it("does not repeat a company the site's own links already named, by name or by domain", () => {
    const merged = mergeCategoryPeers({
      own: [{ name: "Salesforce", confidence: 0.8, basis: "own comparison page" }],
      peers: [peer("Salesforce", "salesforce.com"), peer("Pipedrive", "pipedrive.com")],
      ownDomain: "hubspot.com",
    });
    expect(merged.map((c) => c.name)).toEqual(["Salesforce", "Pipedrive"]);
  });

  it("no peers (an empty category) leaves the site's own list untouched", () => {
    const list = [own("Salesforce")];
    expect(mergeCategoryPeers({ own: list, peers: [], ownDomain: "x.com" })).toEqual(list);
  });
});
