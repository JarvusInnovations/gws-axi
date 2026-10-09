import { describe, expect, it } from "vitest";
import type { AxiError } from "axi-sdk-js";
import type { docs_v1 } from "googleapis";
import { cellPlainText, parseEditCellFlags, resolveRow } from "./edit-cell.js";
import { cellFillRequests, parseCellMarkdown } from "./md-to-doc.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

const cell = (
  ...paras: Array<string | [string, docs_v1.Schema$TextStyle]>
): docs_v1.Schema$TableCell => ({
  content: paras.map((p) => ({
    paragraph: {
      elements: [
        typeof p === "string"
          ? { textRun: { content: p } }
          : { textRun: { content: p[0], textStyle: p[1] } },
      ],
    },
  })),
});
const table = (...rows: docs_v1.Schema$TableCell[][]): docs_v1.Schema$Table => ({
  tableRows: rows.map((cells) => ({ tableCells: cells })),
});

describe("docs edit-cell flag parsing", () => {
  it("parses the full form with defaults", () => {
    expect(parseEditCellFlags(["1Doc", "--row", "State", "--text", "x"])).toEqual({
      documentId: "1Doc",
      row: "State",
      text: "x",
      tab: undefined,
      table: 1,
      col: 2,
    });
    expect(
      parseEditCellFlags(["1Doc", "--row", "#3", "--text", "", "--table", "2", "--col", "1"]),
    ).toMatchObject({
      row: "#3",
      text: "",
      table: 2,
      col: 1,
    });
  });

  it("requires the id, --row and --text; --table/--col must be positive integers", () => {
    expect(codeOf(() => parseEditCellFlags(["--row", "a", "--text", "b"]))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codeOf(() => parseEditCellFlags(["1Doc", "--text", "b"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseEditCellFlags(["1Doc", "--row", " ", "--text", "b"]))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codeOf(() => parseEditCellFlags(["1Doc", "--row", "a"]))).toBe("VALIDATION_ERROR");
    expect(
      codeOf(() => parseEditCellFlags(["1Doc", "--row", "a", "--text", "b", "--col", "0"])),
    ).toBe("VALIDATION_ERROR");
  });
});

describe("resolveRow", () => {
  const t = table(
    [cell(["Label\n", { bold: true }]), cell("Value\n")],
    [cell(["State\n", { bold: true }]), cell("Generating\n")],
    [cell("Owner\n"), cell("Chris\n")],
    [cell("Owner\n"), cell("Dana\n")],
  );

  it("matches a label by text, emphasis ignored", () => {
    expect(resolveRow(t, "State")).toEqual({ match: { row: 2, label: "State" } });
  });

  it("takes #n as a row number, header included", () => {
    expect(resolveRow(t, "#1")).toEqual({ match: { row: 1, label: "Label" } });
    expect(resolveRow(t, "#9")).toMatchObject({ error: "not_found" });
  });

  it("reports ambiguity with the candidate rows, and not-found with every label", () => {
    expect(resolveRow(t, "Owner")).toEqual({
      error: "ambiguous",
      candidates: [
        { row: 3, label: "Owner" },
        { row: 4, label: "Owner" },
      ],
    });
    const miss = resolveRow(t, "state");
    expect(miss).toMatchObject({ error: "not_found" });
    expect("candidates" in miss && miss.candidates.map((c) => c.label)).toEqual([
      "Label",
      "State",
      "Owner",
      "Owner",
    ]);
  });
});

describe("cellPlainText and the fill", () => {
  it("joins paragraphs and hard breaks as lines", () => {
    expect(cellPlainText(cell("intro\u000bmore\n", "item\n"))).toBe("intro\nmore\nitem");
  });

  it("parses cell markdown on its own and fills from a given index without header bold", () => {
    const { cell: parsed, lossy } = parseCellMarkdown("**done**<br>- a\n- b");
    expect(lossy).toEqual([]);
    expect(
      parsed.paragraphs.map((p) => [p.inline.runs.map((r) => r.text).join(""), p.list]),
    ).toEqual([
      ["done", undefined],
      ["a", "bullet"],
      ["b", "bullet"],
    ]);
    const requests = cellFillRequests(parsed, 20, "t.0");
    expect(requests[0].insertText).toEqual({
      location: { index: 20, tabId: "t.0" },
      text: "done\na\nb",
    });
    expect(
      requests.some(
        (r) => r.updateTextStyle?.fields === "bold" && r.updateTextStyle.range?.startIndex === 20,
      ),
    ).toBe(true);
    expect(requests.at(-1)?.createParagraphBullets?.range).toEqual({
      startIndex: 25,
      endIndex: 29,
      tabId: "t.0",
    });
  });
});
