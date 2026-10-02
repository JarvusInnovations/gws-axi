import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { readAttachments } from "./draft.js";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

describe("gmail draft attachments", () => {
  const dir = mkdtempSync(join(tmpdir(), "gws-attach-"));
  writeFileSync(join(dir, "report.pdf"), Buffer.from([1, 2, 3]));

  it("reads files with their name and type", () => {
    const [a] = readAttachments([join(dir, "report.pdf")]);
    expect(a).toMatchObject({ name: "report.pdf", mimeType: "application/pdf" });
    expect(a.content.length).toBe(3);
  });

  it("refuses a missing path or a directory before drafting", () => {
    expect(code(() => readAttachments([join(dir, "nope.pdf")]))).toBe("LOCAL_FILE_NOT_FOUND");
    expect(code(() => readAttachments([dir]))).toBe("LOCAL_PATH_NOT_FILE");
  });
});
