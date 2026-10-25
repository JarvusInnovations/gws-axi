import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  it("auto-generates <tmp>/gws-axi-<uid>/<UTC stamp>-<kind>.<ext>", () => {
    const now = new Date("2026-10-25T08:30:04.123Z");
    expect(resolveExportPath({ format: "csv", flag: "--csv-out" }, "query", now)).toEqual({
      path: join(tmpdir(), `gws-axi-${process.getuid?.()}`, "2026-10-25T08-30-04-123Z-query.csv"),
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

  describe("auto paths (TMPDIR pointed at a scratch dir)", () => {
    const savedTmp = process.env.TMPDIR;
    let root: string;
    let dir: string;
    const NOW = new Date("2026-10-25T08:30:04.123Z");
    const NAME = "2026-10-25T08-30-04-123Z-test.csv";
    const csvReq = { format: "csv" as const, flag: "--csv-out" };

    beforeEach(() => {
      root = tempDir();
      process.env.TMPDIR = root;
      dir = join(root, `gws-axi-${process.getuid?.()}`);
    });
    afterEach(() => {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
    });

    it("creates the per-user dir 0700 and writes the file 0600", () => {
      const out = writeExport(csvReq, "test", "a,b\r\n", { rows: 1, cols: 2 }, NOW);
      expect(out.ok).toBe(true);
      expect(out.path).toBe(join(dir, NAME));
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(out.path).mode & 0o777).toBe(0o600);
      expect(out.helpLine).toContain(`head ${out.path}`);
    });

    it("refuses a pre-existing dir that others can write, writing nothing", () => {
      mkdirSync(dir);
      chmodSync(dir, 0o777);
      const out = writeExport(csvReq, "test", "secret", { rows: 1, cols: 1 }, NOW);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe("EXPORT_WRITE_FAILED");
        expect(out.error.message).toContain("readable or writable by others");
      }
      expect(() => statSync(join(dir, NAME))).toThrow();
    });

    it("refuses a symlink in place of the dir", () => {
      const elsewhere = join(root, "elsewhere");
      mkdirSync(elsewhere, { mode: 0o700 });
      symlinkSync(elsewhere, dir);
      const out = writeExport(csvReq, "test", "secret", { rows: 1, cols: 1 }, NOW);
      expect(out.ok).toBe(false);
      expect(() => statSync(join(elsewhere, NAME))).toThrow();
    });

    it("never writes through a symlink at the target name, taking the next suffix instead", () => {
      mkdirSync(dir, { mode: 0o700 });
      const victim = join(root, "victim.txt");
      writeFileSync(victim, "untouched");
      symlinkSync(victim, join(dir, NAME));
      const out = writeExport(csvReq, "test", "secret", { rows: 1, cols: 1 }, NOW);
      expect(out.ok).toBe(true);
      expect(out.path).toBe(join(dir, "2026-10-25T08-30-04-123Z-test-2.csv"));
      expect(readFileSync(victim, "utf-8")).toBe("untouched");
    });

    it("suffixes -2, -3 on a name collision instead of overwriting", () => {
      const a = writeExport(csvReq, "test", "one", { rows: 1, cols: 1 }, NOW);
      const b = writeExport(csvReq, "test", "two", { rows: 1, cols: 1 }, NOW);
      const c = writeExport(csvReq, "test", "three", { rows: 1, cols: 1 }, NOW);
      expect([a.path, b.path, c.path]).toEqual([
        join(dir, NAME),
        join(dir, "2026-10-25T08-30-04-123Z-test-2.csv"),
        join(dir, "2026-10-25T08-30-04-123Z-test-3.csv"),
      ]);
      expect(readFileSync(a.path, "utf-8")).toBe("one");
    });
  });

  it("says overwrote when an explicit path replaced a file", () => {
    const path = join(tempDir(), "out.csv");
    writeFileSync(path, "old");
    const out = writeExport({ format: "csv", flag: "--csv-out", path }, "q", "new", {
      rows: 1,
      cols: 1,
    });
    expect(out.ok && out.wrote).toBe(`${path} (1 rows, 1 cols, overwrote)`);
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
