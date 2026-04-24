import type { gmail_v1 } from "googleapis";
import TurndownService from "turndown";

export interface Attachment {
  filename: string;
  mime_type: string;
  size_bytes: number;
  attachment_id: string;
  part_id: string;
}

export interface MessageBody {
  content: string;
  // Which variant we used: `plain` when the message had text/plain;
  // `html` when we fell back to converting text/html; `empty` when
  // neither was available (rare — typically attachment-only messages).
  source: "plain" | "html" | "empty";
}

export interface ParsedMessage {
  // Headers are case-insensitive in RFC 5322; store with lowercased keys.
  headers: Map<string, string>;
  body: MessageBody;
  attachments: Attachment[];
  // Parts that carry Content-Disposition: inline — typically images the
  // HTML body references via `cid:`. We count them but don't surface them
  // as attachments; agents almost never want to pull embedded logos.
  inline_image_count: number;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
// Drop style/script blocks entirely rather than leaking their contents as
// prose; Gmail HTML emails frequently carry inlined CSS as a <style> block
// inside <head> that turndown would otherwise emit.
turndown.remove(["style", "script", "head"]);

export function parseMessage(msg: gmail_v1.Schema$Message): ParsedMessage {
  const headers = new Map<string, string>();
  for (const h of msg.payload?.headers ?? []) {
    if (h.name && h.value !== undefined && h.value !== null) {
      headers.set(h.name.toLowerCase(), h.value);
    }
  }

  const textParts: Array<{ mimeType: string; data: string }> = [];
  const attachments: Attachment[] = [];
  const stats = { inline_image_count: 0 };
  collectParts(msg.payload, textParts, attachments, stats);

  // Prefer text/plain when both exist. Gmail almost always ships both in
  // multipart/alternative for modern mail; fall back to turndown on
  // text/html only when no plain version exists.
  const plain = textParts.find((p) => p.mimeType === "text/plain");
  const html = textParts.find((p) => p.mimeType === "text/html");

  let body: MessageBody;
  if (plain) {
    body = { content: plain.data, source: "plain" };
  } else if (html) {
    body = { content: turndown.turndown(html.data), source: "html" };
  } else {
    body = { content: "", source: "empty" };
  }

  return { headers, body, attachments, inline_image_count: stats.inline_image_count };
}

function partHeader(
  part: gmail_v1.Schema$MessagePart,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const h of part.headers ?? []) {
    if (h.name?.toLowerCase() === lower) return h.value ?? undefined;
  }
  return undefined;
}

function isInlineDisposition(part: gmail_v1.Schema$MessagePart): boolean {
  // RFC 2183: Content-Disposition: inline [; filename="..."]
  // Gmail also sets Content-ID on inline parts (referenced from HTML via
  // `src="cid:..."`). Either signal treats the part as embedded rather
  // than a user-facing attachment.
  const disp = partHeader(part, "Content-Disposition")?.toLowerCase() ?? "";
  if (disp.startsWith("inline")) return true;
  if (partHeader(part, "Content-ID")) return true;
  return false;
}

function collectParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  textParts: Array<{ mimeType: string; data: string }>,
  attachments: Attachment[],
  stats: { inline_image_count: number },
): void {
  if (!part) return;

  const mime = part.mimeType ?? "";
  const filename = part.filename;
  const bodyData = part.body?.data;
  const attachmentId = part.body?.attachmentId;

  // Anything with a filename is a binary part. Classify as attachment vs
  // inline via Content-Disposition / Content-ID headers.
  if (filename && filename.length > 0) {
    if (isInlineDisposition(part)) {
      stats.inline_image_count += 1;
      return;
    }
    if (attachmentId) {
      attachments.push({
        filename,
        mime_type: mime,
        size_bytes: part.body?.size ?? 0,
        attachment_id: attachmentId,
        part_id: part.partId ?? "",
      });
    }
    return;
  }

  // Container parts: recurse into children.
  if (mime.startsWith("multipart/") && part.parts?.length) {
    for (const child of part.parts) {
      collectParts(child, textParts, attachments, stats);
    }
    return;
  }

  // Leaf text parts: decode and stash.
  if ((mime === "text/plain" || mime === "text/html") && bodyData) {
    textParts.push({ mimeType: mime, data: decodeBase64Url(bodyData) });
  }
}

function decodeBase64Url(data: string): string {
  // Node 22 natively understands base64url — no manual -_/+/ swap needed.
  return Buffer.from(data, "base64url").toString("utf8");
}

export function headerList(
  headers: Map<string, string>,
  name: string,
): string[] {
  // Some headers (To, Cc, Bcc) can legitimately contain multiple
  // comma-separated addresses. We return a split list; callers that want
  // the raw value can call `headers.get(name.toLowerCase())`.
  const raw = headers.get(name.toLowerCase());
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
