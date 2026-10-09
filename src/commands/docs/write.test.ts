import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseWriteFlags } from "./write.js";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

describe("docs write flag parsing", () => {
  it("parses a file source with a tab", () => {
    const f = parseWriteFlags(["1Doc", "./notes.md", "--tab", "t.0"], "write");
    expect(f).toMatchObject({
      documentId: "1Doc",
      localPath: "./notes.md",
      tab: "t.0",
      stdin: false,
    });
  });

  it("parses stdin and --content sources", () => {
    expect(parseWriteFlags(["1Doc", "-"], "write").stdin).toBe(true);
    expect(parseWriteFlags(["1Doc", "--content", "# Hi"], "append").content).toBe("# Hi");
  });

  it("requires exactly one source", () => {
    expect(code(() => parseWriteFlags(["1Doc"], "write"))).toBe("VALIDATION_ERROR");
    expect(code(() => parseWriteFlags(["1Doc", "./a.md", "--content", "x"], "write"))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("lets create omit the source but not the title", () => {
    expect(parseWriteFlags(["--title", "Notes"], "create").localPath).toBeUndefined();
    expect(code(() => parseWriteFlags(["./a.md"], "create"))).toBe("VALIDATION_ERROR");
    expect(
      parseWriteFlags(["--title", "Notes", "./a.md", "--parent", "1F"], "create"),
    ).toMatchObject({
      title: "Notes",
      localPath: "./a.md",
      parent: "1F",
    });
  });

  it("rejects --tab with --new-tab, and --new-tab on append", () => {
    expect(
      code(() => parseWriteFlags(["1Doc", "./a.md", "--tab", "t.0", "--new-tab", "X"], "write")),
    ).toBe("VALIDATION_ERROR");
    expect(code(() => parseWriteFlags(["1Doc", "./a.md", "--new-tab", "X"], "append"))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("rejects unknown flags and missing values", () => {
    expect(code(() => parseWriteFlags(["1Doc", "./a.md", "--title", "x"], "write"))).toBe(
      "VALIDATION_ERROR",
    );
    expect(code(() => parseWriteFlags(["1Doc", "./a.md", "--tab"], "write"))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("requires the documentId outside create", () => {
    expect(code(() => parseWriteFlags(["--content", "x"], "append"))).toBe("VALIDATION_ERROR");
  });
});

describe("docs write --new-tab placement", () => {
  it("parses placement and emoji with --new-tab", () => {
    const f = parseWriteFlags(
      ["1Doc", "./a.md", "--new-tab", "Round 3", "--first", "--emoji", "📝"],
      "write",
    );
    expect(f.newTab).toBe("Round 3");
    expect(f.placement).toEqual({ first: true });
    expect(f.emoji).toBe("📝");
    expect(
      parseWriteFlags(["1Doc", "./a.md", "--new-tab", "X", "--after", "t.0"], "write").placement,
    ).toEqual({
      after: "t.0",
    });
    expect(
      parseWriteFlags(["1Doc", "./a.md", "--new-tab", "X"], "write").placement,
    ).toBeUndefined();
  });

  it("refuses placement or emoji without --new-tab, naming docs tabs update", () => {
    let err: AxiError | undefined;
    try {
      parseWriteFlags(["1Doc", "./a.md", "--tab", "t.0", "--first"], "write");
    } catch (e) {
      err = e as AxiError;
    }
    expect(err?.code).toBe("VALIDATION_ERROR");
    expect(err?.message).toContain("--first");
    expect(err?.suggestions?.join("\n")).toContain("docs tabs update");
    expect(code(() => parseWriteFlags(["1Doc", "./a.md", "--emoji", "📝"], "write"))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("refuses conflicting placement flags", () => {
    expect(
      code(() =>
        parseWriteFlags(["1Doc", "./a.md", "--new-tab", "X", "--first", "--last"], "write"),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      code(() =>
        parseWriteFlags(
          ["1Doc", "./a.md", "--new-tab", "X", "--under", "t.0", "--after", "t.1"],
          "write",
        ),
      ),
    ).toBe("VALIDATION_ERROR");
  });

  it("keeps placement flags off append and create", () => {
    expect(code(() => parseWriteFlags(["1Doc", "./a.md", "--first"], "append"))).toBe(
      "VALIDATION_ERROR",
    );
    expect(code(() => parseWriteFlags(["--title", "T", "--emoji", "📝"], "create"))).toBe(
      "VALIDATION_ERROR",
    );
  });
});

describe("docs write table help line", () => {
  it("appears only when a table was written without a cols hint", async () => {
    const { tableHelp } = await import("./write.js");
    expect(tableHelp([])).toBeUndefined();
    expect(tableHelp([{ cols: [0.25, 0.75] }])).toBeUndefined();
    expect(tableHelp([{}])).toMatch(
      /^A table was written with equal column widths; put `<!-- cols: 1 3 -->`/,
    );
    expect(tableHelp([{}, { cols: [0.5, 0.5] }, {}])).toMatch(/^2 tables were written/);
  });
});
