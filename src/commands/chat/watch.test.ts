import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import {
  formatDuration,
  parseAfter,
  parseDuration,
  parseWatchFlags,
  resumeCommand,
} from "./watch.js";

function errorFrom(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AxiError);
    return err as AxiError;
  }
  throw new Error("expected a throw");
}

describe("durations", () => {
  it("parses seconds, minutes, hours, and 0 for no limit", () => {
    expect(parseDuration("--timeout", "30s")).toBe(30_000);
    expect(parseDuration("--timeout", "9m")).toBe(540_000);
    expect(parseDuration("--timeout", "1h")).toBe(3_600_000);
    expect(parseDuration("--timeout", "0")).toBe(0);
  });

  it.each(["9", "9 m", "-1m", "1.5m", "1d", ""])("refuses %j", (raw) => {
    expect(errorFrom(() => parseDuration("--timeout", raw)).code).toBe("VALIDATION_ERROR");
  });

  it("formats back to the shortest form", () => {
    expect(formatDuration(540_000)).toBe("9m");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(20_000)).toBe("20s");
  });
});

describe("--after", () => {
  it("passes a cursor through untouched, microseconds and all", () => {
    expect(parseAfter("2026-09-30T14:14:07.255999Z")).toBe("2026-09-30T14:14:07.255999Z");
  });

  it("converts a relative time into a cursor", () => {
    const now = new Date("2026-09-30T15:00:00.000Z");
    expect(parseAfter("-1h", now)).toBe("2026-09-30T14:00:00.000000Z");
  });

  it("refuses something that is neither", () => {
    expect(errorFrom(() => parseAfter("last tuesday")).code).toBe("VALIDATION_ERROR");
  });
});

describe("parseWatchFlags", () => {
  it("defaults the timeout under each harness ceiling", () => {
    expect(parseWatchFlags(["AAAA"], "wait").timeoutMs).toBe(9 * 60_000);
    expect(parseWatchFlags(["AAAA"], "watch").timeoutMs).toBe(29 * 60_000);
  });

  it("defaults the interval, slower for --all, and refuses one under 5s", () => {
    expect(parseWatchFlags(["AAAA"], "watch").intervalMs).toBe(15_000);
    expect(parseWatchFlags(["--all"], "watch").intervalMs).toBe(30_000);
    expect(
      errorFrom(() => parseWatchFlags(["AAAA", "--interval", "2s"], "watch")).message,
    ).toContain("5s");
  });

  it("requires exactly one kind of target", () => {
    expect(errorFrom(() => parseWatchFlags([], "wait")).message).toContain("Nothing to watch");
    expect(errorFrom(() => parseWatchFlags(["AAAA", "--all"], "wait")).message).toContain(
      "only one",
    );
    expect(
      errorFrom(() => parseWatchFlags(["--with", "bob@example.com", "--all"], "wait")).message,
    ).toContain("only one");
    expect(parseWatchFlags(["AAAA", "BBBB"], "watch").spaces).toEqual(["AAAA", "BBBB"]);
  });

  it("allows --thread only with one conversation and --type only with --all", () => {
    expect(parseWatchFlags(["AAAA", "--thread", "spaces/AAAA/threads/t8Q"], "wait").thread).toBe(
      "t8Q",
    );
    expect(errorFrom(() => parseWatchFlags(["AAAA", "BBBB", "--thread", "t8Q"], "wait")).code).toBe(
      "VALIDATION_ERROR",
    );
    expect(errorFrom(() => parseWatchFlags(["AAAA", "--type", "dm"], "wait")).message).toContain(
      "--all",
    );
    expect(parseWatchFlags(["--all", "--type", "dm"], "watch").type).toBe("dm");
  });

  it("offers --full on wait only", () => {
    expect(parseWatchFlags(["AAAA", "--full"], "wait").full).toBe(true);
    expect(errorFrom(() => parseWatchFlags(["AAAA", "--full"], "watch")).code).toBe(
      "VALIDATION_ERROR",
    );
  });
});

describe("resumeCommand", () => {
  it("repeats the flags with a new --after, replacing any old one", () => {
    expect(
      resumeCommand(
        "watch",
        ["AAAA", "--after", "old", "--from", "bob@example.com"],
        "2026-09-30T14:14:07.255999Z",
      ),
    ).toBe("gws-axi chat watch AAAA --from bob@example.com --after 2026-09-30T14:14:07.255999Z");
  });
});
