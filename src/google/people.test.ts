import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import {
  countUnresolved,
  parseBatch,
  personId,
  readPeopleCache,
  resolvePeople,
  writePeopleCache,
  type BatchEntry,
} from "./people.js";

const ACCOUNT = "alice@example.com";
const NOW = new Date("2026-09-29T12:00:00Z");

let configHome: string;
let prevXdg: string | undefined;

function accountDir(): string {
  return join(configHome, "gws-axi", "accounts", ACCOUNT);
}

function cachePath(): string {
  return join(accountDir(), "people.json");
}

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "gws-axi-people-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  mkdirSync(accountDir(), { recursive: true });
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
});

/** A batch entry as the API returns it for someone it can name. */
function named(id: string, name: string, email?: string): BatchEntry {
  return {
    requestedResourceName: `people/${id}`,
    person: {
      names: [{ displayName: name, metadata: { primary: true } }],
      emailAddresses: email ? [{ value: email, metadata: { primary: true } }] : undefined,
    },
  };
}

/** …and for someone it can't: an answer, with an empty person. */
function unnamed(id: string): BatchEntry {
  return { requestedResourceName: `people/${id}`, person: {} };
}

const granted = { hasDirectoryScope: () => true, now: NOW };

describe("personId", () => {
  it("reads the id from either API's spelling, or bare", () => {
    expect(personId("people/112454")).toBe("112454");
    expect(personId("users/112454")).toBe("112454");
    expect(personId("112454")).toBe("112454");
  });

  it("returns nothing for references that name no individual", () => {
    for (const ref of ["users/all", "users/app", "system", "anonymous", "", null, undefined]) {
      expect(personId(ref)).toBeUndefined();
    }
  });
});

describe("parseBatch", () => {
  it("keeps people the API named, with their primary name and address", () => {
    const people = parseBatch([
      {
        requestedResourceName: "people/1",
        person: {
          names: [
            { displayName: "Old Name" },
            { displayName: "Bob Tran", metadata: { primary: true } },
          ],
          emailAddresses: [{ value: "bob@example.com" }],
        },
      },
    ]);
    expect(people).toEqual([{ id: "1", name: "Bob Tran", email: "bob@example.com" }]);
  });

  it("drops the empty person returned for someone outside the directory", () => {
    expect(parseBatch([unnamed("2")])).toEqual([]);
  });

  it("drops a blank name rather than treating it as a name", () => {
    expect(parseBatch([named("3", "   ")])).toEqual([]);
  });

  it("keeps a named person who has no address", () => {
    expect(parseBatch([named("4", "Carol Wu")])).toEqual([
      { id: "4", name: "Carol Wu", email: "" },
    ]);
  });
});

describe("people cache", () => {
  it("round-trips, and is written with owner-only permissions", () => {
    writePeopleCache(ACCOUNT, [{ id: "1", name: "Bob Tran", email: "bob@example.com" }], NOW);
    expect(readPeopleCache(ACCOUNT, NOW).get("1")).toEqual({
      id: "1",
      name: "Bob Tran",
      email: "bob@example.com",
    });
    expect(statSync(cachePath()).mode & 0o777).toBe(0o600);
  });

  it("expires entries after 30 days", () => {
    writePeopleCache(ACCOUNT, [{ id: "1", name: "Bob Tran", email: "" }], NOW);
    const day29 = new Date(NOW.getTime() + 29 * 86_400_000);
    const day31 = new Date(NOW.getTime() + 31 * 86_400_000);
    expect(readPeopleCache(ACCOUNT, day29).has("1")).toBe(true);
    expect(readPeopleCache(ACCOUNT, day31).has("1")).toBe(false);
  });

  it("merges, leaving untouched entries their own timestamps", () => {
    writePeopleCache(ACCOUNT, [{ id: "1", name: "Bob Tran", email: "" }], NOW);
    const later = new Date(NOW.getTime() + 20 * 86_400_000);
    writePeopleCache(ACCOUNT, [{ id: "2", name: "Carol Wu", email: "" }], later);
    const file = JSON.parse(readFileSync(cachePath(), "utf-8"));
    expect(file["1"].fetched).toBe(NOW.toISOString());
    expect(file["2"].fetched).toBe(later.toISOString());
  });

  it("treats a corrupt file as empty, and recovers on the next write", () => {
    writeFileSync(cachePath(), "{ not json");
    expect(readPeopleCache(ACCOUNT, NOW).size).toBe(0);
    writePeopleCache(ACCOUNT, [{ id: "1", name: "Bob Tran", email: "" }], NOW);
    expect(readPeopleCache(ACCOUNT, NOW).has("1")).toBe(true);
  });

  it("ignores entries with a blank name or a malformed id", () => {
    writeFileSync(
      cachePath(),
      JSON.stringify({
        "1": { name: "", email: "", fetched: NOW.toISOString() },
        "not-an-id": { name: "X", email: "", fetched: NOW.toISOString() },
        "2": { name: "Carol Wu", email: "", fetched: "garbage" },
      }),
    );
    expect(readPeopleCache(ACCOUNT, NOW).size).toBe(0);
  });

  it("writes nothing when there is nothing to cache", () => {
    writePeopleCache(ACCOUNT, [], NOW);
    expect(existsSync(cachePath())).toBe(false);
  });
});

