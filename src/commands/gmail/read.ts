import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { gmail_v1 } from "googleapis";
import { gmailClient, translateGoogleError } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { resolveOutputPath } from "../../util/paths.js";
import { parseMessage, type ParsedMessage } from "./mime.js";

export const READ_HELP = `usage: gws-axi gmail read <id> [flags]
args[1]:
  <id>                Thread ID or Message ID. Both are 16-char hex strings
                      and indistinguishable by shape — we try thread-get
                      first, then fall back to message-get → parent thread.
flags[6]:
  --message-only      Render ONLY the message with the given ID, not its
                      parent thread. The ID must be a message-id in this
                      mode. For alerts / notifications / one-offs where
                      thread context isn't useful.
  --headers           Render the message's full RFC 2822 header set (every
                      Received hop, Message-ID, In-Reply-To, References,
                      DKIM/ARC auth results, …) alongside the parsed body.
                      Operates on one message; a thread ID resolves to its
                      most recent message.
  --raw               Emit the message exactly as Gmail stores it: the
                      complete undecoded RFC 2822 source (headers + MIME
                      body) as one text block. For piping to a parser or
                      saving verbatim. Resolves a thread ID to its latest
                      message. Mutually exclusive with --headers.
  --full              Bypass the 30,000-char thread-size threshold; render
                      every message in full inline (can be large).
  --out <path>        Write the full thread to a markdown file instead of
                      embedding it inline (implies --full). Accepts a file
                      path or directory. With --raw, writes the raw source.
  --account <email>   Account override when 2+ are configured.
examples:
  gws-axi gmail read 1a2b3c4d5e6f7890
  gws-axi gmail read 1a2b3c4d5e6f7890 --full
  gws-axi gmail read 1a2b3c4d5e6f7890 --out ./thread.md
  gws-axi gmail read 1a2b3c4d5e6f7890 --message-only
  gws-axi gmail read 1a2b3c4d5e6f7890 --headers
  gws-axi gmail read 1a2b3c4d5e6f7890 --raw --out ./message.eml
output:
  A \`thread{id,subject,message_count,unread,resolved_via_message?}\` header,
  followed by a \`messages[N]\` array. Each message object carries from/to/date
  headers, the decoded body (text/plain preferred; HTML fallback converted via
  turndown), and an attachments[] list with id/filename/mime/size you can pass
  to \`gws-axi gmail download\`.
  --headers adds a \`headers[N]{name,value}\` list (full header set, in order,
  untruncated) plus \`internal_date\`. --raw replaces the parsed view with a
  single \`raw:\` block of the decoded RFC 2822 source.
notes:
  Default behavior renders the entire thread inline when total body size is
  under ~30,000 chars. Longer threads get proportional per-message truncation
  with the usual --full / --out escape hatches. --out writes one complete
  message per section as a markdown conversation, suitable for grep or
  further processing.
  Reading never marks a message as read — no mutation as a side effect.
`;

const SIZE_THRESHOLD = 30_000;

interface ParsedFlags {
  id: string;
  full: boolean;
  out: string | undefined;
  messageOnly: boolean;
  headers: boolean;
  raw: boolean;
}

export function parseFlags(args: string[]): ParsedFlags {
  let id: string | undefined;
  let full = false;
  let out: string | undefined;
  let messageOnly = false;
  let headers = false;
  let raw = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--full":
        full = true;
        break;
      case "--out":
        out = next;
        i++;
        break;
      case "--message-only":
        messageOnly = true;
        break;
      case "--headers":
        headers = true;
        break;
      case "--raw":
        raw = true;
        break;
      default:
        if (!arg.startsWith("--") && id === undefined) {
          id = arg;
        }
    }
  }
  if (!id) {
    throw new AxiError("Missing thread or message ID argument", "VALIDATION_ERROR", [
      "Usage: gws-axi gmail read <id>",
      "Get an ID from `gws-axi gmail search`",
    ]);
  }
  if (raw && headers) {
    throw new AxiError("--raw and --headers cannot be combined", "VALIDATION_ERROR", [
      "Use --headers for a structured header list plus the parsed body",
      "Use --raw for the complete undecoded RFC 2822 source",
    ]);
  }
  if (out) full = true;
  return { id, full, out, messageOnly, headers, raw };
}

interface ResolvedThread {
  thread: gmail_v1.Schema$Thread;
  resolved_via_message: string | undefined;
}

