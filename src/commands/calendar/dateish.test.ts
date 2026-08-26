import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseDateishFlag, parseRangeFlag, resolveWindow, startOfWeek } from "./dateish.js";

// These tests assume the repo's configured local zone (America/New_York) for the
// DST cases; every other case is zone-agnostic. `now` is always injected, so no
// test depends on the wall clock.

/** Local wall-clock rendering of an instant, for zone-independent assertions. */
function local(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Whole days spanned by a window, by local midnight count. */
function spanDays(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / (24 * 3600 * 1000));
}

const NOW = new Date(2026, 7, 26, 14, 30, 0); // Wed 2026-08-26 14:30 local

describe("parseRangeFlag — per-edge precision", () => {
  it("opens a date-only value at that day's local midnight on the from edge", () => {
    expect(local(parseRangeFlag("2026-08-26", "from", NOW))).toBe("2026-08-26 00:00");
  });

  it("closes a date-only value at the NEXT local midnight on the to edge", () => {
    expect(local(parseRangeFlag("2026-08-26", "to", NOW))).toBe("2026-08-27 00:00");
  });

  it("makes --from D --to D cover the whole of day D", () => {
    const from = parseRangeFlag("2026-08-26", "from", NOW);
    const to = parseRangeFlag("2026-08-26", "to", NOW);
    expect(spanDays(from, to)).toBe(1);
  });

  it("keeps each edge independently monotonic", () => {
    // The rejected design (expand only when from === to) would make these two
    // windows identical. They must differ by exactly one day.
    const from = parseRangeFlag("2026-08-26", "from", NOW);
    const sameDay = parseRangeFlag("2026-08-26", "to", NOW);
    const nextDay = parseRangeFlag("2026-08-27", "to", NOW);
    expect(spanDays(from, sameDay)).toBe(1);
    expect(spanDays(from, nextDay)).toBe(2);
  });

  it("leaves instant values untouched on both edges", () => {
    expect(parseRangeFlag("2026-08-26T14:00:00-04:00", "from", NOW)).toBe(
      new Date("2026-08-26T14:00:00-04:00").toISOString(),
    );
    expect(parseRangeFlag("2026-08-26T14:00:00-04:00", "to", NOW)).toBe(
      new Date("2026-08-26T14:00:00-04:00").toISOString(),
    );
  });

  it("treats a local datetime as local on both edges (no day expansion)", () => {
    expect(local(parseRangeFlag("2026-08-26T00:00", "to", NOW))).toBe("2026-08-26 00:00");
  });

  it("rejects garbage through the existing parseDateishFlag error", () => {
    expect(() => parseRangeFlag("next thursday", "from", NOW)).toThrow(AxiError);
    expect(() => parseRangeFlag("", "from", NOW)).toThrow(/Missing date\/time value/);
  });
});

describe("parseRangeFlag — tokens", () => {
  it("resolves now to the current instant", () => {
    expect(parseRangeFlag("now", "to", NOW)).toBe(NOW.toISOString());
  });

  it("resolves day tokens with per-edge expansion", () => {
    expect(local(parseRangeFlag("today", "from", NOW))).toBe("2026-08-26 00:00");
    expect(local(parseRangeFlag("today", "to", NOW))).toBe("2026-08-27 00:00");
    expect(local(parseRangeFlag("tomorrow", "from", NOW))).toBe("2026-08-27 00:00");
    expect(local(parseRangeFlag("yesterday", "from", NOW))).toBe("2026-08-25 00:00");
  });

  it("resolves day and week offsets", () => {
    expect(local(parseRangeFlag("+6d", "to", NOW))).toBe("2026-09-02 00:00");
    expect(local(parseRangeFlag("-2d", "from", NOW))).toBe("2026-08-24 00:00");
    expect(local(parseRangeFlag("+1w", "from", NOW))).toBe("2026-09-02 00:00");
    expect(local(parseRangeFlag("-1w", "from", NOW))).toBe("2026-08-19 00:00");
  });

  it("treats hour offsets as instants, not days", () => {
    expect(parseRangeFlag("+4h", "to", NOW)).toBe(
      new Date(NOW.getTime() + 4 * 3600 * 1000).toISOString(),
    );
  });

  it("composes into the rest of today and the next seven days", () => {
    const restOfToday = {
      from: parseRangeFlag("now", "from", NOW),
      to: parseRangeFlag("today", "to", NOW),
    };
    expect(local(restOfToday.from)).toBe("2026-08-26 14:30");
    expect(local(restOfToday.to)).toBe("2026-08-27 00:00");

    const nextSeven = {
      from: parseRangeFlag("today", "from", NOW),
      to: parseRangeFlag("+6d", "to", NOW),
    };
    expect(spanDays(nextSeven.from, nextSeven.to)).toBe(7);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(parseRangeFlag(" Today ", "from", NOW)).toBe(parseRangeFlag("today", "from", NOW));
  });
});

