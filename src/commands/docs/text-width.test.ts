import { describe, expect, it } from "vitest";
import { measureText } from "./text-width.js";
import { columnWidths, parseColsHint, parseMarkdown } from "./md-to-doc.js";
import { fitFontHelp } from "./write.js";

describe("measureText", () => {
  it("matches the Helvetica AFM widths at the given size", () => {
    expect(measureText("a", { sizePt: 11 })).toBeCloseTo(6.116, 3); // 556
    expect(measureText("A", { sizePt: 11, bold: true })).toBeCloseTo(7.942, 3); // 722 bold
    expect(measureText("W", { sizePt: 10 })).toBeCloseTo(9.44, 3); // 944
    expect(measureText(" ", { sizePt: 11 })).toBeCloseTo(3.058, 3); // 278
    expect(measureText("", { sizePt: 11 })).toBe(0);
  });

  it("measures accented Latin as its base letter and anything else as one em", () => {
    expect(measureText("é", { sizePt: 11 })).toBeCloseTo(measureText("e", { sizePt: 11 }), 6);
    expect(measureText("ü", { sizePt: 11, bold: true })).toBeCloseTo(
      measureText("u", { sizePt: 11, bold: true }),
      6,
    );
    expect(measureText("漢", { sizePt: 11 })).toBeCloseTo(11, 6);
    expect(measureText("📝", { sizePt: 11 })).toBeCloseTo(11, 6);
    expect(measureText("a b", { sizePt: 10 })).toBeCloseTo((556 + 278 + 556) / 100, 6);
  });
});

describe("parseColsHint with fit", () => {
  it("keeps fit entries and shares the rest among the numbers", () => {
    expect(parseColsHint("fit 1")).toEqual(["fit", 1]);
    expect(parseColsHint("fit 1 3")).toEqual(["fit", 0.25, 0.75]);
    expect(parseColsHint("FIT fit")).toEqual(["fit", "fit"]);
    expect(parseColsHint("fit 25% 75%")).toEqual(["fit", 0.25, 0.75]);
  });
});

describe("columnWidths", () => {
  const table = (md: string) => {
    const t = parseMarkdown(md).blocks.find((b) => b.kind === "table");
    if (!t || t.kind !== "table") throw new Error("no table");
    return t;
  };

  it("sizes a fit column to its widest line plus padding and margin, the rest to the other", () => {
    const t = table(
      "<!-- cols: fit 1 -->\n| Label | Value |\n| - | - |\n| **State** | Generating |\n| Owner | Chris |",
    );
    const [fit, flex] = columnWidths(t, 468, 11);
    // Widest line: "Owner" regular (O 778 + w 722 + n 556 + e 556 + r 333 = 2945 → 32.395pt)
    // beats the bold header "Label" (28.7pt) and bold "State" (26.9pt).
    const owner = measureText("Owner", { sizePt: 11 });
    expect(owner).toBeCloseTo(32.395, 3);
    expect(fit).toBe(Math.ceil(owner * 1.06 + 2 + 10));
    expect(flex).toBe(468 - fit);
  });

  it("counts a list item's indent and measures each hard-break segment separately", () => {
    const plain = table("<!-- cols: fit 1 -->\n| k | v |\n| - | - |\n| abc | x |");
    const listed = table("<!-- cols: fit 1 -->\n| k | v |\n| - | - |\n| - abc | x |");
    expect(columnWidths(listed, 468, 11)[0] - columnWidths(plain, 468, 11)[0]).toBeCloseTo(
      Math.round(36 * 1.06),
      -1,
    );
    const broken = table("<!-- cols: fit 1 -->\n| k | v |\n| - | - |\n| abc<br>abc | x |");
    expect(columnWidths(broken, 468, 11)[0]).toBe(columnWidths(plain, 468, 11)[0]);
  });

  it("never goes under the minimum, scales fits that would crowd out the flex columns, and allows all-fit", () => {
    const tiny = table("<!-- cols: fit 1 -->\n| a | b |\n| - | - |\n| . | x |");
    expect(columnWidths(tiny, 468, 11)[0]).toBe(24);
    const huge = table(`<!-- cols: fit 1 -->\n| a | b |\n| - | - |\n| ${"W".repeat(80)} | x |`);
    const [fit, flex] = columnWidths(huge, 468, 11);
    expect(fit + flex).toBeLessThanOrEqual(468);
    expect(flex).toBe(24);
    const all = table("<!-- cols: fit fit -->\n| a | b |\n| - | - |\n| one | two |");
    const w = columnWidths(all, 468, 11);
    expect(w.every((x) => x >= 24)).toBe(true);
    expect(w[0] + w[1]).toBeLessThan(468);
  });
});

describe("fitFontHelp", () => {
  it("notes only a fit on a non-Arial/Helvetica tab", () => {
    expect(fitFontHelp([{ cols: ["fit", 1] }], "Arial")).toBeUndefined();
    expect(fitFontHelp([{ cols: ["fit", 1] }], "Helvetica Neue")).toBeUndefined();
    expect(fitFontHelp([{ cols: [0.5, 0.5] }], "Droid Sans")).toBeUndefined();
    expect(fitFontHelp([{ cols: ["fit", 1] }], undefined)).toBeUndefined();
    expect(fitFontHelp([{ cols: ["fit", 1] }], "Georgia")).toMatch(
      /measured as Arial; this tab's body font is Georgia/,
    );
  });
});