async function resolveThread(
  api: gmail_v1.Gmail,
  account: string,
  id: string,
): Promise<ResolvedThread> {
  // First attempt: interpret as a thread ID.
  try {
    const res = await api.users.threads.get({
      userId: "me",
      id,
      format: "full",
    });
    return { thread: res.data, resolved_via_message: undefined };
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "gmail.threads.get",
    });
    if (translated.code !== "NOT_FOUND") throw translated;
  }

  // Fallback: interpret as a message ID, pull its threadId, then re-fetch
  // the parent thread.
  let message: gmail_v1.Schema$Message;
  try {
    const res = await api.users.messages.get({
      userId: "me",
      id,
      format: "minimal",
    });
    message = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "gmail.messages.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(`No thread or message found with ID '${id}'`, "THREAD_NOT_FOUND", [
        `Get a valid ID from \`gws-axi gmail search\``,
        `IDs are 16-character hex strings; double-check for typos`,
      ]);
    }
    throw translated;
  }

  const threadId = message.threadId ?? "";
  if (!threadId) {
    throw new AxiError(
      `Message ${id} has no threadId — cannot resolve parent thread`,
      "THREAD_NOT_FOUND",
      [],
    );
  }

  const threadRes = await api.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });
  return { thread: threadRes.data, resolved_via_message: id };
}

function getHeader(pm: ParsedMessage, name: string): string {
  return pm.headers.get(name.toLowerCase()) ?? "";
}

interface MessageRow {
  index: number;
  id: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  subject: string;
  unread: boolean;
  body_source: string;
  body: string;
  body_total_chars: number;
  body_truncated: boolean;
  attachments: Array<{
    filename: string;
    mime_type: string;
    size_bytes: number;
    attachment_id: string;
  }>;
  inline_image_count: number;
}

function buildMessageRow(msg: gmail_v1.Schema$Message, index: number): MessageRow {
  const pm = parseMessage(msg);
  const unread = (msg.labelIds ?? []).includes("UNREAD");
  return {
    index,
    id: msg.id ?? "",
    from: getHeader(pm, "from"),
    to: getHeader(pm, "to"),
    cc: getHeader(pm, "cc"),
    date: getHeader(pm, "date"),
    subject: getHeader(pm, "subject"),
    unread,
    body_source: pm.body.source,
    body: pm.body.content,
    body_total_chars: pm.body.content.length,
    body_truncated: false,
    attachments: pm.attachments.map((a) => ({
      filename: a.filename,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      attachment_id: a.attachment_id,
    })),
    inline_image_count: pm.inline_image_count,
  };
}

function applyTruncation(rows: MessageRow[]): {
  truncated: boolean;
  total_chars: number;
  shown_chars: number;
} {
  const total_chars = rows.reduce((acc, r) => acc + r.body_total_chars, 0);
  if (total_chars <= SIZE_THRESHOLD) {
    return { truncated: false, total_chars, shown_chars: total_chars };
  }
  // Proportional: each message keeps (its share of the budget) chars.
  // Computed floor so we never overshoot; fine since budget is advisory.
  let shown = 0;
  for (const row of rows) {
    const share = Math.floor((row.body_total_chars / total_chars) * SIZE_THRESHOLD);
    if (row.body_total_chars > share) {
      row.body = `${row.body.slice(0, Math.max(0, share - 1))}…`;
      row.body_truncated = true;
    }
    shown += row.body.length;
  }
  return { truncated: true, total_chars, shown_chars: shown };
}

