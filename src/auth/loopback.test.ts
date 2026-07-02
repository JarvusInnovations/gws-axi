import { describe, expect, it } from "vitest";
import { accessDeniedCliInstructions } from "./loopback.js";

describe("accessDeniedCliInstructions", () => {
  it("leads with the unverified-app warning (the common bail point) and echoes the account", () => {
    const out = accessDeniedCliInstructions("chris@jarv.us", false).join("\n");
    expect(out).toMatch(/hasn't verified this app/i);
    expect(out).toMatch(/Advanced/);
    expect(out).toContain("chris@jarv.us");
  });

  it("for a joined teammate, never sends them to the Cloud Console", () => {
    const out = accessDeniedCliInstructions("teammate@jarv.us", true).join("\n");
    expect(out).toMatch(/do NOT need Google Cloud Console/i);
    expect(out).toMatch(/ask whoever shared this client/i);
    // No self-serve Console/test-user instruction for a joined teammate.
    expect(out).not.toMatch(/Audience → Test users/);
  });

  it("for a self-setup owner, points at their own consent screen (test users / user cap)", () => {
    const out = accessDeniedCliInstructions("me@example.com", false).join("\n");
    expect(out).toMatch(/Audience → Test users/);
    expect(out).toMatch(/user cap/i);
  });

  it("falls back to a placeholder when no account is known", () => {
    const out = accessDeniedCliInstructions(undefined, false).join("\n");
    expect(out).toContain("--account <email>");
    expect(out).toMatch(/your Google account/);
  });
});
