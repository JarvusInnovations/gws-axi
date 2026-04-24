import type { gmail_v1 } from "googleapis";
import { describe, expect, it } from "vitest";
import { parseAddresses, parseMessage } from "./mime.js";

// Encode a string as base64url the way Gmail's API does.
function b64(content: string, encoding: BufferEncoding = "utf8"): string {
  return Buffer.from(content, encoding).toString("base64url");
}

function headers(
  pairs: Array<[string, string]>,
): gmail_v1.Schema$MessagePartHeader[] {
  return pairs.map(([name, value]) => ({ name, value }));
}

function textPart(
  mime: string,
  content: string,
  extraHeaders: Array<[string, string]> = [],
): gmail_v1.Schema$MessagePart {
  return {
    mimeType: mime,
    headers: headers([["Content-Type", `${mime}; charset=utf-8`], ...extraHeaders]),
    body: { data: b64(content), size: content.length },
  };
}

function attachmentPart(
  mime: string,
  filename: string,
  size: number,
  disposition: string | null,
): gmail_v1.Schema$MessagePart {
  const hdrs: Array<[string, string]> = [["Content-Type", `${mime}; name="${filename}"`]];
  if (disposition !== null) {
    hdrs.push(["Content-Disposition", disposition]);
  }
  return {
    mimeType: mime,
    filename,
    headers: headers(hdrs),
    body: { size, attachmentId: `att-${filename}` },
  };
}

function multipart(
  mime: string,
  parts: gmail_v1.Schema$MessagePart[],
): gmail_v1.Schema$MessagePart {
  return {
    mimeType: mime,
    headers: headers([["Content-Type", mime]]),
    parts,
    body: {},
  };
}

function message(
  topHeaders: Array<[string, string]>,
  payload: gmail_v1.Schema$MessagePart,
): gmail_v1.Schema$Message {
  // Top-level message headers live on payload.headers in Gmail's API.
  return {
    id: "msg1",
    payload: {
      ...payload,
      headers: [...headers(topHeaders), ...(payload.headers ?? [])],
    },
  };
}

describe("parseMessage — bodies", () => {
  it("decodes a single text/plain body from base64url", () => {
    const msg = message(
      [["From", "a@example.com"], ["Subject", "Plain"]],
      textPart("text/plain", "Hello, world!"),
    );
    const parsed = parseMessage(msg);
    expect(parsed.body).toEqual({ source: "plain", content: "Hello, world!" });
    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.inline_image_count).toBe(0);
  });

  it("prefers text/plain over text/html in multipart/alternative", () => {
    const msg = message(
      [["Subject", "Alt"]],
      multipart("multipart/alternative", [
        textPart("text/plain", "Plain text wins"),
        textPart("text/html", "<p>HTML loses</p>"),
      ]),
    );
    const parsed = parseMessage(msg);
    expect(parsed.body.source).toBe("plain");
    expect(parsed.body.content).toBe("Plain text wins");
  });

  it("falls back to text/html via turndown when no text/plain exists", () => {
    const msg = message(
      [["Subject", "HTML only"]],
      textPart("text/html", "<h1>Heading</h1><p>Paragraph <b>bold</b></p>"),
    );
    const parsed = parseMessage(msg);
    expect(parsed.body.source).toBe("html");
    expect(parsed.body.content).toContain("Heading");
    expect(parsed.body.content).toContain("**bold**");
  });

  it("walks nested multipart trees", () => {
    const msg = message(
      [["Subject", "Nested"]],
      multipart("multipart/mixed", [
        multipart("multipart/alternative", [
          textPart("text/plain", "Deep plain"),
          textPart("text/html", "<p>Deep HTML</p>"),
        ]),
        attachmentPart("application/pdf", "doc.pdf", 1024, "attachment"),
      ]),
    );
    const parsed = parseMessage(msg);
    expect(parsed.body.content).toBe("Deep plain");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("doc.pdf");
  });

  it("returns empty body when no text parts exist", () => {
    const msg = message(
      [["Subject", "Attach only"]],
      attachmentPart("application/pdf", "only.pdf", 100, "attachment"),
    );
    const parsed = parseMessage(msg);
    expect(parsed.body).toEqual({ source: "empty", content: "" });
  });

  it("decodes bodies per Content-Type charset (latin1)", () => {
    // The word "Naïve" encoded in latin1 has byte 0xEF for ï.
    const latin1Body = "Naïve".normalize("NFC");
    const part: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      headers: headers([["Content-Type", "text/plain; charset=iso-8859-1"]]),
      body: {
        data: Buffer.from(latin1Body, "latin1").toString("base64url"),
        size: latin1Body.length,
      },
    };
    const msg = message([["Subject", "latin"]], part);
    const parsed = parseMessage(msg);
    expect(parsed.body.content).toBe("Naïve");
  });
});

