import { describe, expect, it } from "vitest";
import { ADDITIONAL_SCOPE_INFO, BASE_SCOPES, SERVICE_SCOPES } from "../auth/scopes.js";
import { probeAdditionalScopes, type ProbeContext } from "./probe.js";
import type { StoredTokens } from "./tokens.js";

function ctxWithScopes(scopes: string[]): ProbeContext {
  const tokens: StoredTokens = {
    client_id: "test",
    access_token: "tok",
    refresh_token: "ref",
    expiry_date: 4_102_444_800_000, // far future
    scope: scopes.join(" "),
    token_type: "Bearer",
    obtained_at: "2026-01-01T00:00:00.000Z",
  };
  return { email: "x@example.com", tokens, accessToken: "tok" };
}

describe("probeAdditionalScopes", () => {
  it("returns one result per ADDITIONAL_SCOPE_INFO entry, keyed to its service", () => {
    const results = probeAdditionalScopes(ctxWithScopes([]));
    expect(results).toHaveLength(ADDITIONAL_SCOPE_INFO.length);
    for (const info of ADDITIONAL_SCOPE_INFO) {
      expect(results.some((r) => r.service === info.service)).toBe(true);
    }
  });

  it("marks a granted additional scope ok", () => {
    const granted = ADDITIONAL_SCOPE_INFO[0];
    const results = probeAdditionalScopes(
      ctxWithScopes([...BASE_SCOPES, ...Object.values(SERVICE_SCOPES), granted.scope]),
    );
    const row = results.find((r) => r.detail.includes(granted.capability));
    expect(row?.status).toBe("ok");
  });

  it("marks a missing additional scope fail with a re-auth prompt containing 'scope'", () => {
    // No additional scopes granted.
    const results = probeAdditionalScopes(
      ctxWithScopes([...BASE_SCOPES, ...Object.values(SERVICE_SCOPES)]),
    );
    expect(results.every((r) => r.status === "fail")).toBe(true);
    // Detail must contain "scope" so doctor's scope-gap rollup (/scope/i) catches it.
    expect(results.every((r) => /scope/i.test(r.detail))).toBe(true);
    expect(results.every((r) => /re-auth/i.test(r.detail))).toBe(true);
  });
});