async function renderSingleMessage(
  api: gmail_v1.Gmail,
  account: string,
  flags: ParsedFlags,
): Promise<string> {
  let msg: gmail_v1.Schema$Message;
  try {
    const res = await api.users.messages.get({
      userId: "me",
      id: flags.id,
      format: "full",
    });
    msg = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "gmail.messages.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(`Message '${flags.id}' not found`, "MESSAGE_NOT_FOUND", [
        `--message-only requires a message ID (not a thread ID)`,
        `Drop --message-only to read the parent thread if the ID is a thread-id`,
        `Get valid message IDs from \`gws-axi gmail read <thread-id>\` output`,
      ]);
    }
    throw translated;
  }

  const row = buildMessageRow(msg, 0);
  const cap = flags.full ? Number.POSITIVE_INFINITY : SIZE_THRESHOLD;
  let truncated = false;
  if (row.body_total_chars > cap) {
    row.body = `${row.body.slice(0, Math.max(0, cap - 1))}…`;
    row.body_truncated = true;
    truncated = true;
  }

  const blocks: string[] = [];
  blocks.push(renderObject({ account }));

  if (flags.out) {
    const defaultName = `${row.subject || msg.id || "message"}.md`;
    const outPath = await resolveOutputPath(flags.out, defaultName);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(
      outPath,
      renderAsMarkdownConversation({ id: msg.threadId ?? "" } as gmail_v1.Schema$Thread, [row]),
    );
    blocks.push(
      renderObject({
        saved: outPath,
        message_chars: row.body_total_chars,
      }),
    );
    return joinBlocks(...blocks);
  }

  blocks.push(
    renderObject({
      message: {
        id: row.id,
        thread_id: msg.threadId ?? "",
        from: row.from,
        to: row.to,
        cc: row.cc,
        date: row.date,
        subject: row.subject,
        unread: row.unread,
        body_source: row.body_source,
        body: row.body,
        ...(row.body_truncated
          ? { body_truncated: true, body_total_chars: row.body_total_chars }
          : {}),
        attachments: row.attachments,
        ...(row.inline_image_count > 0 ? { inline_image_count: row.inline_image_count } : {}),
      },
    }),
  );

  const suggestions: string[] = [];
  if (truncated) {
    suggestions.push(
      `Run \`gws-axi gmail read ${flags.id} --message-only --out <path>\` to save the complete body, or --full to expand inline`,
    );
  }
  if (row.attachments.length > 0) {
    suggestions.push(
      `${row.attachments.length} attachment${row.attachments.length === 1 ? "" : "s"} — use \`gws-axi gmail download ${flags.id} <attachment-id>\` to fetch bytes`,
    );
  }
  suggestions.push(
    `Run \`gws-axi gmail read ${msg.threadId ?? flags.id}\` (without --message-only) to see the full parent thread`,
  );
  blocks.push(renderHelp(suggestions));
  return joinBlocks(...blocks);
}

function renderAsMarkdownConversation(thread: gmail_v1.Schema$Thread, rows: MessageRow[]): string {
  const lines: string[] = [];
  // Thread header
  const subject = rows[0]?.subject ?? "(no subject)";
  lines.push(`# ${subject}`, "");
  lines.push(`Thread ID: \`${thread.id ?? ""}\``);
  lines.push(`Messages: ${rows.length}`, "");
  lines.push("---", "");
  for (const row of rows) {
    lines.push(`## ${row.index + 1}. ${row.from}`, "");
    lines.push(`- **Date:** ${row.date}`);
    if (row.to) lines.push(`- **To:** ${row.to}`);
    if (row.cc) lines.push(`- **Cc:** ${row.cc}`);
    if (row.unread) lines.push(`- **Unread**`);
    if (row.body_source === "html") {
      lines.push(`- **Body source:** HTML → markdown (via turndown)`);
    }
    if (row.attachments.length > 0) {
      lines.push(`- **Attachments:**`);
      for (const a of row.attachments) {
        lines.push(
          `  - \`${a.attachment_id}\` — ${a.filename} (${a.mime_type}, ${a.size_bytes} bytes)`,
        );
      }
    }
    lines.push("", row.body, "", "---", "");
  }
  return lines.join("\n");
}

/**
 * Resolve an id (thread or message) to a single message id. For --raw and
 * --headers we operate on exactly one message: if the id is a message we use
 * it directly; if it's a thread we resolve to its most recent message. With
 * --message-only the id is required to already be a message id.
 */
async function resolveMessageId(
  api: gmail_v1.Gmail,
  account: string,
  flags: ParsedFlags,
): Promise<{ messageId: string; resolvedViaThread: string | undefined }> {
  if (flags.messageOnly) {
    return { messageId: flags.id, resolvedViaThread: undefined };
  }
  // Try message-get first (cheap, format=minimal); if that 404s, treat the id
  // as a thread and take its newest message.
  try {
    const res = await api.users.messages.get({
      userId: "me",
      id: flags.id,
      format: "minimal",
    });
    return { messageId: res.data.id ?? flags.id, resolvedViaThread: undefined };
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "gmail.messages.get",
    });
    if (translated.code !== "NOT_FOUND") throw translated;
  }
  // Fall back to thread → latest message.
  try {
    const res = await api.users.threads.get({
      userId: "me",
      id: flags.id,
      format: "minimal",
    });
    const msgs = res.data.messages ?? [];
    const last = msgs[msgs.length - 1];
    if (!last?.id) {
      throw new AxiError(`Thread ${flags.id} has no messages`, "THREAD_NOT_FOUND", []);
    }
    return { messageId: last.id, resolvedViaThread: flags.id };
  } catch (err) {
    if (err instanceof AxiError) throw err;
    const translated = translateGoogleError(err, {
      account,
      operation: "gmail.threads.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(`No thread or message found with ID '${flags.id}'`, "MESSAGE_NOT_FOUND", [
        "Get a valid ID from `gws-axi gmail search`",
        "IDs are 16-character hex strings; double-check for typos",
      ]);
    }
    throw translated;
  }
}

