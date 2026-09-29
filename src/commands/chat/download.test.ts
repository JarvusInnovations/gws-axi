import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { distinctNames, isDriveFile, parseDownloadFlags, selectAttachments } from "./download.js";

function errorFrom(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AxiError);
    return err as AxiError;
  }
  throw new Error("expected a throw");
}

const pdf = {
  contentName: "report.pdf",
  contentType: "application/pdf",
  source: "UPLOADED_CONTENT",
};
const gif = { contentName: "cat.gif", contentType: "image/gif", source: "UPLOADED_CONTENT" };
const doc = { contentName: "Plan", source: "DRIVE_FILE", driveDataRef: { driveFileId: "1AbC" } };

describe("selectAttachments", () => {
  it("takes all by default", () => {
    expect(selectAttachments([pdf, gif], undefined)).toEqual([pdf, gif]);
  });

  it("picks by 1-based position and by exact name", () => {
    expect(selectAttachments([pdf, gif], "2")).toEqual([gif]);
    expect(selectAttachments([pdf, gif], "report.pdf")).toEqual([pdf]);
  });

  it("refuses one that isn't there, listing what is", () => {
    for (const which of ["3", "0", "nope.txt"]) {
      const err = errorFrom(() => selectAttachments([pdf, gif], which));
      expect(err.code).toBe("ATTACHMENT_NOT_FOUND");
      expect(err.suggestions[0]).toBe("It has 2: 1. report.pdf, 2. cat.gif");
    }
  });
});

describe("distinctNames", () => {
  it("keeps distinct names and numbers repeats before the extension", () => {
    expect(distinctNames(["a.pdf", "b.pdf", "a.pdf", "a.pdf"])).toEqual([
      "a.pdf",
      "b.pdf",
      "a (2).pdf",
      "a (3).pdf",
    ]);
  });

  it("makes names safe for the filesystem and never blank", () => {
    expect(distinctNames(["../../etc/passwd", ""])).toEqual([".._.._etc_passwd", "attachment"]);
  });
});

describe("isDriveFile", () => {
  it("tells Drive files from uploads", () => {
    expect(isDriveFile(doc)).toBe(true);
    expect(isDriveFile(pdf)).toBe(false);
  });
});

describe("parseDownloadFlags", () => {
  it("accepts the three ways to name a message", () => {
    expect(() => parseDownloadFlags(["AAAA", "Hk2.Hk2"])).not.toThrow();
    expect(() => parseDownloadFlags(["spaces/AAAA/messages/Hk2.Hk2"])).not.toThrow();
    expect(() => parseDownloadFlags(["Hk2.Hk2", "--with", "bob@example.com"])).not.toThrow();
  });

  it("refuses a missing message and an unknown flag before any call", () => {
    expect(errorFrom(() => parseDownloadFlags(["AAAA"])).code).toBe("VALIDATION_ERROR");
    expect(errorFrom(() => parseDownloadFlags(["AAAA", "m", "--output", "x"])).message).toContain(
      "--output",
    );
  });
});
