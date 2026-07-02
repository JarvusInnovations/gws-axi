import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { authCommand, AUTH_HELP, resolveLoginAccount } from "./auth.js";

// `auth join` writes into the XDG config dir; isolate it per-test.
let configHome: string;
let downloads: string;
let prevXdg: string | undefined;

function credsPath(): string {
  return join(configHome, "gws-axi", "credentials.json");
}
function setupState(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configHome, "gws-axi", "setup.json"), "utf-8"));
}
function writeDesktopCreds(name: string): string {
  const p = join(downloads, name);
  writeFileSync(
    p,
    JSON.stringify({
      installed: {
        client_id: "1065-abc.apps.googleusercontent.com",
        client_secret: "SECRET",
        project_id: "shared-team-proj",
      },
    }),
  );
  return p;
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "gws-join-"));
  configHome = join(base, "config");
  downloads = join(base, "downloads");
  mkdirSync(configHome, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
});

describe("auth join", () => {
  it("copies the file into place and marks steps 1-6 done (6/7)", async () => {
    const src = writeDesktopCreds("credentials.json");
    const out = (await authCommand(["join", src])) as Record<string, unknown>;

    expect(out.status).toBe("joined");
    expect(out.project_id).toBe("shared-team-proj");
    expect(out.client_id).toBe("1065-abc.apps.googleusercontent.com");
    expect(out.steps_ready).toContain("6 of 7");
    expect(existsSync(credsPath())).toBe(true);

    const state = setupState();
    const steps = state.steps as Record<string, { done: boolean; via?: string }>;
    for (const key of [
      "gcp_project",
      "apis_enabled",
      "oauth_client",
      "credentials_saved",
      "consent_screen",
      "test_user_added",
    ]) {
      expect(steps[key].done, key).toBe(true);
      expect(steps[key].via, key).toBe("team-join");
    }
    // Step 7 is the teammate's own login — never fabricated by join.
    expect(steps.tokens_obtained.done).toBe(false);
    // Publish is not inferred.
    expect(state.published).toBeUndefined();
  });

  it("derives project_id/client_id from the JSON's installed block", async () => {
    const src = writeDesktopCreds("credentials.json");
    await authCommand(["join", src]);
    const steps = setupState().steps as Record<string, Record<string, unknown>>;
    expect(steps.gcp_project.project_id).toBe("shared-team-proj");
    expect(steps.oauth_client.client_id).toBe("1065-abc.apps.googleusercontent.com");
  });

  it("sets published state only with --published", async () => {
    const src = writeDesktopCreds("credentials.json");
    const out = (await authCommand(["join", src, "--published"])) as Record<string, unknown>;
    const state = setupState();
    expect((state.published as { confirmed_at: string }).confirmed_at).toBeTruthy();
    expect((out.help as string[]).some((h) => h.includes("permanent"))).toBe(true);
  });

  it("never resets tokens_obtained on a re-run", async () => {
    const src = writeDesktopCreds("credentials.json");
    await authCommand(["join", src]);
    // Simulate the teammate having logged in.
    const state = setupState();
    (state.steps as Record<string, { done: boolean }>).tokens_obtained.done = true;
    writeFileSync(join(configHome, "gws-axi", "setup.json"), `${JSON.stringify(state, null, 2)}\n`);
    await authCommand(["join", src]);
    expect((setupState().steps as Record<string, { done: boolean }>).tokens_obtained.done).toBe(
      true,
    );
  });

  it("does not error when source path already IS the destination", async () => {
    mkdirSync(join(configHome, "gws-axi"), { recursive: true });
    const dest = credsPath();
    writeFileSync(
      dest,
      JSON.stringify({
        installed: { client_id: "x.apps.googleusercontent.com", client_secret: "s" },
      }),
    );
    const out = (await authCommand(["join", dest])) as Record<string, unknown>;
    expect(out.status).toBe("joined");
    expect(existsSync(dest)).toBe(true);
  });

  it("rejects a missing path with VALIDATION_ERROR", async () => {
    await expect(authCommand(["join"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects a missing file with FILE_NOT_FOUND", async () => {
    await expect(authCommand(["join", join(downloads, "nope.json")])).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
  });

  it("rejects invalid JSON with INVALID_JSON", async () => {
    const p = join(downloads, "bad.json");
    writeFileSync(p, "{ not json");
    await expect(authCommand(["join", p])).rejects.toMatchObject({ code: "INVALID_JSON" });
  });

  it("rejects a non-Desktop (Web) client with WRONG_CLIENT_TYPE", async () => {
    const p = join(downloads, "web.json");
    writeFileSync(p, JSON.stringify({ web: { client_id: "w", client_secret: "s" } }));
    const err = await authCommand(["join", p]).catch((e) => e);
    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("WRONG_CLIENT_TYPE");
  });

  it("is documented in AUTH_HELP", () => {
    expect(AUTH_HELP).toContain("gws-axi auth join");
    expect(AUTH_HELP).toContain("--published");
  });
});

describe("resolveLoginAccount", () => {
  it("passes an explicit --account through unchanged", () => {
    expect(resolveLoginAccount("x@y.com", [])).toBe("x@y.com");
    expect(resolveLoginAccount("x@y.com", ["a@b.com", "c@d.com"])).toBe("x@y.com");
  });

  it("returns undefined for a first sign-in (0 accounts)", () => {
    expect(resolveLoginAccount(undefined, [])).toBeUndefined();
  });

  it("defaults to the sole account for re-auth (1 account)", () => {
    expect(resolveLoginAccount(undefined, ["only@acct.com"])).toBe("only@acct.com");
  });

  it("throws ACCOUNT_REQUIRED when 2+ accounts and no --account", () => {
    try {
      resolveLoginAccount(undefined, ["a@b.com", "c@d.com"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AxiError);
      expect((err as AxiError).code).toBe("ACCOUNT_REQUIRED");
      // both accounts surfaced as ready-to-run suggestions
      expect((err as AxiError).suggestions.join("\n")).toContain("--account a@b.com");
      expect((err as AxiError).suggestions.join("\n")).toContain("--account c@d.com");
    }
  });
});
