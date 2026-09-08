import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { accountHeaderFields, resolveAccount, withAccountSource } from "./account.js";
import { setDefaultAccount } from "../config.js";

// resolveAccount reads the XDG config dir and process.env on every call, so
// each test gets a fresh dir and a clean environment.
let configHome: string;
let prevXdg: string | undefined;
let prevLock: string | undefined;

/** Fabricate an authenticated account (listAccounts keys off tokens.json). */
function addAccount(email: string): void {
  const dir = join(configHome, "gws-axi", "accounts", email);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tokens.json"), JSON.stringify({ refresh_token: "x" }));
}

function pin(value: string | undefined): void {
  if (value === undefined) delete process.env.GWS_AXI_ACCOUNT;
  else process.env.GWS_AXI_ACCOUNT = value;
}

/** Run resolveAccount and return the AxiError it threw. */
function expectError(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AxiError);
    return err as AxiError;
  }
  throw new Error("expected resolveAccount to throw, but it returned");
}

const READ = { mutation: false, commandName: "calendar events" };
const WRITE = { mutation: true, commandName: "calendar create" };

beforeEach(() => {
  configHome = join(mkdtempSync(join(tmpdir(), "gws-account-")), "config");
  mkdirSync(configHome, { recursive: true });
  prevXdg = process.env.XDG_CONFIG_HOME;
  prevLock = process.env.GWS_AXI_ACCOUNT;
  process.env.XDG_CONFIG_HOME = configHome;
  delete process.env.GWS_AXI_ACCOUNT;
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  if (prevLock === undefined) delete process.env.GWS_AXI_ACCOUNT;
  else process.env.GWS_AXI_ACCOUNT = prevLock;
});

