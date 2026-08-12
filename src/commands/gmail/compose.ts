/**
 * RFC 5322 message builder for draft creation.
 *
 * Drafts go out as a single `text/html` part carrying the rendered `--body`
 * markdown. Gmail's composer adopts exactly one part of a draft as its editing
 * surface and discards the rest, so a message offering only HTML leaves it no
 * choice — the composer opens in rich text, our markup survives the human's
 * edits, and Gmail generates the `text/plain` alternative itself on send.
 *
 * Both alternatives were tried and rejected against live sends:
 *
 * - Single-part `text/plain` (the original bug) drops the composer into
 *   plain-text mode. On send Gmail hard-wraps at ~70 columns with real CRLFs
 *   and ships no HTML alternative, so recipients get ragged columns nothing
 *   can reflow — while the compose window still shows the original unwrapped
 *   paragraphs, hiding the damage until the message is gone.
 * - `multipart/alternative` (plain + HTML) fixes the wrapping but is a coin
 *   flip: two identically-built drafts behaved differently, one keeping our
 *   rendered markup and one adopting the plain part and delivering the raw
 *   markdown source to the reader — `**bold**` and `[text](url)` and all.
 *
 * See specs/commands/gmail-draft.md ("Message structure", "Body rendering").
 */

import { marked } from "marked";

export interface ComposeFields {
  /** Sender — the authenticated account's address. */
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Markdown source, rendered to the HTML body — unless `plain` is set. */
  body: string;
  /**
   * Treat `body` as literal text rather than markdown. Still sends a single
   * `text/html` part (reverting to `text/plain` is the original defect); the
   * HTML is built structurally instead of through the markdown renderer.
   */
  plain?: boolean;
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Keep indentation and column alignment that HTML would otherwise collapse.
 *
 * Leading spaces become `&nbsp;` outright; an internal run keeps one real
 * space — a wrap point, so the line still reflows — and pads the rest. This is
 * what Gmail itself does when it converts plain text to HTML, so it is known to
 * survive the composer.
 */
function preserveSpacing(line: string): string {
  return line
    .replace(/\t/g, "    ")
    .replace(/^ +/, (run) => "&nbsp;".repeat(run.length))
    .replace(/ {2,}/g, (run) => ` ${"&nbsp;".repeat(run.length - 1)}`);
}

/**
 * Render the body as literal text: no markdown, so `*`, `_`, `#` and friends
 * reach the reader exactly as written. Blank line starts a paragraph, a single
 * newline is a line break — the same block semantics as the markdown path, so
 * `--plain` changes how the body is interpreted, not how it is laid out.
 */
export function renderPlainText(body: string): string {
  const blocks = body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = escapeHtml(block).split("\n").map(preserveSpacing);
      return `<p>${lines.join("<br>")}</p>`;
    });
  return `<html><body>${blocks.join("\n")}</body></html>`;
}

/** Base64 with CRLF line endings wrapped at 76 columns (RFC 2045). */
function encodeBody(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
}

/**
 * Build a base64url-encoded RFC 5322 message suitable for
 * `users.drafts.create` / `users.messages.send` `raw` fields.
 */
export function buildRawMessage(fields: ComposeFields): string {
  const headers: string[] = [`From: ${fields.from}`, `To: ${fields.to.join(", ")}`];
  if (fields.cc?.length) headers.push(`Cc: ${fields.cc.join(", ")}`);
  if (fields.bcc?.length) headers.push(`Bcc: ${fields.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderValue(fields.subject)}`);
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/html; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: base64");

  const html = fields.plain ? renderPlainText(fields.body) : renderMarkdown(fields.body);
  const raw = `${headers.join("\r\n")}\r\n\r\n${encodeBody(html)}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}