async function renderHeadersMode(
  api: gmail_v1.Gmail,
  account: string,
  flags: ParsedFlags,
): Promise<string> {
  const { messageId, resolvedViaThread } = await resolveMessageId(api, account, flags);
  let msg: gmail_v1.Schema$Message;
  try {
    const res = await api.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    msg = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.messages.get",
    });
  }

  const row = buildMessageRow(msg, 0);
  // Full header list in the order Gmail returns it, untruncated.
  const headerRows = (msg.payload?.headers ?? [])
    .filter((h) => h.name)
    .map((h) => ({ name: h.name as string, value: h.value ?? "" }));

  const blocks: string[] = [];
  blocks.push(renderObject({ account }));
  blocks.push(
    renderObject({
      message: {
        id: msg.id ?? messageId,
        thread_id: msg.threadId ?? "",
        internal_date: msg.internalDate ?? "",
      },
    }),
  );
  blocks.push(renderList("headers", headerRows, [field("name"), field("value")]));
  // Parsed body too, so the agent gets provenance + readable content at once.
  blocks.push(
    renderObject({
      body: {
        from: row.from,
        to: row.to,
        cc: row.cc,
        date: row.date,
        subject: row.subject,
        body_source: row.body_source,
        body: row.body,
        attachments: row.attachments,
      },
    }),
  );

  const suggestions: string[] = [];
  if (resolvedViaThread) {
    suggestions.push(
      `ID \`${resolvedViaThread}\` was a thread — showed its most recent message \`${msg.id}\`. Pass a message ID with --message-only to target a specific one.`,
    );
  }
  suggestions.push(
    `Run \`gws-axi gmail read ${msg.id} --raw\` for the complete undecoded RFC 2822 source`,
  );
  blocks.push(renderHelp(suggestions));
  return joinBlocks(...blocks);
}

async function renderRawMode(
  api: gmail_v1.Gmail,
  account: string,
  flags: ParsedFlags,
): Promise<string> {
  const { messageId, resolvedViaThread } = await resolveMessageId(api, account, flags);
  let msg: gmail_v1.Schema$Message;
  try {
    const res = await api.users.messages.get({
      userId: "me",
      id: messageId,
      format: "raw",
    });
    msg = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.messages.get",
    });
  }

  const source = msg.raw ? Buffer.from(msg.raw, "base64url").toString("utf8") : "";

  const blocks: string[] = [];
  blocks.push(renderObject({ account }));

  if (flags.out) {
    const defaultName = `${msg.id ?? messageId}.eml`;
    const outPath = await resolveOutputPath(flags.out, defaultName);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, source);
    blocks.push(
      renderObject({
        message: {
          id: msg.id ?? messageId,
          thread_id: msg.threadId ?? "",
          internal_date: msg.internalDate ?? "",
          bytes: Buffer.byteLength(source),
        },
        saved: outPath,
      }),
    );
    return joinBlocks(...blocks);
  }

  blocks.push(
    renderObject({
      message: {
        id: msg.id ?? messageId,
        thread_id: msg.threadId ?? "",
        internal_date: msg.internalDate ?? "",
        bytes: Buffer.byteLength(source),
      },
    }),
  );
  blocks.push(renderObject({ raw: source }));

  if (resolvedViaThread) {
    blocks.push(
      renderHelp([
        `ID \`${resolvedViaThread}\` was a thread — showed its most recent message \`${msg.id}\``,
      ]),
    );
  }
  return joinBlocks(...blocks);
}