// The pre-pin behavior, ported wholesale: the pin reorders these branches, so
// they need a guard that they still fire in the same order without one.
describe("resolveAccount without a pin", () => {
  it("throws NO_ACCOUNTS when nothing is authenticated", () => {
    expect(expectError(() => resolveAccount(undefined, READ)).code).toBe("NO_ACCOUNTS");
  });

  it("uses the sole account with no flag, from either a read or a write", () => {
    addAccount("solo@x.com");
    expect(resolveAccount(undefined, READ)).toMatchObject({
      account: "solo@x.com",
      source: "single",
      totalAccounts: 1,
    });
    expect(resolveAccount(undefined, WRITE).account).toBe("solo@x.com");
  });

  it("honors --account and normalizes it", () => {
    addAccount("a@x.com");
    addAccount("b@x.com");
    expect(resolveAccount("  B@X.com ", READ)).toMatchObject({
      account: "b@x.com",
      source: "flag",
    });
  });

  it("throws ACCOUNT_NOT_FOUND for an unauthenticated --account", () => {
    addAccount("a@x.com");
    expect(expectError(() => resolveAccount("nope@x.com", READ)).code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("falls back to the default on a read with 2+ accounts", () => {
    addAccount("a@x.com");
    addAccount("b@x.com");
    setDefaultAccount("b@x.com");
    expect(resolveAccount(undefined, READ)).toMatchObject({
      account: "b@x.com",
      source: "default",
    });
  });

  it("throws NO_DEFAULT_ACCOUNT on a read with 2+ accounts and no default", () => {
    addAccount("a@x.com");
    addAccount("b@x.com");
    expect(expectError(() => resolveAccount(undefined, READ)).code).toBe("NO_DEFAULT_ACCOUNT");
  });

  it("throws ACCOUNT_REQUIRED on a write with 2+ accounts, even with a default set", () => {
    addAccount("a@x.com");
    addAccount("b@x.com");
    setDefaultAccount("b@x.com");
    expect(expectError(() => resolveAccount(undefined, WRITE)).code).toBe("ACCOUNT_REQUIRED");
  });
});

describe("resolveAccount with a GWS_AXI_ACCOUNT pin", () => {
  beforeEach(() => {
    addAccount("a@x.com");
    addAccount("b@x.com");
  });

  it("resolves to the pin with no flag", () => {
    pin("b@x.com");
    expect(resolveAccount(undefined, READ)).toMatchObject({
      account: "b@x.com",
      source: "env",
      lockedTo: "b@x.com",
    });
  });

  it("beats a different default_account without rewriting it", () => {
    setDefaultAccount("a@x.com");
    pin("b@x.com");
    const res = resolveAccount(undefined, READ);
    expect(res.account).toBe("b@x.com");
    // The on-disk default is reported untouched — the pin overrides, it does
    // not mutate shared config other environments still read.
    expect(res.defaultAccount).toBe("a@x.com");
  });

  // The load-bearing assertion: a pin IS the explicit account choice that
  // write-protection demands (specs/principles.md#write-protection-requires-explicit-account).
  it("satisfies write-protection: a write with 2+ accounts needs no --account", () => {
    pin("b@x.com");
    expect(resolveAccount(undefined, WRITE)).toMatchObject({
      account: "b@x.com",
      source: "env",
    });
  });

  it("accepts an --account naming the same account, case-insensitively", () => {
    pin("b@x.com");
    expect(resolveAccount("B@X.com", READ).account).toBe("b@x.com");
    pin("B@X.com");
    expect(resolveAccount("b@x.com", READ).account).toBe("b@x.com");
  });

  it("refuses a conflicting --account with ACCOUNT_LOCKED, naming both", () => {
    pin("b@x.com");
    const err = expectError(() => resolveAccount("a@x.com", READ));
    expect(err.code).toBe("ACCOUNT_LOCKED");
    expect(err.message).toContain("b@x.com");
    expect(err.message).toContain("a@x.com");
    expect(err.message).toContain("GWS_AXI_ACCOUNT");
  });

  // A conflicting --account that is ALSO unauthenticated must report the lock,
  // not ACCOUNT_NOT_FOUND — the lock is the governing fact, and the flag would
  // have been refused either way.
  it("reports the lock ahead of --account validation", () => {
    pin("b@x.com");
    expect(expectError(() => resolveAccount("ghost@x.com", READ)).code).toBe("ACCOUNT_LOCKED");
  });

  it("fails every command with ACCOUNT_LOCK_INVALID when the pin is unauthenticated", () => {
    pin("ghost@x.com");
    setDefaultAccount("a@x.com");
    const err = expectError(() => resolveAccount(undefined, READ));
    // Emphatically NOT a silent fall back to the default — that is the exact
    // outcome the pin was set to prevent.
    expect(err.code).toBe("ACCOUNT_LOCK_INVALID");
    expect(err.message).toContain("ghost@x.com");
    expect(err.suggestions.some((sug) => sug.includes("unset GWS_AXI_ACCOUNT"))).toBe(true);
  });

  it("treats an unset, empty, or whitespace-only value as no pin", () => {
    setDefaultAccount("a@x.com");
    for (const value of [undefined, "", "   ", "\t\n"]) {
      pin(value);
      expect(resolveAccount(undefined, READ)).toMatchObject({
        account: "a@x.com",
        source: "default",
      });
      // And write-protection stays engaged, since nothing made an explicit choice.
      expect(expectError(() => resolveAccount(undefined, WRITE)).code).toBe("ACCOUNT_REQUIRED");
    }
  });
});

describe("accountHeaderFields", () => {
  it("discloses an env pin even with a single account authenticated", () => {
    expect(
      accountHeaderFields({
        account: "a@x.com",
        source: "env",
        totalAccounts: 1,
        lockedTo: "a@x.com",
      }),
    ).toEqual({ account: "a@x.com", account_source: "env" });
  });

  it("discloses an env pin with 2+ accounts", () => {
    expect(
      accountHeaderFields({ account: "a@x.com", source: "env", totalAccounts: 2 }).account_source,
    ).toBe("env");
  });

  it("discloses an implicit default only when 2+ accounts are authenticated", () => {
    expect(
      accountHeaderFields({ account: "a@x.com", source: "default", totalAccounts: 2 })
        .account_source,
    ).toBe("default");
    expect(
      accountHeaderFields({ account: "a@x.com", source: "default", totalAccounts: 1 })
        .account_source,
    ).toBeUndefined();
  });

  it("adds no source line for an account named on the command line", () => {
    for (const source of ["flag", "single"] as const) {
      expect(accountHeaderFields({ account: "a@x.com", source, totalAccounts: 2 })).toEqual({
        account: "a@x.com",
      });
    }
  });
});

// Handlers render `account: <email>` themselves and receive only the resolved
// email, so the dispatcher splices the disclosure into their output.
describe("withAccountSource", () => {
  const body = "account: a@x.com\ncount: 3\nevents[1]{id}:\n  abc\n";

  it("inserts the line directly under the account line", () => {
    const out = withAccountSource(
      { account: "a@x.com", source: "env", totalAccounts: 2, lockedTo: "a@x.com" },
      body,
    );
    expect(out.split("\n").slice(0, 3)).toEqual([
      "account: a@x.com",
      "account_source: env",
      "count: 3",
    ]);
  });

  it("leaves output untouched when no disclosure is owed", () => {
    for (const source of ["flag", "single"] as const) {
      expect(withAccountSource({ account: "a@x.com", source, totalAccounts: 2 }, body)).toBe(body);
    }
  });

  // Not every handler renders an account line (help/short-circuit paths); the
  // disclosure must still be visible rather than silently dropped.
  it("prepends when the output has no account line", () => {
    expect(
      withAccountSource({ account: "a@x.com", source: "env", totalAccounts: 1 }, "status: ok"),
    ).toBe("account_source: env\nstatus: ok");
  });

  it("does not match a line that merely contains 'account:'", () => {
    const out = withAccountSource(
      { account: "a@x.com", source: "env", totalAccounts: 1 },
      "help[1]: Pass --account: <email>",
    );
    expect(out.split("\n")[0]).toBe("account_source: env");
  });
});
