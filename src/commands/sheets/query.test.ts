import { describe, expect, it } from "vitest";
import type { GvizColumn } from "../../google/gviz.js";
import { csvError, gvizUrl, unwrapGviz } from "../../google/gviz.js";
import {
  columnNames,
  columnsLine,
  displayCell,
  isoValue,
  markedQuery,
  queryError,
  queryFormula,
  rawCell,
  rowsLine,
} from "./query.js";

const col = (id: string, label: string, type = "string"): GvizColumn => ({ id, label, type });

describe("columnNames", () => {
  it("uses the label, falls back to the id, and disambiguates repeats with the id", () => {
    expect(
      columnNames([
        col("A", "Item"),
        col("B", ""),
        col("C", "Qty"),
        col("D", "Qty"),
        col("E", " "),
      ]),
    ).toEqual(["Item", "B", "Qty (C)", "Qty (D)", "E"]);
  });

  it("never yields two equal names", () => {
    const names = columnNames([col("A", "B"), col("B", "")]);
    expect(new Set(names).size).toBe(2);
  });
});

describe("displayCell", () => {
  it("prefers f, else renders v", () => {
    expect(displayCell({ v: 0.05, f: "$0.05" }, col("C", "Price", "number"))).toBe("$0.05");
    expect(displayCell({ v: 40 }, col("sum-B", "sum Qty", "number"))).toBe("40");
    expect(displayCell({ v: "bolts" }, col("A", "Item"))).toBe("bolts");
    expect(displayCell({ v: true }, col("F", "Done", "boolean"))).toBe("TRUE");
  });

  it("is empty for null cells in both shapes", () => {
    expect(displayCell(null, col("B", "Qty", "number"))).toBe("");
    expect(displayCell({ v: null }, col("B", "Qty", "number"))).toBe("");
  });

  it("renders unformatted dates with the zero-based month corrected", () => {
    expect(displayCell({ v: "Date(2026,0,15)" }, col("E", "Due", "date"))).toBe("2026-01-15");
    expect(displayCell({ v: "Date(2026,9,25,12,30,4)" }, col("now_", "now()", "datetime"))).toBe(
      "2026-10-25 12:30:04",
    );
    expect(displayCell({ v: [9, 5, 0, 0] }, col("T", "At", "timeofday"))).toBe("09:05:00");
  });
});

describe("rawCell / isoValue", () => {
  it("keeps v, but writes dates as ISO strings", () => {
    expect(rawCell({ v: 40, f: "40" }, col("B", "Qty", "number"))).toBe(40);
    expect(rawCell({ v: "Date(2026,1,1)", f: "2026-02-01" }, col("E", "Due", "date"))).toBe(
      "2026-02-01",
    );
    expect(rawCell({ v: "Date(2026,9,25,12,30,4)" }, col("n", "now()", "datetime"))).toBe(
      "2026-10-25T12:30:04",
    );
    expect(rawCell(null, col("B", "Qty", "number"))).toBeNull();
  });

  it("leaves a string that only looks like a date alone in a string column", () => {
    expect(isoValue("Date(2026,0,1)", "string")).toBeUndefined();
  });
});

describe("rowsLine", () => {
  it("has three forms", () => {
    expect(rowsLine(12, 12, false)).toBe(12);
    expect(rowsLine(50, 7143, false)).toBe("50 of 7143");
    expect(rowsLine(50, 500, true)).toBe("50 of 500 (Google truncated the result)");
  });
});

describe("columnsLine", () => {
  it("is id:label(type)", () => {
    expect(columnsLine([col("A", "Item"), col("sum-C", "sum Qty", "number")])).toBe(
      "A:Item(string), sum-C:sum Qty(number)",
    );
  });
});

describe("queryFormula", () => {
  it("spans the tab's columns, doubles quotes, and carries headers when sent", () => {
    expect(queryFormula({ title: "Costs", cols: 4 }, "select A where B = 'x'", 1)).toBe(
      `=QUERY(Costs!A:D, "select A where B = 'x'", 1)`,
    );
    expect(queryFormula({ title: "It's Mine", cols: 26 }, 'select "A"', undefined)).toBe(
      `=QUERY('It''s Mine'!A:Z, "select ""A""")`,
    );
  });
});

