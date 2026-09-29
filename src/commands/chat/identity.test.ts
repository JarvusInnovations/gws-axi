import { describe, expect, it } from "vitest";
import { deriveSpaceName, IdentityLedger, type ChatUser } from "./identity.js";

const bob: ChatUser = {
  name: "users/1",
  displayName: "Bob Tran",
  email: "bob@example.com",
  type: "HUMAN",
};
const bare: ChatUser = { name: "users/2", type: "HUMAN" };
const app: ChatUser = { name: "users/9", type: "BOT" };

describe("IdentityLedger", () => {
  it("renders a person Chat named from the response, and never looks them up", () => {
    const ledger = new IdentityLedger();
    ledger.add(bob);
    expect(ledger.needsLookup()).toEqual([]);
    expect(ledger.label(bob)).toBe("Bob Tran");
    expect(ledger.rows()).toEqual([
      { id: "users/1", name: "Bob Tran", email: "bob@example.com", type: "human" },
    ]);
  });

  it("sends a person Chat left unnamed to the resolver, and takes its answer", () => {
    const ledger = new IdentityLedger();
    ledger.add(bare);
    expect(ledger.needsLookup()).toEqual(["users/2"]);
    ledger.applyResolution({
      people: new Map([["2", { id: "2", name: "Carol Wu", email: "carol@example.com" }]]),
    });
    expect(ledger.label(bare)).toBe("Carol Wu");
    expect(ledger.unresolved()).toBe(0);
  });

  it("never lets the resolver overrule a name Chat gave", () => {
    const ledger = new IdentityLedger();
    ledger.add(bob);
    ledger.applyResolution({
      people: new Map([["1", { id: "1", name: "Robert T.", email: "other@example.com" }]]),
    });
    expect(ledger.label(bob)).toBe("Bob Tran");
    expect(ledger.rows()[0].email).toBe("bob@example.com");
  });

  it("shows the id, and counts it, when nobody could name a person", () => {
    const ledger = new IdentityLedger();
    ledger.add(bare);
    ledger.applyResolution({ people: new Map() });
    expect(ledger.label(bare)).toBe("users/2");
    expect(ledger.unresolved()).toBe(1);
    expect(ledger.rows()[0]).toEqual({ id: "users/2", name: "", email: "", type: "human" });
  });

  it("treats an unnamed app as an app, not as an unresolved person", () => {
    const ledger = new IdentityLedger();
    ledger.add(app);
    expect(ledger.needsLookup()).toEqual([]);
    expect(ledger.unresolved()).toBe(0);
    expect(ledger.label(app)).toBe("bot users/9");
  });

  it("merges a bare sighting with a named one of the same person", () => {
    const ledger = new IdentityLedger();
    ledger.add({ name: "users/9", type: "BOT" });
    ledger.add({ name: "users/9", type: "BOT", displayName: "Google Drive" });
    expect(ledger.rows()).toHaveLength(1);
    expect(ledger.label(app)).toBe("Google Drive");
  });

  it("adds the address when two people in a response share a name", () => {
    const ledger = new IdentityLedger();
    const other: ChatUser = {
      name: "users/3",
      displayName: "Bob Tran",
      email: "bob@other.org",
      type: "HUMAN",
    };
    ledger.add(bob);
    ledger.add(other);
    expect(ledger.label(bob)).toBe("Bob Tran <bob@example.com>");
    expect(ledger.label(other)).toBe("Bob Tran <bob@other.org>");
  });

  it("does not treat a blank name from upstream as a name", () => {
    const ledger = new IdentityLedger();
    ledger.add({ name: "users/2", displayName: "   ", type: "HUMAN" });
    expect(ledger.needsLookup()).toEqual(["users/2"]);
  });

  it("ignores a user with no id", () => {
    const ledger = new IdentityLedger();
    ledger.add({ displayName: "Nobody" });
    ledger.add(undefined);
    expect(ledger.rows()).toEqual([]);
  });
});

describe("deriveSpaceName", () => {
  it("names a direct message after the other person", () => {
    expect(deriveSpaceName(["Bob Tran"])).toBe("Bob Tran");
  });

  it("lists two, and counts the rest", () => {
    expect(deriveSpaceName(["Bob Tran", "Carol Wu"])).toBe("Bob Tran, Carol Wu");
    expect(deriveSpaceName(["Bob Tran", "Carol Wu", "Dee", "Eve"])).toBe("Bob Tran, Carol Wu, +2");
  });

  it("is never blank", () => {
    expect(deriveSpaceName([])).toBe("(only you)");
  });
});
