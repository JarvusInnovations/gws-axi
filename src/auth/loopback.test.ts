import { describe, expect, it } from "vitest";
import { CallbackUrlError, accessDeniedCliInstructions, parseCallbackUrl } from "./loopback.js";

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

describe("pasted callback URL", () => {
  const pending = { port: 53121, state: "abc123" };
  const ok = "http://127.0.0.1:53121/callback?state=abc123&code=4/0Ab&scope=openid%20email";

  it("extracts the code and scope from this flow's redirect", () => {
    expect(parseCallbackUrl(ok, pending)).toEqual({ code: "4/0Ab", scope: "openid email" });
    expect(parseCallbackUrl(`  ${ok.replace("127.0.0.1", "localhost")}\n`, pending).code).toBe(
      "4/0Ab",
    );
  });

  it("refuses anything that isn't this flow's redirect", () => {
    const bad = [
      "not a url",
      "http://127.0.0.1:53121/elsewhere?state=abc123&code=x",
      "http://evil.example:53121/callback?state=abc123&code=x",
      "http://127.0.0.1:40000/callback?state=abc123&code=x",
      "http://127.0.0.1:53121/callback?state=other&code=x",
      "http://127.0.0.1:53121/callback?state=abc123",
    ];
    for (const url of bad) {
      expect(() => parseCallbackUrl(url, pending)).toThrow(CallbackUrlError);
    }
  });

  it("surfaces Google's error instead of a mismatch", () => {
    expect(() =>
      parseCallbackUrl("http://127.0.0.1:53121/callback?error=access_denied&state=abc123", pending),
    ).toThrow(/access_denied/);
  });
});
