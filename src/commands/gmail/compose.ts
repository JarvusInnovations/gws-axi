/**
 * Minimal RFC 5322 message builder for draft creation. We only need the
 * plain-text single-part case: agents draft text bodies for human review,
 * and Gmail's web composer handles any rich formatting on send. The raw
 * message is base64url-encoded as the Gmail API's `raw` field expects.
 */

export interface ComposeFields {
  /** Sender — the authenticated account's address. */
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
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
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Build a base64url-encoded RFC 5322 message suitable for
 * `users.drafts.create` / `users.messages.send` `raw` fields. Body is sent
 * as a single text/plain part with base64 transfer-encoding so any UTF-8
 * content survives intact.
 */
export function buildRawMessage(fields: ComposeFields): string {
  const headers: string[] = [`From: ${fields.from}`, `To: ${fields.to.join(", ")}`];
  if (fields.cc?.length) headers.push(`Cc: ${fields.cc.join(", ")}`);
  if (fields.bcc?.length) headers.push(`Bcc: ${fields.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderValue(fields.subject)}`);
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: base64");

  // Wrap the base64 body at 76 columns (RFC 2045) with CRLF line endings.
  const encodedBody = Buffer.from(fields.body, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");

  const raw = `${headers.join("\r\n")}\r\n\r\n${encodedBody}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}