describe("local-calendar arithmetic", () => {
  it("rolls over a month boundary", () => {
    const eom = new Date(2026, 7, 31, 9, 0, 0); // Aug 31
    expect(local(parseRangeFlag("+1d", "from", eom))).toBe("2026-09-01 00:00");
  });

  it("rolls over a year boundary", () => {
    const eoy = new Date(2026, 11, 31, 9, 0, 0); // Dec 31
    expect(local(parseRangeFlag("+1d", "from", eoy))).toBe("2027-01-01 00:00");
  });

  it("lands on local midnight across a spring-forward DST transition", () => {
    // 2026-03-08 is the US spring-forward date; that day is only 23h long, so
    // millisecond addition would land on 01:00 rather than midnight.
    const beforeDst = new Date(2026, 2, 7, 12, 0, 0);
    expect(local(parseRangeFlag("+1d", "from", beforeDst))).toBe("2026-03-08 00:00");
    expect(local(parseRangeFlag("+2d", "from", beforeDst))).toBe("2026-03-09 00:00");
  });

  it("lands on local midnight across a fall-back DST transition", () => {
    // 2026-11-01 is the US fall-back date (25h long).
    const beforeDst = new Date(2026, 9, 31, 12, 0, 0);
    expect(local(parseRangeFlag("+1d", "from", beforeDst))).toBe("2026-11-01 00:00");
    expect(local(parseRangeFlag("+2d", "from", beforeDst))).toBe("2026-11-02 00:00");
  });

  it("closes a date-only to edge at midnight even when that day is 23h long", () => {
    expect(local(parseRangeFlag("2026-03-08", "to", NOW))).toBe("2026-03-09 00:00");
  });
});

describe("startOfWeek", () => {
  const wednesday = new Date(2026, 7, 26, 14, 30, 0); // Wed
  const sunday = new Date(2026, 7, 30, 9, 0, 0);
  const monday = new Date(2026, 7, 24, 9, 0, 0);

  it("walks back to the configured start day (Monday)", () => {
    expect(local(startOfWeek(wednesday, 1).toISOString())).toBe("2026-08-24 00:00");
    expect(local(startOfWeek(sunday, 1).toISOString())).toBe("2026-08-24 00:00");
    expect(local(startOfWeek(monday, 1).toISOString())).toBe("2026-08-24 00:00");
  });

  it("walks back to the configured start day (Sunday)", () => {
    expect(local(startOfWeek(wednesday, 0).toISOString())).toBe("2026-08-23 00:00");
    expect(local(startOfWeek(sunday, 0).toISOString())).toBe("2026-08-30 00:00");
    expect(local(startOfWeek(monday, 0).toISOString())).toBe("2026-08-23 00:00");
  });

  it("walks back to the configured start day (Saturday)", () => {
    expect(local(startOfWeek(wednesday, 6).toISOString())).toBe("2026-08-22 00:00");
    expect(local(startOfWeek(sunday, 6).toISOString())).toBe("2026-08-29 00:00");
  });
});

