import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseArgs } from "./flags.js";
import {
  exportHelpLine,
  expandPath,
  parseExportRequest,
  resolveExportPath,
  writeExport,
} from "./export.js";

const SPEC = { optional: ["--json-out", "--csv-out"] };
const parse = (args: string[]) => parseArgs(args, SPEC, "sheets query");

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gws-axi-export-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("parseExportRequest", () => {
  it("is undefined without an export flag", () => {
    expect(parseExportRequest(parse(["1AbC"]))).toBeUndefined();
  });

  it("reads the format and the optional path", () => {
    expect(parseExportRequest(parse(["--csv-out"]))).toEqual({
      format: "csv",
      flag: "--csv-out",
      path: undefined,
    });
    expect(parseExportRequest(parse(["--json-out=./q.json"]))?.path).toBe("./q.json");
  });

  it("refuses two export flags, naming both", () => {
    let err: AxiError | undefined;
    try {
      parseExportRequest(parse(["--csv-out", "--json-out"]));
    } catch (e) {
      err = e as AxiError;
    }
    expect(err?.code).toBe("VALIDATION_ERROR");
    expect(err?.message).toContain("--json-out");
    expect(err?.message).toContain("--csv-out");
  });
});

describe("resolveExportPath", () => {
  it("auto-generates <tmp>/gws-axi/<UTC stamp>-<kind>.<ext>", () => {
    const now = new Date("2026-10-25T08:30:04.123Z");
    expect(resolveExportPath({ format: "csv", flag: "--csv-out" }, "query", now)).toEqual({
      path: join(tmpdir(), "gws-axi", "2026-10-25T08-30-04-123Z-query.csv"),
      auto: true,
    });
  });

  it("expands ~/ and resolves relative paths", () => {
    expect(expandPath("~/x/q.csv")).toBe(join(homedir(), "x/q.csv"));
    expect(expandPath("q.csv")).toBe(resolve("q.csv"));
    expect(
      resolveExportPath({ format: "json", flag: "--json-out", path: "/a/b.json" }, "q"),
    ).toEqual({ path: "/a/b.json", auto: false });
  });
});

describe("writeExport", () => {
  it("writes an explicit path and reports wrote: and a jq line", () => {
    const path = join(tempDir(), "out.json");
    const out = writeExport({ format: "json", flag: "--json-out", path }, "query", "{}", {
      rows: 3,
      cols: 2,
    });
    expect(out.ok).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("{}");
    if (out.ok) expect(out.wrote).toBe(`${path} (3 rows, 2 cols)`);
    expect(out.helpLine).toContain(`jq '.rows[]' ${path}`);
  });

  it("writes an auto path 0600 under the temp dir", () => {
    const out = writeExport({ format: "csv", flag: "--csv-out" }, "test", "a,b\r\n", {
      rows: 1,
      cols: 2,
    });
    expect(out.ok).toBe(true);
    expect(out.path.startsWith(join(tmpdir(), "gws-axi"))).toBe(true);
    expect(statSync(out.path).mode & 0o777).toBe(0o600);
    expect(out.helpLine).toContain(`head ${out.path}`);
    rmSync(out.path);
  });

  it("is EXPORT_WRITE_FAILED, not a throw, when an explicit path's directory is missing", () => {
    const path = join(tempDir(), "nope", "out.csv");
    const out = writeExport({ format: "csv", flag: "--csv-out", path }, "query", "x", {
      rows: 1,
      cols: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("EXPORT_WRITE_FAILED");
      expect(out.error.message).toContain("directory does not exist");
      expect(out.error.path).toBe(path);
    }
  });

  it("quotes a path with spaces in the help line", () => {
    expect(exportHelpLine("csv", "/tmp/my file.csv")).toContain("head '/tmp/my file.csv'");
  });
});
