import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIME_TYPE,
  detectMimeType,
  googleConversionTarget,
} from "./mime-types.js";

describe("detectMimeType", () => {
  it("maps common office and document extensions", () => {
    expect(detectMimeType("report.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(detectMimeType("data.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(detectMimeType("deck.pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(detectMimeType("notes.pdf")).toBe("application/pdf");
    expect(detectMimeType("rows.csv")).toBe("text/csv");
  });

  it("is case-insensitive on the extension", () => {
    expect(detectMimeType("PHOTO.JPG")).toBe("image/jpeg");
    expect(detectMimeType("Report.DOCX")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("resolves full and relative paths by their extension", () => {
    expect(detectMimeType("/home/me/pics/cat.png")).toBe("image/png");
    expect(detectMimeType("./sub/dir/file.md")).toBe("text/markdown");
  });

  it("falls back to octet-stream for unknown or absent extensions", () => {
    expect(detectMimeType("mystery.xyz")).toBe(DEFAULT_MIME_TYPE);
    expect(detectMimeType("Makefile")).toBe(DEFAULT_MIME_TYPE);
    expect(detectMimeType("archive.")).toBe(DEFAULT_MIME_TYPE);
  });
});

describe("googleConversionTarget", () => {
  it("maps word-processing and text sources to Google Doc", () => {
    expect(
      googleConversionTarget(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("application/vnd.google-apps.document");
    expect(googleConversionTarget("text/plain")).toBe(
      "application/vnd.google-apps.document",
    );
    expect(googleConversionTarget("text/markdown")).toBe(
      "application/vnd.google-apps.document",
    );
  });

  it("maps spreadsheet and delimited sources to Google Sheet", () => {
    expect(googleConversionTarget("text/csv")).toBe(
      "application/vnd.google-apps.spreadsheet",
    );
    expect(
      googleConversionTarget(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("application/vnd.google-apps.spreadsheet");
  });

  it("maps presentation sources to Google Slides", () => {
    expect(googleConversionTarget("application/vnd.ms-powerpoint")).toBe(
      "application/vnd.google-apps.presentation",
    );
  });

  it("is case-insensitive on the source mime", () => {
    expect(googleConversionTarget("TEXT/CSV")).toBe(
      "application/vnd.google-apps.spreadsheet",
    );
  });

  it("returns null for unsupported source types", () => {
    expect(googleConversionTarget("application/pdf")).toBeNull();
    expect(googleConversionTarget("image/png")).toBeNull();
    expect(googleConversionTarget("application/zip")).toBeNull();
  });
});
