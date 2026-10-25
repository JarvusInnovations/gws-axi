import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";

/**
 * `sheetsNoteCommand` against a mocked Sheets client: the request it sends,
 * that `unchanged` sends nothing, and the grid-bounds check.
 */

const get = vi.fn();
const batchUpdate = vi.fn();

vi.mock("../../google/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../google/client.js")>()),
  sheetsClient: async () => ({ spreadsheets: { get, batchUpdate } }),
}));

const { sheetsNoteCommand } = await import("./note.js");

const ID = "1AbC";
const ACCOUNT = "alice@example.com";

/** A one-tab spreadsheet, 10 rows x 4 columns, whose cell holds `note` (if any). */
function spreadsheet(note?: string) {
  get.mockImplementation(async (req: { includeGridData?: boolean; ranges?: string[] }) => {
    if (!req.includeGridData) {
      return {
        data: {
          spreadsheetId: ID,
          properties: { title: "Q4 Tracker" },
          sheets: [
            {
              properties: {
                sheetId: 7,
                title: "Costs",
                index: 0,
                gridProperties: { rowCount: 10, columnCount: 4 },
              },
            },
          ],
        },
      };
    }
    // Sheets echoes the requested cell's position (`'Costs'!B2` → row 1, col 1).
    const [, letter, row] = /!([A-Z])(\d+)$/.exec(req.ranges?.[0] ?? "") ?? [];
    const startRow = Number(row) - 1;
    const startColumn = (letter ?? "A").charCodeAt(0) - 65;
    return {
      data: {
        sheets: [
          {
            data: [
              {
                startRow,
                startColumn,
                rowData: [{ values: [{ formattedValue: "$4,200", ...(note ? { note } : {}) }] }],
              },
            ],
          },
        ],
      },
    };
  });
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

beforeEach(() => {
  get.mockReset();
  batchUpdate.mockReset();
  batchUpdate.mockResolvedValue({ status: 200 });
});

describe("sheetsNoteCommand", () => {
  it("sends one updateCells for the cell under the note mask", async () => {
    spreadsheet();
    const out = await sheetsNoteCommand(ACCOUNT, [ID, "B2", "--text", "estimate"]);
    expect(batchUpdate).toHaveBeenCalledTimes(1);
    expect(batchUpdate.mock.calls[0][0]).toEqual({
      spreadsheetId: ID,
      requestBody: {
        requests: [
          {
            updateCells: {
              start: { sheetId: 7, rowIndex: 1, columnIndex: 1 },
              rows: [{ values: [{ note: "estimate" }] }],
              fields: "note",
            },
          },
        ],
      },
    });
    expect(out).toContain("action: set");
    expect(out).toContain("cell: Costs!B2");
  });

  it("clears by sending the cell without a note", async () => {
    spreadsheet("estimate");
    const out = await sheetsNoteCommand(ACCOUNT, [ID, "B2", "--clear"]);
    const req = batchUpdate.mock.calls[0][0].requestBody.requests[0].updateCells;
    expect(req.rows).toEqual([{ values: [{}] }]);
    expect(req.fields).toBe("note");
    expect(out).toContain("action: cleared");
    expect(out).toContain("--text 'estimate'");
  });

  it("sends nothing when the note already reads that, or there is none to clear", async () => {
    spreadsheet("estimate");
    expect(await sheetsNoteCommand(ACCOUNT, [ID, "B2", "--text", "estimate"])).toContain(
      "action: unchanged",
    );
    spreadsheet();
    expect(await sheetsNoteCommand(ACCOUNT, [ID, "B2", "--clear"])).toContain("action: unchanged");
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it("allows the last row and column, and refuses one past either", async () => {
    spreadsheet();
    await sheetsNoteCommand(ACCOUNT, [ID, "D10", "--text", "x"]);
    expect(batchUpdate.mock.calls[0][0].requestBody.requests[0].updateCells.start).toEqual({
      sheetId: 7,
      rowIndex: 9,
      columnIndex: 3,
    });
    expect(await codeOf(() => sheetsNoteCommand(ACCOUNT, [ID, "D11", "--text", "x"]))).toBe(
      "RANGE_INVALID",
    );
    expect(await codeOf(() => sheetsNoteCommand(ACCOUNT, [ID, "E10", "--text", "x"]))).toBe(
      "RANGE_INVALID",
    );
    expect(batchUpdate).toHaveBeenCalledTimes(1);
  });

  it("points a long previous note at version history instead of an undo line", async () => {
    spreadsheet("y".repeat(2_001));
    const out = await sheetsNoteCommand(ACCOUNT, [ID, "B2", "--text", "short"]);
    expect(out).toContain(
      "The previous note (2001 characters) is in version history: gws-axi drive revisions 1AbC",
    );
    expect(out).not.toContain("to undo");
  });
});
