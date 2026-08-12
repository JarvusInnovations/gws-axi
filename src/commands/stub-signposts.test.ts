import { describe, expect, it } from "vitest";
import { notImplemented, renderAlternatives, withInstead } from "./stub-signposts.js";

const noop = async () => "";

describe("notImplemented", () => {
  it("leads with the alternatives, not the account diagnostic", () => {
    const err = notImplemented("sheets", "update", "me@x.com", [
      "gws-axi drive upload … --convert — replaces the ENTIRE spreadsheet",
    ]);
    expect(err.code).toBe("NOT_IMPLEMENTED");
    expect(err.suggestions[0]).toContain("drive upload");
    // Diagnostics are context, so they come after the next step.
    expect(err.suggestions[err.suggestions.length - 1]).toContain("me@x.com");
  });

  it("still points at the subcommand's planned surface", () => {
    const err = notImplemented("docs", "append", "me@x.com", ["do the other thing"]);
    expect(err.suggestions.some((s) => s.includes("gws-axi docs append --help"))).toBe(true);
  });

  it("says so explicitly when nothing comes close", () => {
    const err = notImplemented("drive", "move", "me@x.com");
    expect(err.suggestions[0]).toContain("No gws-axi command does this yet");
  });
});

describe("withInstead", () => {
  it("appends an instead[N] block sized to the lines", () => {
    const out = withInstead("usage: gws-axi sheets update …\nstatus: planned\n", ["a", "b"]);
    expect(out).toContain("instead[2]:\n  a\n  b");
  });

  it("falls back to the no-alternative line", () => {
    expect(withInstead("usage: …\n")).toContain("instead[1]:");
    expect(withInstead("usage: …\n")).toContain("No gws-axi command does this yet");
  });
});

describe("renderAlternatives", () => {
  it("dedupes lines shared across stubs", () => {
    const block = renderAlternatives([
      { name: "read", handler: noop },
      { name: "update", instead: ["shared line", "update only"] },
      { name: "append", instead: ["shared line"] },
    ]);
    expect(block).toContain("alternatives[2]:");
    expect(block.match(/shared line/g)).toHaveLength(1);
  });

  it("ignores alternatives on implemented subcommands", () => {
    const block = renderAlternatives([{ name: "read", handler: noop, instead: ["ignored"] }]);
    expect(block).toBe("");
  });

  it("returns empty for a service with nothing stubbed", () => {
    expect(renderAlternatives([{ name: "events", handler: noop }])).toBe("");
  });

  it("skips stubs that declare no alternative", () => {
    expect(renderAlternatives([{ name: "move" }])).toBe("");
  });
});
