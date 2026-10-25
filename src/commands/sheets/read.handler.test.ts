import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCsv } from "./values.js";

/**
 * `sheetsReadCommand`'s export flags against a mocked Sheets client: the whole
 * tab is fetched and written while the preview stays capped.
 */

const get = vi.fn();

vi.mock("../../google/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../google/client.js")>()),
  sheetsClient: async () => ({ spreadsheets: { get } }),
}));

const { sheetsReadCommand } = await import("./read.js");

const ID = "1AbC";
const ACCOUNT = "alice@example.com";
const ROWS = 200;

function tall() {
  get.mockImplementation(async (req: { includeGridData?: boolean; ranges?: string[] }) => {
    if (!req.includeGridData) {
      return {
        data: {
          spreadsheetId: ID,
          properties: { title: "Q4 Tracker" },
          sheets: [
            {
              properties: {
                sheetId: 0,
                title: "Costs",
                index: 0,
                gridProperties: { rowCount: 1000, columnCount: 3, frozenRowCount: 1 },
              },
            },
          ],
        },
      };
    }
    const rowData = [
      { values: [{ formattedValue: "Item" }, { formattedValue: "Qty" }] },
      ...Array.from({ length: ROWS }, (_, i) => ({
        values: [
          {
            formattedValue: `item ${i + 1}`,
            hyperlink: i === 0 ? "https://example.com/a" : undefined,
          },
          { formattedValue: `${(i + 1) * 3}` },
        ],
      })),
    ];
    return { data: { sheets: [{ data: [{ rowData }] }] } };
  });
}

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gws-axi-read-test-"));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  get.mockReset();
  process.exitCode = undefined;
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("sheetsReadCommand exports", () => {
  it("suggests the export when the render was capped", async () => {
    tall();
    const out = await sheetsReadCommand(ACCOUNT, [ID]);
    expect(out).toContain("Save the whole tab: --csv-out or --json-out");
    // Without an export the default read is bounded to the render window.
    expect(get.mock.calls[1][0].ranges).toEqual(["'Costs'!A1:C52"]);
  });

  it("--csv-out fetches the whole tab, writes every row header-first, and keeps the 50-row preview", async () => {
    tall();
    const path = join(tempDir(), "costs.csv");
    const out = await sheetsReadCommand(ACCOUNT, [ID, `--csv-out=${path}`]);
    expect(get.mock.calls[1][0].ranges).toEqual(["'Costs'"]);
    const rows = parseCsv(readFileSync(path, "utf-8"));
    expect(rows).toHaveLength(ROWS + 1);
    expect(rows[0]).toEqual(["Item", "Qty"]);
    // Plain display text in the file — no markdown link wrapping.
    expect(rows[1]).toEqual(["item 1", "3"]);
    expect(out).toContain("rows[50]");
    expect(out).toContain(`wrote: "${path} (200 rows, 2 cols)"`);
    expect(out).toContain('columns: "Item:string, Qty:string"');
    expect(out).toContain(`head ${path}`);
    expect(out).toContain("cells_total_rows: 200");
  });

  it("--json-out writes {tab, origin, columns, rows} with the header promoted out of rows", async () => {
    tall();
    const path = join(tempDir(), "costs.json");
    await sheetsReadCommand(ACCOUNT, [ID, `--json-out=${path}`]);
    const json = JSON.parse(readFileSync(path, "utf-8"));
    expect(json.tab).toBe("Costs");
    expect(json.origin).toBe("A2");
    expect(json.columns).toEqual(["Item", "Qty"]);
    expect(json.rows).toHaveLength(ROWS);
    expect(json.rows[ROWS - 1]).toEqual([`item ${ROWS}`, `${ROWS * 3}`]);
  });

  it("refuses two export flags and an export flag given a value without =", async () => {
    tall();
    await expect(sheetsReadCommand(ACCOUNT, [ID, "--csv-out", "--json-out"])).rejects.toThrow(
      /one export flag/,
    );
    await expect(sheetsReadCommand(ACCOUNT, [ID, "--csv-out", "./x.csv"])).rejects.toThrow(
      "--csv-out takes its path with =: --csv-out=./x.csv",
    );
    await expect(sheetsReadCommand(ACCOUNT, [ID, "extra"])).rejects.toThrow(/Unexpected argument/);
  });
});
