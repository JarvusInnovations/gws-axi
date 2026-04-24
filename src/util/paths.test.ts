import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOutputPath, sanitizeFileName } from "./paths.js";

describe("sanitizeFileName", () => {
  it("strips forward and back slashes", () => {
    expect(sanitizeFileName("report/2026/Q1.pdf")).toBe("report_2026_Q1.pdf");
    expect(sanitizeFileName("dir\\file.txt")).toBe("dir_file.txt");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeFileName("  spaced.txt  ")).toBe("spaced.txt");
  });

  it("falls back to 'file' for empty or whitespace-only input", () => {
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("   ")).toBe("file");
  });

  it("preserves internal spaces and dots", () => {
    expect(sanitizeFileName("My Document.v2.docx")).toBe("My Document.v2.docx");
  });
});

describe("resolveOutputPath", () => {
  let workDir: string;
  let prevCwd: string;

  beforeEach(async () => {
    prevCwd = process.cwd();
    // Use the realpath so comparisons work on macOS where /var/folders
    // resolves through /private — process.cwd() returns the canonical.
    workDir = await realpath(await mkdtemp(join(tmpdir(), "gws-axi-paths-test-")));
    process.chdir(workDir);
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  it("uses cwd + base name when no path is provided", async () => {
    const out = await resolveOutputPath(undefined, "hello.txt");
    expect(out).toBe(resolve(workDir, "hello.txt"));
  });

  it("sanitizes the default base name", async () => {
    const out = await resolveOutputPath(undefined, "a/b/c.txt");
    expect(out).toBe(resolve(workDir, "a_b_c.txt"));
  });

  it("treats trailing slash as a directory", async () => {
    const out = await resolveOutputPath("subdir/", "hello.txt");
    expect(out).toBe(resolve(workDir, "subdir", "hello.txt"));
  });

  it("treats an existing directory as a directory", async () => {
    const dir = join(workDir, "existing");
    await mkdir(dir);
    const out = await resolveOutputPath(dir, "hello.txt");
    expect(out).toBe(resolve(dir, "hello.txt"));
  });

  it("treats a non-existent file-like path as the output file", async () => {
    const out = await resolveOutputPath("./output.txt", "hello.txt");
    expect(out).toBe(resolve(workDir, "output.txt"));
  });

  it("treats an absolute file path as the output file", async () => {
    const out = await resolveOutputPath("/tmp/gws-axi-test-explicit.txt", "hello.txt");
    expect(out).toBe("/tmp/gws-axi-test-explicit.txt");
  });

  it("doesn't confuse an existing *file* with a directory", async () => {
    const f = join(workDir, "prior.txt");
    await writeFile(f, "x");
    // Pointing at an existing file with a different default base name
    // should use the provided path as the output file (overwriting).
    const out = await resolveOutputPath(f, "new.txt");
    expect(out).toBe(f);
  });
});
