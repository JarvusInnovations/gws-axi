import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";

/**
 * `sheetsQueryCommand` against a mocked Sheets client, token store and fetch:
 * the request sent to gviz/tq, the wrapper unwrap, errors, truncation, exports.
 */

const get = vi.fn();
const fetchMock = vi.fn();

vi.mock("../../google/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../google/client.js")>()),
  sheetsClient: async () => ({ spreadsheets: { get } }),
}));
vi.mock("../../google/tokens.js", () => ({
  getValidAccessToken: async () => ({ access_token: "ya29.test-token" }),
}));

const { sheetsQueryCommand } = await import("./query.js");

const ID = "1AbC";
const ACCOUNT = "alice@example.com";

function tabs(list: Array<{ gid: number; title: string; frozen?: number }>) {
  get.mockResolvedValue({
    data: {
      spreadsheetId: ID,
      properties: { title: "Q4 Tracker" },
      sheets: list.map((t, index) => ({
        properties: {
          sheetId: t.gid,
          title: t.title,
          index,
          gridProperties: { rowCount: 100, columnCount: 4, frozenRowCount: t.frozen ?? 0 },
        },
      })),
    },
  });
}

function wrapped(obj: unknown): string {
  return `/*O_o*/\ngwsAxi(${JSON.stringify(obj)});`;
}

function respond(...bodies: Array<{ status?: number; body: string }>) {
  for (const b of bodies) {
    fetchMock.mockResolvedValueOnce(new Response(b.body, { status: b.status ?? 200 }));
  }
}

const OK = {
  version: "0.6",
  status: "ok",
  table: {
    cols: [
      { id: "A", label: "Item", type: "string" },
      { id: "sum-C", label: "sum Qty", type: "number" },
    ],
    rows: [
      { c: [{ v: "bolts" }, { v: 140 }] },
      { c: [{ v: "nuts" }, { v: 80 }] },
      { c: [{ v: "screws" }, null] },
    ],
  },
};

async function errorOf(fn: () => Promise<unknown>): Promise<AxiError> {
  try {
    await fn();
  } catch (err) {
    return err as AxiError;
  }
  throw new Error("expected a throw");
}

