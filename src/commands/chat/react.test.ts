import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { reactionSummary } from "./message-rows.js";
import { checkEmoji, parseReactFlags } from "./react.js";

function errorFrom(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AxiError);
    return err as AxiError;
  }
  throw new Error("expected a throw");
}

describe("checkEmoji", () => {
  it.each(["👍", "👍🏽", "🎉", "❤️", "🇺🇸", "👨‍👩‍👧"])("accepts %s", (emoji) => {
    expect(checkEmoji(emoji, "usage")).toBe(emoji);
  });

  it("refuses a shortcode, naming the reason", () => {
    expect(errorFrom(() => checkEmoji(":thumbsup:", "usage")).message).toContain("Shortcodes");
  });

  it.each(["hello", "+1", "", "   ", "é"])("refuses %j", (raw) => {
    expect(errorFrom(() => checkEmoji(raw, "usage")).code).toBe("VALIDATION_ERROR");
  });
});

describe("parseReactFlags", () => {
  it("takes a conversation and a message id", () => {
    expect(parseReactFlags(["AAAA", "Hk2.Hk2", "--emoji", "👍"], "react")).toEqual({
      target: { kind: "space", id: "AAAA" },
      message: "Hk2.Hk2",
      emoji: "👍",
    });
  });

  it("takes a full message resource name on its own", () => {
    expect(
      parseReactFlags(["spaces/AAAA/messages/Hk2.Hk2", "--emoji", "👍"], "react"),
    ).toMatchObject({ target: { kind: "space", id: "AAAA" }, message: "Hk2.Hk2" });
  });

  it("keeps a client-assigned id for resolution later", () => {
    expect(parseReactFlags(["AAAA", "client-deploy-4821", "--emoji", "👍"], "react").message).toBe(
      "client-deploy-4821",
    );
  });

  it("takes --with in place of the conversation", () => {
    expect(
      parseReactFlags(["Hk2.Hk2", "--with", "bob@example.com", "--emoji", "👍"], "unreact"),
    ).toMatchObject({ target: { kind: "dm", email: "bob@example.com" }, message: "Hk2.Hk2" });
  });

  it("refuses a message resource name from a different conversation", () => {
    expect(
      errorFrom(() =>
        parseReactFlags(["AAAA", "spaces/BBBB/messages/Hk2", "--emoji", "👍"], "react"),
      ).message,
    ).toContain("not in conversation AAAA");
  });

  it("refuses a missing message, a missing emoji, and extra arguments", () => {
    expect(errorFrom(() => parseReactFlags(["AAAA", "--emoji", "👍"], "react")).code).toBe(
      "VALIDATION_ERROR",
    );
    expect(errorFrom(() => parseReactFlags(["AAAA", "Hk2"], "react")).message).toContain("--emoji");
    expect(
      errorFrom(() => parseReactFlags(["AAAA", "Hk2", "extra", "--emoji", "👍"], "react")).message,
    ).toContain("Too many");
  });
});

describe("reactionSummary", () => {
  it("lists each emoji with its count", () => {
    expect(
      reactionSummary({
        emojiReactionSummaries: [
          { emoji: { unicode: "👍" }, reactionCount: 2 },
          { emoji: { customEmoji: { emojiName: "partyparrot" } }, reactionCount: 1 },
        ],
      }),
    ).toBe("👍 2 · :partyparrot: 1");
  });

  it("is empty with no reactions", () => {
    expect(reactionSummary({})).toBe("");
  });
});