describe("resolveWindow — shortcuts", () => {
  it("--today covers exactly today", () => {
    const w = resolveWindow({ today: true }, { now: NOW });
    expect(local(w.from as string)).toBe("2026-08-26 00:00");
    expect(local(w.to as string)).toBe("2026-08-27 00:00");
  });

  it("--this-week spans seven days from the configured start day", () => {
    for (const day of [0, 1, 6]) {
      const w = resolveWindow({ thisWeek: true }, { now: NOW, weekStartDay: day });
      expect(local(w.from as string)).toBe(local(startOfWeek(NOW, day).toISOString()));
      expect(spanDays(w.from as string, w.to as string)).toBe(7);
    }
  });

  it("--this-week defaults to Monday when no week start is supplied", () => {
    const w = resolveWindow({ thisWeek: true }, { now: NOW });
    expect(local(w.from as string)).toBe("2026-08-24 00:00");
    expect(local(w.to as string)).toBe("2026-08-31 00:00");
  });

  it("--this-week still spans seven local days across a DST transition", () => {
    const dstWeek = new Date(2026, 2, 10, 12, 0, 0); // week containing spring-forward
    const w = resolveWindow({ thisWeek: true }, { now: dstWeek, weekStartDay: 1 });
    expect(local(w.from as string)).toBe("2026-03-09 00:00");
    expect(local(w.to as string)).toBe("2026-03-16 00:00");
  });

  it("rejects two shortcuts at once", () => {
    expect(() => resolveWindow({ today: true, thisWeek: true }, { now: NOW })).toThrow(
      /Cannot combine --today and --this-week/,
    );
  });

  it("rejects a shortcut combined with an explicit edge", () => {
    expect(() => resolveWindow({ today: true, from: "2026-08-26" }, { now: NOW })).toThrow(
      /Cannot combine --today with --from/,
    );
    expect(() => resolveWindow({ thisWeek: true, to: "2026-08-26" }, { now: NOW })).toThrow(
      /Cannot combine --this-week with --to/,
    );
  });
});

describe("resolveWindow — empty windows and defaults", () => {
  it("rejects a zero-width window rather than returning nothing", () => {
    // The originating bug: this used to silently produce `count: 0`.
    expect(() =>
      resolveWindow({ from: "2026-08-26T00:00", to: "2026-08-26T00:00" }, { now: NOW }),
    ).toThrow(/Empty time range/);
  });

  it("rejects an inverted window", () => {
    expect(() =>
      resolveWindow({ from: "2026-08-26T10:00", to: "2026-08-26T09:00" }, { now: NOW }),
    ).toThrow(/is not before/);
  });

  it("accepts the date-only same-day window that used to be empty", () => {
    const w = resolveWindow({ from: "2026-08-26", to: "2026-08-26" }, { now: NOW });
    expect(spanDays(w.from as string, w.to as string)).toBe(1);
  });

  it("names the caller's own flag spellings in the error", () => {
    expect(() =>
      resolveWindow(
        { from: "2026-08-26T10:00", to: "2026-08-26T09:00" },
        { now: NOW, flagNames: { from: "--since", to: "--until" } },
      ),
    ).toThrow(/--since .* is not before --until/);
  });

  it("falls back to defaults for absent edges", () => {
    const w = resolveWindow(
      { to: "2026-08-30" },
      { now: NOW, defaults: { from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" } },
    );
    expect(w.from).toBe("2026-08-01T00:00:00.000Z");
    expect(local(w.to as string)).toBe("2026-08-31 00:00");
  });

  it("leaves both edges undefined when neither flag nor default is present", () => {
    expect(resolveWindow({}, { now: NOW })).toEqual({ from: undefined, to: undefined });
  });

  it("skips the empty-window check when only one edge is set", () => {
    const w = resolveWindow({ from: "2026-08-26" }, { now: NOW });
    expect(w.to).toBeUndefined();
  });
});

describe("parseDateishFlag is unchanged by the range layer", () => {
  it("still resolves a date-only value to that day's local midnight", () => {
    // `calendar create --start 2026-08-26` means midnight, NOT end of day.
    expect(local(parseDateishFlag("2026-08-26"))).toBe("2026-08-26 00:00");
  });

  it("does not accept range tokens", () => {
    expect(() => parseDateishFlag("today")).toThrow(AxiError);
  });
});

describe("resolveWindow — suggestion targeting", () => {
  it("suggests the shortcuts when the caller offers them", () => {
    try {
      resolveWindow({ from: "2026-08-26T10:00", to: "2026-08-26T09:00" }, { now: NOW });
      expect.unreachable();
    } catch (err) {
      expect((err as AxiError).suggestions.join(" ")).toMatch(/--today/);
    }
  });

  it("omits them for a command that has no such flags", () => {
    // `drive activity` takes --since/--until only; suggesting --today there
    // would be a dead-end (principles.md#no-dead-end-surfaces).
    try {
      resolveWindow(
        { from: "2026-08-26T10:00", to: "2026-08-26T09:00" },
        { now: NOW, shortcuts: false, flagNames: { from: "--since", to: "--until" } },
      );
      expect.unreachable();
    } catch (err) {
      expect((err as AxiError).suggestions.join(" ")).not.toMatch(/--today/);
    }
  });
});
