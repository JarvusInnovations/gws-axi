/**
 * RFC 5322 message builder for draft creation.
 *
 * Drafts go out as `multipart/alternative`: the `--body` markdown verbatim as
 * `text/plain`, and its rendered form as `text/html`. That structure is what
 * Gmail's own composer produces, and emitting it is load-bearing rather than
 * cosmetic — a single-part `text/plain` draft drops Gmail's composer into
 * plain-text mode, and on send Gmail hard-wraps the body at ~70 columns with
 * real CRLFs and ships no HTML alternative. The compose window still shows the
 * original unwrapped paragraphs, so the recipient's ragged columns are
 * invisible until after the message is gone.
 *
 * See specs/commands/gmail-draft.md ("Message structure", "Body rendering").
 */

import { randomUUID } from "node:crypto";
import { marked } from "marked";

export interface ComposeFields {
  /** Sender — the authenticated account's address. */
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Markdown source. Rendered into the text/html part, kept verbatim as text/plain. */
  body: string;
}

/** Split a comma-separated recipient flag into trimmed, non-empty addresses. */
export function parseRecipients(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * RFC 2047 "encoded-word" wrap a header value when it carries non-ASCII.
 * Pure-ASCII values pass through untouched so common subjects stay readable
 * on the wire.
 */
function encodeHeaderValue(value: string): string {
  if ([...value].every((ch) => (ch.codePointAt(0) ?? 0) <= 0x7f)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Render the body markdown to an HTML document.
 *
 * `breaks: true` is deliberate: email bodies carry meaningful single-line
 * breaks (signature blocks, addresses, value lists), and markdown's default of
 * collapsing them into spaces would silently reflow content the author laid
 * out. The flip side — a pre-wrapped body keeps its wrapping — is why
 * DRAFT_HELP tells callers not to hard-wrap.
 */
export function renderMarkdown(body: string): string {
  const fragment = marked.parse(body, { gfm: true, breaks: true, async: false });
  return `<html><body>${fragment}</body></html>`;
}

/** Base64 with CRLF line endings wrapped at 76 columns (RFC 2045). */
function encodePart(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
}

/**
 * Build a base64url-encoded RFC 5322 message suitable for
 * `users.drafts.create` / `users.messages.send` `raw` fields.
 */
export function buildRawMessage(fields: ComposeFields): string {
  // Unique per message, so it can never collide with body content — no
  // scanning the body for the boundary, no retry loop.
  const boundary = `=_gws-axi_${randomUUID()}`;

  const headers: string[] = [`From: ${fields.from}`, `To: ${fields.to.join(", ")}`];
  if (fields.cc?.length) headers.push(`Cc: ${fields.cc.join(", ")}`);
  if (fields.bcc?.length) headers.push(`Bcc: ${fields.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderValue(fields.subject)}`);
  headers.push("MIME-Version: 1.0");
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  // RFC 2046 orders alternatives least- to most-faithful; clients render the
  // last part they understand, so text/html goes second.
  const parts = [
    ['Content-Type: text/plain; charset="UTF-8"', fields.body],
    ['Content-Type: text/html; charset="UTF-8"', renderMarkdown(fields.body)],
  ].map(
    ([contentType, content]) =>
      `--${boundary}\r\n${contentType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodePart(content)}`,
  );

  const raw = `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${boundary}--`;
  return Buffer.from(raw, "utf8").toString("base64url");
}
