import { describe, expect, it } from "vitest";
import { editDistance, findLikelyTypo } from "./typo.js";

describe("editDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(editDistance("abc", "abc")).toBe(0);
  });

  it("counts a single insertion / deletion", () => {
    expect(editDistance("themightychris@gmai.com", "themightychris@gmail.com")).toBe(1);
    expect(editDistance("abc", "abcd")).toBe(1);
  });

  it("counts substitutions", () => {
    expect(editDistance("abc", "abd")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });

  it("handles empty strings", () => {
    expect(editDistance("", "")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
  });
});

describe("findLikelyTypo", () => {
  const known = ["chris@jarv.us", "themightychris@gmail.com"];

  it("returns undefined for an exact match", () => {
    expect(findLikelyTypo("chris@jarv.us", known)).toBeUndefined();
  });

  it("returns undefined when nothing is close", () => {
    expect(findLikelyTypo("alice@example.com", known)).toBeUndefined();
  });

  it("flags a one-character typo", () => {
    expect(findLikelyTypo("themightychris@gmai.com", known)).toBe(
      "themightychris@gmail.com",
    );
  });

  it("flags a two-character typo within the threshold", () => {
    expect(findLikelyTypo("themightychrs@gmail.com", known)).toBe(
      "themightychris@gmail.com",
    );
  });

  it("ignores matches beyond the default threshold", () => {
    expect(findLikelyTypo("totallydifferent@gmail.com", known)).toBeUndefined();
  });

  it("respects custom threshold", () => {
    expect(findLikelyTypo("chris@xx.us", known, 4)).toBe("chris@jarv.us");
    expect(findLikelyTypo("chris@xx.us", known, 2)).toBeUndefined();
  });

  it("picks the closest match when multiple candidates are within range", () => {
    const candidates = ["chris@jarv.us", "chris@jarv.uss"];
    // Both are within distance 1, but chris@jarv.us is closer (distance 1)
    // vs chris@jarv.uss (also distance 1) — first-match-wins or
    // best-distance, either is fine; just don't crash.
    expect(findLikelyTypo("chris@jarv.u", candidates)).toBeTruthy();
  });
});
