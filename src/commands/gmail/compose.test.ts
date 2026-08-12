import { describe, expect, it } from "vitest";
import { buildRawMessage, parseRecipients } from "./compose.js";

interface DecodedMessage {
  header: string;
  boundary: string;
  /** Decoded part bodies, in wire order. */
  parts: Array<{ contentType: string; content: string }>;
  plain: string;
  html: string;
}

/** Decode a base64url raw message into its header block and decoded MIME parts. */
function decodeRaw(raw: string): DecodedMessage {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const idx = text.indexOf("\r\n\r\n");
  const header = text.slice(0, idx);

  const boundary = /boundary="([^"]+)"/.exec(header)?.[1] ?? "";
  expect(boundary).not.toBe("");

  // Drop the preamble (before the first boundary) and the closing `--<b>--`.
  const parts = text
    .slice(idx + 4)
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((chunk) => {
      const split = chunk.indexOf("\r\n\r\n");
      const partHeaders = chunk.slice(0, split);
      const b64 = chunk.slice(split + 4).replace(/\r\n/g, "");
      return {
        contentType: /Content-Type: ([^;\r\n]+)/.exec(partHeaders)?.[1] ?? "",
        content: Buffer.from(b64, "base64").toString("utf8"),
      };
    });

  const find = (type: string) => parts.find((p) => p.contentType === type)?.content ?? "";
  return { header, boundary, parts, plain: find("text/plain"), html: find("text/html") };
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
  it("emits the core headers and a multipart/alternative body", () => {
    const raw = buildRawMessage({
      from: "me@x.com",
      to: ["alice@x.com", "bob@x.com"],
      subject: "Hello",
      body: "Line one\nLine two",
    });
    const { header, boundary, parts } = decodeRaw(raw);
    expect(header).toContain("From: me@x.com");
    expect(header).toContain("To: alice@x.com, bob@x.com");
    expect(header).toContain("Subject: Hello");
    expect(header).toContain(`Content-Type: multipart/alternative; boundary="${boundary}"`);

    // RFC 2046: least-faithful alternative first, so clients pick the HTML.
    expect(parts.map((p) => p.contentType)).toEqual(["text/plain", "text/html"]);
  });

  it("delimits both parts and terminates the multipart body", () => {
    const raw = buildRawMessage({
      from: "me@x.com",
      to: ["a@x.com"],
      subject: "s",
      body: "hello",
    });
    const { boundary } = decodeRaw(raw);
    const text = Buffer.from(raw, "base64url").toString("utf8");
    expect(text.split(`--${boundary}\r\n`)).toHaveLength(3); // two part delimiters
    expect(text.endsWith(`--${boundary}--`)).toBe(true);
  });

  it("uses a fresh boundary per message", () => {
    const fields = { from: "me@x.com", to: ["a@x.com"], subject: "s", body: "b" };
    expect(decodeRaw(buildRawMessage(fields)).boundary).not.toBe(
      decodeRaw(buildRawMessage(fields)).boundary,
    );
  });

  it("keeps the markdown source verbatim in the text/plain part", () => {
    const body = "# Heading\n\nSome **bold** text.\n\n- one\n- two";
    const { plain } = decodeRaw(
      buildRawMessage({ from: "me@x.com", to: ["a@x.com"], subject: "s", body }),
    );
    expect(plain).toBe(body);
  });

  it("renders markdown into the text/html part", () => {
    const { html } = decodeRaw(
      buildRawMessage({
        from: "me@x.com",
        to: ["a@x.com"],
        subject: "s",
        body: "Some **bold** text.\n\n- one\n- two",
      }),
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<li>one</li>");
    expect(html).toMatch(/^<html><body>/);
    expect(html).toMatch(/<\/body><\/html>$/);
  });

  it("maps a blank line to a new paragraph and a single newline to <br>", () => {
    const { html } = decodeRaw(
      buildRawMessage({
        from: "me@x.com",
        to: ["a@x.com"],
        subject: "s",
        body: "First para.\n\nSecond line one\nsecond line two",
      }),
    );
    // Two paragraphs...
    expect(html.match(/<p>/g)).toHaveLength(2);
    // ...and the intra-paragraph newline survives as a break, not a space.
    expect(html).toContain("Second line one<br>second line two");
  });

  it("never breaks a long paragraph inside the decoded content of either part", () => {
    // The 76-column wrapping is base64 transport only — it must not survive
    // decoding, or the recipient sees the ragged columns this format exists
    // to prevent.
    const body = `${"word ".repeat(60).trim()}.`;
    const { plain, html } = decodeRaw(
      buildRawMessage({ from: "me@x.com", to: ["a@x.com"], subject: "s", body }),
    );
    expect(plain).toBe(body);
    expect(plain).not.toContain("\r\n");
    expect(html).not.toContain("\r\n");
    expect(html).toContain(body);
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

  it("RFC 2047 encodes non-ASCII subjects but leaves both parts decodable", () => {
    const { header, plain, html } = decodeRaw(
      buildRawMessage({
        from: "me@x.com",
        to: ["a@x.com"],
        subject: "café ☕",
        body: "naïve résumé — ☕",
      }),
    );
    expect(header).toContain("Subject: =?UTF-8?B?");
    expect(header).not.toContain("café");
    expect(plain).toBe("naïve résumé — ☕");
    expect(html).toContain("naïve résumé — ☕");
  });

  it("produces valid base64url (no +,/,= padding chars)", () => {
    const raw = buildRawMessage({
      from: "me@x.com",
      to: ["a@x.com"],
      subject: "s",
      body: "x".repeat(200), // force base64 line wrapping
    });
    expect(raw).not.toMatch(/[+/=]/);
    expect(decodeRaw(raw).plain).toBe("x".repeat(200));
  });
});
