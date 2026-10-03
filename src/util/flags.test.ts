import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseArgs, parseChoice, parseChoices, parseLimit } from "./flags.js";

const SPEC = { value: ["--limit", "--since"], boolean: ["--full"] };

function errorFrom(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AxiError);
    return err as AxiError;
  }
  throw new Error("expected a throw");
}

describe("parseArgs", () => {
  it("separates values, booleans, and positionals", () => {
    const parsed = parseArgs(["AAAA", "--limit", "5", "--full", "extra"], SPEC, "chat messages");
    expect(parsed.values).toEqual({ "--limit": "5" });
    expect([...parsed.booleans]).toEqual(["--full"]);
    expect(parsed.positionals).toEqual(["AAAA", "extra"]);
  });

  it("refuses an unknown flag by name and lists the valid ones", () => {
    const err = errorFrom(() => parseArgs(["--limt", "5"], SPEC, "chat messages"));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("--limt");
    expect(err.suggestions[0]).toContain("--limit");
    expect(err.suggestions[0]).toContain("--account");
  });

  it("refuses a value flag with nothing after it", () => {
    expect(errorFrom(() => parseArgs(["--limit"], SPEC, "chat messages")).message).toContain(
      "--limit needs a value",
    );
    expect(
      errorFrom(() => parseArgs(["--limit", "--full"], SPEC, "chat messages")).message,
    ).toContain("--limit needs a value");
  });

  it("accepts a relative token that starts with a dash as a value", () => {
    expect(parseArgs(["--since", "-7d"], SPEC, "chat messages").values["--since"]).toBe("-7d");
  });

  it("treats a lone dash as a positional", () => {
    expect(parseArgs(["-"], SPEC, "chat send").positionals).toEqual(["-"]);
  });
});

describe("parseLimit", () => {
  const bounds = { fallback: 50, max: 1000 };

  it("defaults, accepts, and clamps", () => {
    expect(parseLimit(undefined, bounds, "chat messages")).toBe(50);
    expect(parseLimit("25", bounds, "chat messages")).toBe(25);
    expect(parseLimit("5000", bounds, "chat messages")).toBe(1000);
  });

  it.each(["0", "-3", "abc", "2.5", ""])("refuses %j", (raw) => {
    expect(errorFrom(() => parseLimit(raw, bounds, "chat messages")).code).toBe("VALIDATION_ERROR");
  });
});

describe("parseChoice / parseChoices", () => {
  const kinds = ["space", "group", "dm"] as const;

  it("accepts a known value in any case", () => {
    expect(parseChoice("--type", "DM", kinds)).toBe("dm");
    expect(parseChoice("--type", undefined, kinds)).toBeUndefined();
  });

  it("refuses an unknown value and lists the known ones", () => {
    const err = errorFrom(() => parseChoice("--type", "room", kinds));
    expect(err.suggestions[0]).toBe("Valid values: space, group, dm");
  });

  it("parses a list, dropping repeats", () => {
    expect(parseChoices("--fields", "dm, space,dm", kinds)).toEqual(["dm", "space"]);
    expect(errorFrom(() => parseChoices("--fields", "dm,nope", kinds)).message).toContain("nope");
  });
});
