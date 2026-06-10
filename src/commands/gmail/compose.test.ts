import { describe, expect, it } from "vitest";
import { buildRawMessage, parseRecipients } from "./compose.js";

/** Decode a base64url raw message back into its header block and body. */
function decodeRaw(raw: string): { header: string; body: string } {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const idx = text.indexOf("\r\n\r\n");
  const header = text.slice(0, idx);
  const bodyB64 = text.slice(idx + 4).replace(/\r\n/g, "");
  return { header, body: Buffer.from(bodyB64, "base64").toString("utf8") };
}

describe("parseRecipients", () => {
  it("splits, trims, and drops empties", () => {
    expect(parseRecipients("a@x.com, b@x.com ,, c@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
    ]);
  });
  it("handles a single address", () => {
    expect(parseRecipients("solo@x.com")).toEqual(["solo@x.com"]);
  });
});

describe("buildRawMessage", () => {
  it("emits the core headers and round-trips the body", () => {
    const raw = buildRawMessage({
      from: "me@x.com",
      to: ["alice@x.com", "bob@x.com"],
      subject: "Hello",
      body: "Line one\nLine two",
    });
    const { header, body } = decodeRaw(raw);
    expect(header).toContain("From: me@x.com");
    expect(header).toContain("To: alice@x.com, bob@x.com");
    expect(header).toContain("Subject: Hello");
    expect(header).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(body).toBe("Line one\nLine two");
  });

  it("includes Cc/Bcc only when provided", () => {
    const withCc = decodeRaw(
      buildRawMessage({
        from: "me@x.com",
        to: ["a@x.com"],
        cc: ["c@x.com"],
        bcc: ["d@x.com"],
        subject: "s",
        body: "b",
      }),
    ).header;
    expect(withCc).toContain("Cc: c@x.com");
    expect(withCc).toContain("Bcc: d@x.com");

    const without = decodeRaw(
      buildRawMessage({ from: "me@x.com", to: ["a@x.com"], subject: "s", body: "b" }),
    ).header;
    expect(without).not.toContain("Cc:");
    expect(without).not.toContain("Bcc:");
  });

  it("RFC 2047 encodes non-ASCII subjects but leaves the body decodable", () => {
    const { header, body } = decodeRaw(
      buildRawMessage({
        from: "me@x.com",
        to: ["a@x.com"],
        subject: "café ☕",
        body: "naïve résumé — ☕",
      }),
    );
    expect(header).toContain("Subject: =?UTF-8?B?");
    expect(header).not.toContain("café");
    expect(body).toBe("naïve résumé — ☕");
  });

  it("produces valid base64url (no +,/,= padding chars)", () => {
    const raw = buildRawMessage({
      from: "me@x.com",
      to: ["a@x.com"],
      subject: "s",
      body: "x".repeat(200), // force base64 line wrapping
    });
    expect(raw).not.toMatch(/[+/=]/);
    expect(decodeRaw(raw).body).toBe("x".repeat(200));
  });
});
