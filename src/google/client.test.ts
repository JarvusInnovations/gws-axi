import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSetupState, SETUP_STEP_ORDER } from "../config.js";
import { translateGoogleError } from "./client.js";

// translateGoogleError reads setup.json to tell an owned install from a joined
// one, so each test gets its own config dir.
let configHome: string;
let prevXdg: string | undefined;

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "gws-axi-client-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
});

function writeSetup(via?: string): void {
  const state = defaultSetupState();
  for (const key of SETUP_STEP_ORDER) state.steps[key] = via ? { done: true, via } : { done: true };
  const dir = join(configHome, "gws-axi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "setup.json"), JSON.stringify(state));
}

/** A Google API 403 as the client library surfaces it. */
function forbidden(message: string, reason?: string): unknown {
  return {
    response: {
      status: 403,
      data: { error: { code: 403, message, errors: reason ? [{ reason }] : [] } },
    },
  };
}

const CTX = { account: "alice@example.com", operation: "chat.spaces.list" };

describe("translateGoogleError — 403 scope classification", () => {
  it("classifies Google's insufficient-scope wording as SCOPE_MISSING", () => {
    const err = translateGoogleError(
      forbidden("Request had insufficient authentication scopes."),
      CTX,
    );
    expect(err.code).toBe("SCOPE_MISSING");
  });

  it("classifies by reason even when the message says nothing about scopes", () => {
    expect(translateGoogleError(forbidden("Forbidden", "insufficientPermissions"), CTX).code).toBe(
      "SCOPE_MISSING",
    );
    expect(
      translateGoogleError(forbidden("Forbidden", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"), CTX).code,
    ).toBe("SCOPE_MISSING");
  });

  it("does not call a 403 a scope problem just because it mentions 'scope'", () => {
    const err = translateGoogleError(
      forbidden("This operation is outside the scope of what your organization allows."),
      CTX,
    );
    expect(err.code).toBe("FORBIDDEN");
    expect(err.suggestions.join(" ")).not.toContain("auth login");
  });
});

describe("translateGoogleError — API_NOT_ENABLED", () => {
  const disabled = forbidden(
    "Google Chat API has not been used in project 123 before or it is disabled.",
    "accessNotConfigured",
  );

  it("sends an owned install to auth setup", () => {
    writeSetup();
    const err = translateGoogleError(disabled, CTX);
    expect(err.code).toBe("API_NOT_ENABLED");
    expect(err.suggestions.join(" ")).toContain("gws-axi auth setup");
  });

  it("sends a joined install to the distributor, never to setup or the Console", () => {
    writeSetup("team-join");
    const err = translateGoogleError(disabled, CTX);
    const text = err.suggestions.join(" ");
    expect(err.code).toBe("API_NOT_ENABLED");
    expect(text).toContain("distributed your gws-axi credentials");
    expect(text).toContain(CTX.operation);
    expect(text).not.toContain("auth setup");
    expect(text).not.toContain("console.cloud.google.com");
  });

  it("falls back to the owned-install advice when there is no setup state", () => {
    const err = translateGoogleError(disabled, CTX);
    expect(err.suggestions.join(" ")).toContain("gws-axi auth setup");
  });
});