describe("parseMessage — attachments vs inline", () => {
  it("surfaces real attachments", () => {
    const msg = message(
      [["Subject", "Invoice"]],
      multipart("multipart/mixed", [
        textPart("text/plain", "See attached"),
        attachmentPart("application/pdf", "invoice.pdf", 500, "attachment"),
      ]),
    );
    const parsed = parseMessage(msg);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({
      filename: "invoice.pdf",
      mime_type: "application/pdf",
      size_bytes: 500,
    });
    expect(parsed.inline_image_count).toBe(0);
  });

  it("filters parts with Content-Disposition: inline", () => {
    const msg = message(
      [["Subject", "With logo"]],
      multipart("multipart/related", [
        textPart("text/html", "<p>Hi <img src=\"cid:logo\"/></p>"),
        attachmentPart("image/png", "logo.png", 1024, "inline; filename=\"logo.png\""),
      ]),
    );
    const parsed = parseMessage(msg);
    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.inline_image_count).toBe(1);
  });

  it("filters parts that have a Content-ID (even without disposition)", () => {
    const part = attachmentPart("image/png", "embed.png", 512, null);
    part.headers = headers([
      ["Content-Type", "image/png"],
      ["Content-ID", "<embed1@example.com>"],
    ]);
    const msg = message(
      [["Subject", "Embedded"]],
      multipart("multipart/related", [
        textPart("text/html", "<p>hi</p>"),
        part,
      ]),
    );
    const parsed = parseMessage(msg);
    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.inline_image_count).toBe(1);
  });

  it("classifies mixed inline + attachment correctly", () => {
    const msg = message(
      [["Subject", "Mixed"]],
      multipart("multipart/mixed", [
        multipart("multipart/related", [
          textPart("text/html", "<p>body</p>"),
          attachmentPart("image/png", "logo.png", 100, "inline; filename=logo.png"),
        ]),
        attachmentPart("application/pdf", "report.pdf", 5000, "attachment"),
      ]),
    );
    const parsed = parseMessage(msg);
    expect(parsed.attachments.map((a) => a.filename)).toEqual(["report.pdf"]);
    expect(parsed.inline_image_count).toBe(1);
  });
});

describe("parseMessage — headers", () => {
  it("stores headers with case-insensitive keys", () => {
    const msg = message(
      [["From", "alice@example.com"], ["SUBJECT", "Hello"]],
      textPart("text/plain", "body"),
    );
    const parsed = parseMessage(msg);
    expect(parsed.headers.get("from")).toBe("alice@example.com");
    expect(parsed.headers.get("subject")).toBe("Hello");
  });
});

describe("parseAddresses", () => {
  it("splits multiple addresses", () => {
    const h = new Map([["to", "alice@example.com, bob@example.com"]]);
    const parsed = parseAddresses(h, "To");
    expect(parsed).toEqual([
      { name: "", address: "alice@example.com" },
      { name: "", address: "bob@example.com" },
    ]);
  });

  it("handles display names with commas (the bug the naive splitter had)", () => {
    const h = new Map([["to", '"Doe, John" <j@example.com>, alice@example.com']]);
    const parsed = parseAddresses(h, "To");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ name: "Doe, John", address: "j@example.com" });
    expect(parsed[1]).toEqual({ name: "", address: "alice@example.com" });
  });

  it("returns an empty list for a missing header", () => {
    expect(parseAddresses(new Map(), "To")).toEqual([]);
  });
});
