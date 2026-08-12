import { describe, expect, it } from "vitest";
import { buildRawMessage, parseRecipients } from "./compose.js";

/** Decode a base64url raw message into its header block and decoded HTML body. */
function decodeRaw(raw: string): { header: string; body: string } {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const idx = text.indexOf("\r\n\r\n");
  return {
    header: text.slice(0, idx),
    body: Buffer.from(text.slice(idx + 4).replace(/\r\n/g, ""), "base64").toString("utf8"),
  };
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
  it("emits the core headers and a single text/html body", () => {
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
    expect(header).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(body).toMatch(/^<html><body>/);
    expect(body).toMatch(/<\/body><\/html>$/);
  });

  it("offers no text/plain alternative for the composer to adopt", () => {
    // A plain part reopens the coin flip that delivered raw markdown to the
    // reader — see specs/commands/gmail-draft.md.
    const { header } = decodeRaw(
      buildRawMessage({ from: "me@x.com", to: ["a@x.com"], subject: "s", body: "b" }),
    );
    expect(header).not.toContain("multipart");
    expect(header).not.toContain("text/plain");
    expect(header).not.toContain("boundary");
  });

  it("renders markdown to HTML", () => {
    const { body } = decodeRaw(
      buildRawMessage({
        from: "me@x.com",
        to: ["a@x.com"],
        subject: "s",
        body: "Some **bold** text and a [link](https://axi.md).\n\n- one\n- two",
      }),
    );
    expect(body).toContain("<strong>bold</strong>");
    expect(body).toContain('<a href="https://axi.md">link</a>');
    expect(body).toContain("<li>one</li>");
  });

  it("maps a blank line to a new paragraph and a single newline to <br>", () => {
    const { body } = decodeRaw(
      buildRawMessage({
        from: "me@x.com",
        to: ["a@x.com"],
        subject: "s",
        body: "First para.\n\nSecond line one\nsecond line two",
      }),
    );
    expect(body.match(/<p>/g)).toHaveLength(2);
    expect(body).toContain("Second line one<br>second line two");
  });

  it("never breaks a long paragraph inside the decoded body", () => {
    // The 76-column wrapping is base64 transport only — it must not survive
    // decoding, or the recipient sees the ragged columns this format exists
    // to prevent.
    const text = `${"word ".repeat(60).trim()}.`;
    const { body } = decodeRaw(
      buildRawMessage({ from: "me@x.com", to: ["a@x.com"], subject: "s", body: text }),
    );
    expect(body).not.toContain("\r\n");
    expect(body).toContain(text);
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
    expect(body).toContain("naïve résumé — ☕");
  });

  it("produces valid base64url (no +,/,= padding chars)", () => {
    const raw = buildRawMessage({
      from: "me@x.com",
      to: ["a@x.com"],
      subject: "s",
      body: "x".repeat(200), // force base64 line wrapping
    });
    expect(raw).not.toMatch(/[+/=]/);
    expect(decodeRaw(raw).body).toContain("x".repeat(200));
  });
});

describe("buildRawMessage --plain", () => {
  const plainBody = (body: string) =>
    decodeRaw(buildRawMessage({ from: "me@x.com", to: ["a@x.com"], subject: "s", body, plain: true }))
      .body;

  it("still sends a single text/html part", () => {
    // Reverting to text/plain is the original defect; --plain changes how the
    // body is interpreted, not the message structure.
    const { header } = decodeRaw(
      buildRawMessage({ from: "me@x.com", to: ["a@x.com"], subject: "s", body: "b", plain: true }),
    );
    expect(header).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(header).not.toContain("multipart");
    expect(header).not.toContain("text/plain");
  });

  it("leaves markdown syntax literal", () => {
    const body = plainBody("Some **bold** text, a [link](https://axi.md), and _underscores_.");
    expect(body).toContain("**bold**");
    expect(body).toContain("[link](https://axi.md)");
    expect(body).toContain("_underscores_");
    expect(body).not.toContain("<strong>");
    expect(body).not.toContain("<a href");
  });

  it("does not turn a leading # or - into a heading or list", () => {
    const body = plainBody("# not a heading\n- not a list item");
    expect(body).toContain("# not a heading");
    expect(body).toContain("- not a list item");
    expect(body).not.toContain("<h1>");
    expect(body).not.toContain("<li>");
  });

  it("escapes HTML so tags reach the reader as text", () => {
    const body = plainBody("Use <script>alert(1)</script> & <b>tags</b> literally");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("&amp;");
    expect(body).toContain("&lt;b&gt;tags&lt;/b&gt;");
  });

  it("keeps the same block semantics as the markdown path", () => {
    const body = plainBody("First para.\n\nSecond line one\nsecond line two");
    expect(body.match(/<p>/g)).toHaveLength(2);
    expect(body).toContain("Second line one<br>second line two");
  });

  it("preserves indentation and column alignment", () => {
    const body = plainBody("    calories   1,895\n    protein    100 g");
    // Leading indent is fully non-breaking; an internal run keeps one real
    // space as a wrap point.
    expect(body).toContain("&nbsp;&nbsp;&nbsp;&nbsp;calories");
    expect(body).toContain("calories &nbsp;&nbsp;1,895");
  });

  it("expands tabs and drops blank-only blocks", () => {
    expect(plainBody("\tindented")).toContain("&nbsp;&nbsp;&nbsp;&nbsp;indented");
    expect(plainBody("one\n\n   \n\ntwo").match(/<p>/g)).toHaveLength(2);
  });

  it("renders an empty body as an empty document", () => {
    expect(plainBody("")).toBe("<html><body></body></html>");
  });
});