const dirs: string[] = [];
beforeEach(() => {
  get.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.exitCode = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("sheetsQueryCommand", () => {
  it("sends the query verbatim with the resolved gid, a bearer token, and headers=1 for a frozen row", async () => {
    tabs([
      { gid: 0, title: "Summary" },
      { gid: 7, title: "Costs", frozen: 1 },
    ]);
    respond({ body: wrapped(OK) });
    const query = "select A, sum(C) where D = 'open' group by A";
    const out = await sheetsQueryCommand(ACCOUNT, [ID, query, "--tab", "Costs"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const u = new URL(url);
    expect(u.pathname).toBe(`/spreadsheets/d/${ID}/gviz/tq`);
    expect(u.searchParams.get("tq")).toBe(query);
    expect(u.searchParams.get("gid")).toBe("7");
    expect(u.searchParams.get("headers")).toBe("1");
    expect(u.searchParams.has("sheet")).toBe(false);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ya29.test-token");

    expect(out).toContain("tab: Costs");
    expect(out).toContain("rows: 3");
    expect(out).toContain('columns: "A:Item(string), sum-C:sum Qty(number)"');
    expect(out).toContain('rows[3]{Item,"sum Qty"}:');
    expect(out).toContain('bolts,"140"');
    expect(out).toContain("Save the full result: --csv-out or --json-out");
    expect(out).toContain(`=QUERY(Costs!A:D, "${query}", 1)`);
    expect(out).toContain("--range 1:1 --raw");
  });

  it("leaves headers unset on an unfrozen tab, and honors --headers 0", async () => {
    tabs([{ gid: 0, title: "Costs" }]);
    respond({ body: wrapped(OK) }, { body: wrapped(OK) });
    await sheetsQueryCommand(ACCOUNT, [ID, "select *"]);
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.has("headers")).toBe(false);
    await sheetsQueryCommand(ACCOUNT, [ID, "select *", "--headers", "0"]);
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.get("headers")).toBe("0");
  });

  it("caps the preview with --limit, never the query", async () => {
    tabs([{ gid: 0, title: "Costs" }]);
    respond({ body: wrapped(OK) });
    const out = await sheetsQueryCommand(ACCOUNT, [
      ID,
      "select A, sum(C) group by A",
      "--limit",
      "2",
    ]);
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("tq")).toBe(
      "select A, sum(C) group by A",
    );
    expect(out).toContain("rows: 2 of 3");
    expect(out).toContain("rows[2]");
  });

  it("turns an error block into QUERY_ERROR with Google's message", async () => {
    tabs([{ gid: 0, title: "Costs" }]);
    respond({
      body: wrapped({
        status: "error",
        errors: [
          {
            reason: "invalid_query",
            message: "INVALID_QUERY",
            detailed_message: "Invalid query: NO_COLUMN: Z",
          },
        ],
      }),
    });
    const err = await errorOf(() => sheetsQueryCommand(ACCOUNT, [ID, "select Z"]));
    expect(err.code).toBe("QUERY_ERROR");
    expect(err.message).toBe("Invalid query: NO_COLUMN: Z");
  });

  it("reports a data_truncated warning in rows: and help[]", async () => {
    tabs([{ gid: 0, title: "Costs" }]);
    respond({
      body: wrapped({ ...OK, status: "warning", warnings: [{ reason: "data_truncated" }] }),
    });
    const out = await sheetsQueryCommand(ACCOUNT, [ID, "select *"]);
    expect(out).toContain("rows: 3 of 3 (Google truncated the result)");
    expect(out).toContain("Google truncated the result: narrow it with `where`");
  });

  it("renders an empty result as the canonical scalar", async () => {
    tabs([{ gid: 0, title: "Costs" }]);
    respond({ body: wrapped({ status: "ok", table: { cols: OK.table.cols, rows: [] } }) });
    const out = await sheetsQueryCommand(ACCOUNT, [ID, "select * where A = 'none'"]);
    expect(out).toContain("rows: no rows matched");
    expect(out).not.toContain("rows[");
  });

  it("resolves the tab locally: unknown is TAB_NOT_FOUND, none on a multi-tab file is TAB_REQUIRED", async () => {
    tabs([
      { gid: 0, title: "Summary" },
      { gid: 7, title: "Costs" },
    ]);
    expect(
      (await errorOf(() => sheetsQueryCommand(ACCOUNT, [ID, "select A", "--tab", "Nope"]))).code,
    ).toBe("TAB_NOT_FOUND");
    const required = await errorOf(() => sheetsQueryCommand(ACCOUNT, [ID, "select A"]));
    expect(required.code).toBe("TAB_REQUIRED");
    expect(required.suggestions.join(" ")).not.toContain("Nothing was written");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a refused token to ACCESS_DENIED and a 404 to SPREADSHEET_NOT_FOUND", async () => {
    tabs([{ gid: 0, title: "Costs" }]);
    respond({ status: 403, body: "<!DOCTYPE html>" }, { status: 404, body: "<!DOCTYPE html>" });
    expect((await errorOf(() => sheetsQueryCommand(ACCOUNT, [ID, "select A"]))).code).toBe(
      "ACCESS_DENIED",
    );
    expect((await errorOf(() => sheetsQueryCommand(ACCOUNT, [ID, "select A"]))).code).toBe(
      "SPREADSHEET_NOT_FOUND",
    );
  });

  it("refuses bad arguments before any call", async () => {
    for (const args of [
      [ID],
      [ID, "  "],
      [ID, "select A", "--limit", "-1"],
      [ID, "select A", "--headers", "one"],
      [ID, "select A", "--csv-out", "--json-out"],
      [ID, "select", "A"],
    ]) {
      expect((await errorOf(() => sheetsQueryCommand(ACCOUNT, args))).code).toBe(
        "VALIDATION_ERROR",
      );
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("writes the full result as JSON with ISO dates, beside the capped preview", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gws-axi-query-test-"));
    dirs.push(dir);
    tabs([{ gid: 0, title: "Costs" }]);
    respond({
      body: wrapped({
        status: "ok",
        table: {
          cols: [
            { id: "A", label: "Item", type: "string" },
            { id: "E", label: "Due", type: "date" },
          ],
          rows: [
            { c: [{ v: "bolts" }, { v: "Date(2026,0,15)", f: "2026-01-15" }] },
            { c: [{ v: "nuts" }, null] },
          ],
        },
      }),
    });
    const path = join(dir, "q.json");
    const out = await sheetsQueryCommand(ACCOUNT, [
      ID,
      "select A, E",
      "--limit",
      "1",
      `--json-out=${path}`,
    ]);
    expect(out).toContain("rows: 1 of 2");
    expect(out).toContain(`wrote: "${path} (2 rows, 2 cols)"`);
    expect(out).toContain(`jq '.rows[]' ${path}`);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      query: "select A, E",
      columns: [
        { id: "A", label: "Item", type: "string" },
        { id: "E", label: "Due", type: "date" },
      ],
      rows: [
        ["bolts", "2026-01-15"],
        ["nuts", null],
      ],
    });
  });

  it("writes Google's CSV from a second out:csv request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gws-axi-query-test-"));
    dirs.push(dir);
    tabs([{ gid: 0, title: "Costs" }]);
    const csv = '"Item","sum Qty"\n"bolts","140"\n"nuts","80"\n"screws",""';
    respond({ body: wrapped(OK) }, { body: csv });
    const path = join(dir, "q.csv");
    const out = await sheetsQueryCommand(ACCOUNT, [
      ID,
      "select A, sum(C) group by A",
      `--csv-out=${path}`,
    ]);
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.get("tqx")).toBe("out:csv");
    expect(readFileSync(path, "utf-8")).toBe(csv);
    expect(out).toContain(`wrote: "${path} (3 rows, 2 cols)"`);
  });

  it("keeps the preview and exits 1 when the export cannot be written", async () => {
    tabs([{ gid: 0, title: "Costs" }]);
    respond({ body: wrapped(OK) });
    const path = join(tmpdir(), "gws-axi-no-such-dir-for-test", "q.json");
    const out = await sheetsQueryCommand(ACCOUNT, [ID, "select A", `--json-out=${path}`]);
    expect(existsSync(path)).toBe(false);
    expect(out).toContain("export_error:");
    expect(out).toContain("code: EXPORT_WRITE_FAILED");
    expect(out).toContain("rows[3]");
    expect(process.exitCode).toBe(1);
  });
});