export async function gmailReadCommand(account: string, args: string[]): Promise<string> {
  const flags = parseFlags(args);
  const api = await gmailClient(account);

  if (flags.raw) {
    return renderRawMode(api, account, flags);
  }
  if (flags.headers) {
    return renderHeadersMode(api, account, flags);
  }

  if (flags.messageOnly) {
    return renderSingleMessage(api, account, flags);
  }

  const { thread, resolved_via_message } = await resolveThread(api, account, flags.id);

  const messages = thread.messages ?? [];
  const rows = messages.map((m, i) => buildMessageRow(m, i));

  const threadUnread = rows.some((r) => r.unread);
  const threadSubject = rows[0]?.subject ?? "";

  const blocks: string[] = [];
  blocks.push(renderObject({ account }));

  const threadHeader: Record<string, unknown> = {
    id: thread.id ?? flags.id,
    subject: threadSubject,
    message_count: rows.length,
    unread: threadUnread,
  };
  if (resolved_via_message) {
    threadHeader.resolved_via_message = resolved_via_message;
  }
  blocks.push(renderObject({ thread: threadHeader }));

  if (rows.length === 0) {
    blocks.push(renderObject({ messages: [] }));
    blocks.push(renderObject({ message: "thread has no messages" }));
    return joinBlocks(...blocks);
  }

  const totalBodyChars = rows.reduce((a, r) => a + r.body_total_chars, 0);

  if (flags.out) {
    const defaultName = `${threadSubject || thread.id || "thread"}.md`;
    const outPath = await resolveOutputPath(flags.out, defaultName);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, renderAsMarkdownConversation(thread, rows));
    blocks.push(
      renderObject({
        saved: outPath,
        thread_total_chars: totalBodyChars,
      }),
    );
    // Still expose message metadata so the agent knows what landed in the
    // file without having to re-open it.
    blocks.push(
      renderObject({
        messages: rows.map((r) => ({
          index: r.index,
          id: r.id,
          from: r.from,
          date: r.date,
          body_chars: r.body_total_chars,
          attachments: r.attachments.length,
        })),
      }),
    );
    const suggestions: string[] = [
      `Thread written as a markdown conversation — each message is its own \`## N. From\` section`,
    ];
    blocks.push(renderHelp(suggestions));
    return joinBlocks(...blocks);
  }

  const shouldTruncate = !flags.full && totalBodyChars > SIZE_THRESHOLD;
  const truncResult = shouldTruncate
    ? applyTruncation(rows)
    : { truncated: false, total_chars: totalBodyChars, shown_chars: totalBodyChars };

  blocks.push(
    renderObject({
      messages: rows.map((r) => ({
        index: r.index,
        id: r.id,
        from: r.from,
        to: r.to,
        cc: r.cc,
        date: r.date,
        unread: r.unread,
        body_source: r.body_source,
        body: r.body,
        ...(r.body_truncated ? { body_truncated: true, body_total_chars: r.body_total_chars } : {}),
        attachments: r.attachments,
      })),
    }),
  );

  if (truncResult.truncated) {
    blocks.push(
      renderObject({
        thread_truncated: true,
        thread_total_chars: truncResult.total_chars,
        thread_shown_chars: truncResult.shown_chars,
      }),
    );
  }

  const suggestions: string[] = [];
  if (truncResult.truncated) {
    suggestions.push(
      `Run \`gws-axi gmail read ${flags.id} --out <path>\` to save the complete thread as markdown, or --full to expand inline`,
    );
  }
  const totalAttachments = rows.reduce((a, r) => a + r.attachments.length, 0);
  const totalInline = rows.reduce((a, r) => a + r.inline_image_count, 0);
  if (totalAttachments > 0) {
    suggestions.push(
      `${totalAttachments} attachment${totalAttachments === 1 ? "" : "s"} across this thread — use \`gws-axi gmail download <message-id> <attachment-id>\` to fetch bytes`,
    );
  }
  if (totalInline > 0) {
    suggestions.push(
      `${totalInline} inline image${totalInline === 1 ? "" : "s"} embedded in HTML (logos/icons) were not listed as attachments`,
    );
  }
  const htmlOnly = rows.filter((r) => r.body_source === "html");
  if (htmlOnly.length > 0) {
    suggestions.push(
      `${htmlOnly.length} message${htmlOnly.length === 1 ? " had no" : "s had no"} text/plain part — body${htmlOnly.length === 1 ? "" : "ies"} converted from HTML via turndown`,
    );
  }
  if (resolved_via_message) {
    suggestions.push(
      `ID \`${resolved_via_message}\` was a message-id — rendered its parent thread \`${thread.id}\``,
    );
  }
  if (suggestions.length > 0) blocks.push(renderHelp(suggestions));

  return joinBlocks(...blocks);
}
