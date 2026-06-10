import { AxiError } from "axi-sdk-js";
import type { gmail_v1 } from "googleapis";
import { describe, expect, it } from "vitest";
import {
  isSystemLabel,
  labelNamesFor,
  resolveLabelId,
  resolveLabelIds,
} from "./labels-shared.js";

const LABELS: gmail_v1.Schema$Label[] = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "Label_42", name: "Work/Clients", type: "user" },
  { id: "Label_7", name: "Receipts", type: "user" },
];

describe("resolveLabelId", () => {
  it("matches an exact (case-sensitive) name", () => {
    expect(resolveLabelId("Work/Clients", LABELS)).toBe("Label_42");
  });
  it("falls back to case-insensitive name match", () => {
    expect(resolveLabelId("receipts", LABELS)).toBe("Label_7");
  });
  it("accepts a raw label id passthrough", () => {
    expect(resolveLabelId("Label_42", LABELS)).toBe("Label_42");
    expect(resolveLabelId("INBOX", LABELS)).toBe("INBOX");
  });
  it("throws LABEL_NOT_FOUND for unknown labels", () => {
    try {
      resolveLabelId("Nope", LABELS);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxiError);
      expect((err as AxiError).code).toBe("LABEL_NOT_FOUND");
    }
  });
});

describe("resolveLabelIds", () => {
  it("resolves a list, mixing names and ids", () => {
    expect(resolveLabelIds(["INBOX", "Receipts"], LABELS)).toEqual([
      "INBOX",
      "Label_7",
    ]);
  });
});

describe("labelNamesFor", () => {
  it("maps ids back to names, falling back to the id", () => {
    expect(labelNamesFor(["Label_42", "Label_7", "Label_unknown"], LABELS)).toEqual([
      "Work/Clients",
      "Receipts",
      "Label_unknown",
    ]);
  });
});

describe("isSystemLabel", () => {
  it("treats ALL_CAPS ids as system labels", () => {
    expect(isSystemLabel("INBOX")).toBe(true);
    expect(isSystemLabel("CATEGORY_SOCIAL")).toBe(true);
  });
  it("treats Label_<n> and nested names as user labels", () => {
    expect(isSystemLabel("Label_42")).toBe(false);
    expect(isSystemLabel("Work/Clients")).toBe(false);
  });
});