describe("query errors", () => {
  const parseError = {
    status: "error" as const,
    errors: [
      {
        reason: "invalid_query",
        message: "INVALID_QUERY",
        detailed_message:
          'Invalid query: PARSE_ERROR: Encountered " <ID> "selec "" at line 1, column 1.\nWas expecting one of:\n    <EOF> \n    "select" ...',
      },
    ],
  };

  it("passes detailed_message through as QUERY_ERROR, folded onto one line", () => {
    const err = queryError(parseError, "selec A", "alice@example.com");
    expect(err.code).toBe("QUERY_ERROR");
    expect(err.message).toBe(
      'Invalid query: PARSE_ERROR: Encountered " <ID> "selec "" at line 1, column 1. Was expecting one of: <EOF> "select" ...',
    );
    expect(err.suggestions[0]).toBe("query (» marks line 1, column 1): »selec A");
    expect(err.suggestions.at(-1)).toContain("developers.google.com/chart");
  });

  it("names an unknown reason, and maps access_denied", () => {
    const odd = queryError(
      { status: "error", errors: [{ reason: "timeout", message: "Timed out" }] },
      "select A",
      "alice@example.com",
    );
    expect(odd.code).toBe("QUERY_ERROR");
    expect(odd.message).toBe("Query failed (timeout): Timed out");
    const denied = queryError(
      { status: "error", errors: [{ reason: "access_denied", message: "Access denied" }] },
      "select A",
      "alice@example.com",
    );
    expect(denied.code).toBe("ACCESS_DENIED");
  });

  it("marks a position on a later line of a multi-line query", () => {
    expect(markedQuery("select A\nwhere B >", "at line 2, column 7.")).toBe(
      "query (» marks line 2, column 7): select A where »B >",
    );
    expect(markedQuery("select Z", "Invalid query: NO_COLUMN: Z")).toBe("query: select Z");
  });
});

describe("gviz endpoint helpers", () => {
  it("builds the URL with gid, headers and the fixed handler", () => {
    const url = new URL(
      gvizUrl(
        { spreadsheetId: "1AbC", gid: 7, query: "select A where B = 'x'", headers: 1 },
        "json",
      ),
    );
    expect(url.pathname).toBe("/spreadsheets/d/1AbC/gviz/tq");
    expect(url.searchParams.get("tq")).toBe("select A where B = 'x'");
    expect(url.searchParams.get("gid")).toBe("7");
    expect(url.searchParams.get("headers")).toBe("1");
    expect(url.searchParams.get("tqx")).toBe("out:json;responseHandler:gwsAxi");
    expect(url.searchParams.has("sheet")).toBe(false);
    const csv = new URL(gvizUrl({ spreadsheetId: "1AbC", gid: 0, query: "select *" }, "csv"));
    expect(csv.searchParams.get("tqx")).toBe("out:csv");
    expect(csv.searchParams.has("headers")).toBe(false);
  });

  it("unwraps the named wrapper and the default one", () => {
    expect(
      unwrapGviz('/*O_o*/\ngwsAxi({"status":"ok","table":{"cols":[],"rows":[]}});').status,
    ).toBe("ok");
    expect(
      unwrapGviz('/*O_o*/\ngoogle.visualization.Query.setResponse({"status":"error","errors":[]});')
        .status,
    ).toBe("error");
  });

  it("fails loud with the body's head on an unrecognizable response", () => {
    expect(() => unwrapGviz("<!DOCTYPE html><html>")).toThrow(/Unexpected response/);
  });

  it("recognizes the JSON error object a CSV request returns", () => {
    expect(
      csvError('{"version":"0.6","status":"error","errors":[{"reason":"invalid_query"}]}'),
    ).toBeDefined();
    expect(csvError('"Item","Qty"\r\n"bolts","40"')).toBeUndefined();
  });
});
