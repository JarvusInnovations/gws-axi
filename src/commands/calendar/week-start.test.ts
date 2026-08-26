import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cache path and the Google client are the two edges of this module; both
// are stubbed so the tests exercise the caching and fallback logic only.
const settingsGet = vi.fn();
let cacheDir: string;

vi.mock("../../config.js", () => ({
  settingsPathForAccount: () => join(cacheDir, "settings.json"),
}));

vi.mock("../../google/client.js", () => ({
  calendarClient: async () => ({ settings: { get: settingsGet } }),
}));

const { resolveWeekStart } = await import("./week-start.js");

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "gws-week-start-"));
  settingsGet.mockReset();
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function writeCache(contents: unknown): void {
  writeFileSync(join(cacheDir, "settings.json"), JSON.stringify(contents));
}

describe("resolveWeekStart", () => {
  it("fetches and caches on a cold read", async () => {
    settingsGet.mockResolvedValue({ data: { value: "1" } });

    const result = await resolveWeekStart("someone@example.com");

    expect(result).toEqual({ day: 1, label: "monday", source: "account" });
    const cached = JSON.parse(readFileSync(join(cacheDir, "settings.json"), "utf-8"));
    expect(cached.week_start).toBe(1);
    expect(cached.fetched).toBeTruthy();
  });

  it("serves a fresh cache without refetching", async () => {
    writeCache({ week_start: 0, fetched: new Date().toISOString() });

    const result = await resolveWeekStart("someone@example.com");

    expect(result).toEqual({ day: 0, label: "sunday", source: "cache" });
    expect(settingsGet).not.toHaveBeenCalled();
  });

  it("refetches once the cached entry ages past the TTL", async () => {
    const ancient = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
    writeCache({ week_start: 0, fetched: ancient });
    settingsGet.mockResolvedValue({ data: { value: "6" } });

    const result = await resolveWeekStart("someone@example.com");

    expect(result).toEqual({ day: 6, label: "saturday", source: "account" });
    expect(settingsGet).toHaveBeenCalledOnce();
  });

  it("treats a corrupt cache as a miss, not an error", async () => {
    writeFileSync(join(cacheDir, "settings.json"), "{not json");
    settingsGet.mockResolvedValue({ data: { value: "1" } });

    await expect(resolveWeekStart("someone@example.com")).resolves.toMatchObject({
      source: "account",
    });
  });

  it("preserves unrelated keys when writing the cache", async () => {
    writeCache({ some_future_setting: "keep me" });
    settingsGet.mockResolvedValue({ data: { value: "1" } });

    await resolveWeekStart("someone@example.com");

    const cached = JSON.parse(readFileSync(join(cacheDir, "settings.json"), "utf-8"));
    expect(cached.some_future_setting).toBe("keep me");
    expect(cached.week_start).toBe(1);
  });

  it("falls back to Monday when the lookup throws", async () => {
    // A preference lookup must never fail the query it decorates.
    settingsGet.mockRejectedValue(new Error("insufficient permissions"));

    await expect(resolveWeekStart("someone@example.com")).resolves.toEqual({
      day: 1,
      label: "monday",
      source: "fallback",
    });
  });

  it("falls back to Monday on an unparseable or out-of-range value", async () => {
    for (const value of ["", "banana", "9", undefined]) {
      settingsGet.mockResolvedValue({ data: { value } });
      await expect(resolveWeekStart("someone@example.com")).resolves.toEqual({
        day: 1,
        label: "monday",
        source: "fallback",
      });
    }
  });

  it("does not cache a rejected value", async () => {
    settingsGet.mockResolvedValue({ data: { value: "banana" } });

    await resolveWeekStart("someone@example.com");

    expect(() => readFileSync(join(cacheDir, "settings.json"), "utf-8")).toThrow();
  });
});