describe("resolvePeople", () => {
  it("looks up what it was asked for, once per person", async () => {
    const lookup = vi.fn(async () => [named("1", "Bob Tran", "bob@example.com"), unnamed("2")]);
    const res = await resolvePeople(ACCOUNT, ["people/1", "users/1", "people/2", "system"], {
      ...granted,
      lookup,
    });
    expect(lookup).toHaveBeenCalledWith(ACCOUNT, ["1", "2"]);
    expect([...res.people.keys()]).toEqual(["1"]);
    expect(res.degraded).toBeUndefined();
  });

  it("makes no call for people already cached", async () => {
    const lookup = vi.fn(async () => [named("1", "Bob Tran")]);
    await resolvePeople(ACCOUNT, ["people/1"], { ...granted, lookup });
    const second = await resolvePeople(ACCOUNT, ["people/1"], { ...granted, lookup });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(second.people.get("1")?.name).toBe("Bob Tran");
  });

  it("asks again for someone who did not resolve — misses are not cached", async () => {
    const lookup = vi.fn(async () => [unnamed("2")]);
    await resolvePeople(ACCOUNT, ["people/2"], { ...granted, lookup });
    await resolvePeople(ACCOUNT, ["people/2"], { ...granted, lookup });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("names the account itself from its stored profile, with no call", async () => {
    writeFileSync(
      join(accountDir(), "profile.json"),
      JSON.stringify({ sub: "999", name: "Alice Ng", email: ACCOUNT }),
    );
    const lookup = vi.fn(async () => []);
    const res = await resolvePeople(ACCOUNT, ["people/999"], { ...granted, lookup });
    expect(res.people.get("999")).toEqual({ id: "999", name: "Alice Ng", email: ACCOUNT });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("makes no call when nothing names an individual", async () => {
    const lookup = vi.fn(async () => []);
    const res = await resolvePeople(ACCOUNT, ["system", "anonymous", "users/all"], {
      ...granted,
      lookup,
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(res.people.size).toBe(0);
  });

  it("degrades, without a call, when the scope was never granted", async () => {
    const lookup = vi.fn(async () => [named("1", "Bob Tran")]);
    const res = await resolvePeople(ACCOUNT, ["people/1"], {
      now: NOW,
      hasDirectoryScope: () => false,
      lookup,
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(res.people.size).toBe(0);
    expect(res.degraded).toContain("directory.readonly");
    expect(res.degraded).toContain(`gws-axi auth login --account ${ACCOUNT}`);
  });

  it("still serves the cache when the scope is missing", async () => {
    writePeopleCache(ACCOUNT, [{ id: "1", name: "Bob Tran", email: "" }], NOW);
    const res = await resolvePeople(ACCOUNT, ["people/1", "people/2"], {
      now: NOW,
      hasDirectoryScope: () => false,
    });
    expect(res.people.get("1")?.name).toBe("Bob Tran");
    expect(res.degraded).toContain("directory.readonly");
  });

  it("never throws: a disabled API becomes a note naming the fix", async () => {
    const lookup = async (): Promise<BatchEntry[]> => {
      throw new AxiError("API not enabled", "API_NOT_ENABLED", ["Run `gws-axi auth setup`"]);
    };
    const res = await resolvePeople(ACCOUNT, ["people/1"], { ...granted, lookup });
    expect(res.people.size).toBe(0);
    expect(res.degraded).toContain("People API is not enabled");
    expect(res.degraded).toContain("gws-axi auth setup");
  });

  it("never throws: an unexpected failure becomes a note, and ids stand", async () => {
    const lookup = async (): Promise<BatchEntry[]> => {
      throw new Error("socket hang up");
    };
    const res = await resolvePeople(ACCOUNT, ["people/1"], { ...granted, lookup });
    expect(res.people.size).toBe(0);
    expect(res.degraded).toContain("socket hang up");
  });
});

describe("countUnresolved", () => {
  it("counts distinct individuals who did not resolve, ignoring labels", async () => {
    const res = await resolvePeople(ACCOUNT, ["people/1", "people/2", "people/3"], {
      ...granted,
      lookup: async () => [named("1", "Bob Tran"), unnamed("2"), unnamed("3")],
    });
    expect(countUnresolved(["people/1", "people/2", "users/2", "people/3", "system"], res)).toBe(2);
  });
});
