import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { availabilityOf } from "./availability.js";
import { parseFlags as parseCreate } from "./create.js";
import { parseFlags as parseUpdate } from "./update.js";

function err(fn: () => unknown): AxiError | undefined {
  try {
    fn();
  } catch (e) {
    return e as AxiError;
  }
  return undefined;
}

describe("calendar availability", () => {
  it("reads Google's transparency as free/busy, defaulting to busy", () => {
    expect(availabilityOf({ transparency: "transparent" })).toBe("free");
    expect(availabilityOf({ transparency: "opaque" })).toBe("busy");
    expect(availabilityOf({})).toBe("busy");
  });

  it("parses --free and --busy on create and update", () => {
    expect(
      parseCreate(["--summary", "x", "--start", "2026-01-01T10:00", "--free"]).availability,
    ).toBe("free");
    expect(parseUpdate(["ev1", "--busy"]).availability).toBe("busy");
  });

  it("refuses both at once", () => {
    expect(err(() => parseUpdate(["ev1", "--free", "--busy"]))?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects unknown flags instead of dropping them (#62)", () => {
    const e = err(() => parseUpdate(["ev1", "--transparency", "transparent"]));
    expect(e?.code).toBe("VALIDATION_ERROR");
    expect(e?.suggestions[0]).toContain("--free");
    expect(err(() => parseCreate(["--summary", "x", "--colour", "red"]))?.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("rejects a second event id on update", () => {
    expect(err(() => parseUpdate(["ev1", "ev2", "--free"]))?.code).toBe("VALIDATION_ERROR");
  });
});
