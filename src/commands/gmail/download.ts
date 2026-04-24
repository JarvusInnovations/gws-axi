import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { gmail_v1 } from "googleapis";
import { gmailClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { resolveOutputPath } from "../docs/paths.js";

export const DOWNLOAD_HELP = `usage: gws-axi gmail download <message-id> <attachment-id> [flags]
args[2]:
  <message-id>         The ID of the message carrying the attachment
  <attachment-id>      The attachment ID (from \`gws-axi gmail read\` output)
flags[2]:
  --out <path>         Where to save (default: ./<attachment filename>; pass
                       a directory to save inside with the native name)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi gmail download 1a2b3c4d5e6f7890 ANGjdJ...XXX
  gws-axi gmail download 1a2b3c... ANGjdJ... --out /tmp/invoice.pdf
notes:
  \`gws-axi gmail read <thread-id>\` lists every message's attachments with
  their filename, mime, size, and attachment_id — use that output to drive
  this command. You need both the message ID (not thread ID) and the
  attachment ID to fetch bytes.
`;

interface ParsedFlags {
  messageId: string;
  attachmentId: string;
  out: string | undefined;
}

function parseFlags(args: string[]): ParsedFlags {
  const positional: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--out") {
      out = next;
      i++;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  if (positional.length < 2) {
    throw new AxiError(
      "Missing required arguments",
      "VALIDATION_ERROR",
      [
        "Usage: gws-axi gmail download <message-id> <attachment-id>",
        "Get both IDs from `gws-axi gmail read <thread-id>`",
      ],
    );
  }
  return {
    messageId: positional[0],
    attachmentId: positional[1],
    out,
  };
}

export async function gmailDownloadCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  const api = await gmailClient(account);

  // Fetch bytes first. Gmail re-mints attachment IDs on every API call, so
  // matching a user-supplied id against the parts tree from a fresh
  // messages.get would fail even though the id the user pasted is still
  // valid — the attachments.get endpoint accepts historical ids. So we
  // skip the walk-for-matching and call attachments.get directly.
  let bytes: Buffer;
  let sizeBytes: number;
  try {
    const res = await api.users.messages.attachments.get({
      userId: "me",
      messageId: flags.messageId,
      id: flags.attachmentId,
    });
    const data = res.data.data ?? "";
    bytes = Buffer.from(data, "base64url");
    sizeBytes = res.data.size ?? bytes.length;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "gmail.attachments.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `Attachment not found — message '${flags.messageId}' doesn't have attachment '${flags.attachmentId.slice(0, 20)}…'`,
        "ATTACHMENT_NOT_FOUND",
        [
          `List attachments with \`gws-axi gmail read ${flags.messageId}\``,
          `Double-check both the message-id and the attachment-id are correct`,
        ],
      );
    }
    throw translated;
  }

  // Best-effort filename/mime lookup. Walk the message and look for an
  // attachment whose size matches — that's reliable across ID-minting
  // quirks. When multiple attachments share a size, or the lookup fails,
  // fall back to a generic name (agents who want a nicer filename can
  // always pass --out).
  let filename = `attachment-${flags.attachmentId.slice(0, 12)}.bin`;
  let mimeType = "application/octet-stream";
  try {
    const msgRes = await api.users.messages.get({
      userId: "me",
      id: flags.messageId,
      format: "full",
    });
    const matches: Array<{ filename: string; mimeType: string }> = [];
    const walk = (part: gmail_v1.Schema$MessagePart): void => {
      if (
        part.filename &&
        part.body?.attachmentId &&
        part.body?.size === sizeBytes
      ) {
        matches.push({
          filename: part.filename,
          mimeType: part.mimeType ?? "application/octet-stream",
        });
      }
      for (const p of part.parts ?? []) walk(p);
    };
    if (msgRes.data.payload) walk(msgRes.data.payload);
    if (matches.length === 1) {
      filename = matches[0].filename;
      mimeType = matches[0].mimeType;
    }
    // If zero or multiple matches, keep the generic fallback — the bytes
    // are still written correctly; users get a useful filename via --out.
  } catch {
    // Metadata lookup is best-effort; swallow and use fallback filename.
  }

  const outPath = await resolveOutputPath(flags.out, filename);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, bytes);

  const blocks: string[] = [];
  blocks.push(renderObject({ account }));
  blocks.push(
    renderObject({
      attachment: {
        message_id: flags.messageId,
        attachment_id: flags.attachmentId,
        filename,
        mime_type: mimeType,
        size_bytes: sizeBytes,
      },
    }),
  );
  blocks.push(renderObject({ saved: outPath }));

  const suggestions: string[] = [];
  if (mimeType === "application/pdf") {
    suggestions.push(
      `PDF saved — \`pdftotext "${basename(outPath)}" -\` to extract text`,
    );
  } else if (mimeType.startsWith("image/")) {
    suggestions.push(`Image saved — \`open "${outPath}"\` to view`);
  } else if (mimeType.startsWith("text/")) {
    suggestions.push(`Text file saved — \`cat "${outPath}"\``);
  } else if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    suggestions.push(
      `.docx saved — extract with \`pandoc "${basename(outPath)}" -t plain\``,
    );
  } else {
    suggestions.push(
      `Inspect with \`file "${outPath}"\` to identify the format`,
    );
  }
  if (filename.startsWith("attachment-")) {
    suggestions.push(
      `Could not match this attachment to a filename in the message — pass \`--out <path>\` to name the saved file`,
    );
  }

  blocks.push(renderHelp(suggestions));
  return joinBlocks(...blocks);
}
