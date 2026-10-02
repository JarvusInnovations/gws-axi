import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Readable } from "node:stream";
import { AxiError } from "axi-sdk-js";
import type { gmail_v1 } from "googleapis";
import { gmailClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { detectMimeType } from "../../util/mime-types.js";
import { renderList, field } from "../../output/index.js";
import { MAX_ATTACHMENT_BYTES, buildMessage, parseRecipients, type Attachment } from "./compose.js";

export const DRAFT_HELP = `usage: gws-axi gmail draft --to <emails> --subject <text> --body <markdown> [flags]
flags[10]:
  --to <emails>        REQUIRED — comma-separated recipient addresses
  --subject <text>     Subject line (default: empty)
  --body <text>        Body text. Pass via quoted string or shell heredoc
  --body-file <path>   Read the body from a file instead of --body (mutually
                       exclusive with --body; use for long/multi-line bodies)
  --cc <emails>        Comma-separated Cc addresses
  --bcc <emails>       Comma-separated Bcc addresses
  --thread <thread-id> Attach the draft to an existing thread (reply draft)
  --plain              Treat the body as LITERAL text, not markdown. Use when
                       *, _, # or backticks must reach the reader as typed
  --attach <path>      Attach a local file. Repeatable. 25 MB total (Gmail's
                       limit); for anything larger, share a Drive link instead
  --account <email>    REQUIRED when 2+ accounts are authenticated (or set GWS_AXI_ACCOUNT)
examples:
  gws-axi gmail draft --to alice@x.com --subject "Re: budget" --body "Looks good — approving."
  gws-axi gmail draft --to a@x.com,b@x.com --subject Hi --body-file ./note.txt
  gws-axi gmail draft --to alice@x.com --subject "Re: thread" --body "..." --thread 1899abcd
  gws-axi gmail draft --to rfp@agency.gov --subject "RFI response" --body-file ./cover.md --attach ./response.docx
notes:
  Creates a DRAFT only — gws-axi never sends mail. Review and send from the
  Gmail UI. The body is markdown, rendered to a single text/html part so
  recipients get reflowable, formatted text (Gmail adds the plain-text
  alternative itself on send).
  DO NOT hard-wrap the body. Write each paragraph as one long line — every
  newline you write becomes a line break in the sent message, so a body
  pre-wrapped at 72/80 columns arrives locked to that width on every screen.
  Blank line = new paragraph. GFM applies: **bold**, lists, tables, fenced
  code blocks (use those for text meant literally) — or pass --plain to turn
  markdown off entirely and keep indentation as typed.
output:
  Returns \`action: drafted\` plus the new draft_id, message_id, recipients,
  and subject, and an attachments[N]{name,size_bytes,mime_type} list when files
  were attached. A help line links to where to review/send it.
`;

export const SEND_HELP = `usage: gws-axi gmail send — INTENTIONALLY OUT OF SCOPE
status: not supported by design
notes:
  gws-axi deliberately does not send mail. It can draft messages for you, but
  sending is left to a human in the Gmail UI so an automated agent can't email
  people on your behalf. Use \`gws-axi gmail draft\` to compose, then review and
  send the draft yourself in Gmail.
`;

interface ParsedFlags {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string | undefined;
  bodyFile: string | undefined;
  thread: string | undefined;
  plain: boolean;
  attach: string[];
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: undefined,
    bodyFile: undefined,
    thread: undefined,
    plain: false,
    attach: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--to":
        flags.to = parseRecipients(next ?? "");
        i++;
        break;
      case "--cc":
        flags.cc = parseRecipients(next ?? "");
        i++;
        break;
      case "--bcc":
        flags.bcc = parseRecipients(next ?? "");
        i++;
        break;
      case "--subject":
        flags.subject = next ?? "";
        i++;
        break;
      case "--body":
        flags.body = next;
        i++;
        break;
      case "--body-file":
        flags.bodyFile = next;
        i++;
        break;
      case "--thread":
        flags.thread = next;
        i++;
        break;
      case "--plain":
        flags.plain = true;
        break;
      case "--attach":
        if (next !== undefined) flags.attach.push(next);
        i++;
        break;
    }
  }
  return flags;
}

function resolveBody(flags: ParsedFlags): string {
  if (flags.body !== undefined && flags.bodyFile !== undefined) {
    throw new AxiError("--body and --body-file are mutually exclusive", "VALIDATION_ERROR", [
      "Pass the body inline with --body OR from a file with --body-file, not both",
    ]);
  }
  if (flags.bodyFile !== undefined) {
    try {
      return readFileSync(flags.bodyFile, "utf8");
    } catch {
      throw new AxiError(`Cannot read --body-file: ${flags.bodyFile}`, "VALIDATION_ERROR", [
        "Check the path exists and is readable",
      ]);
    }
  }
  return flags.body ?? "";
}

/**
 * Read every `--attach` file, refusing before anything is drafted when a path
 * is missing or the total passes Gmail's limit.
 */
export function readAttachments(paths: string[]): Attachment[] {
  const files: Array<{ path: string; size: number }> = [];
  for (const path of paths) {
    const abs = resolve(process.cwd(), path);
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new AxiError(`Attachment not found: ${path}`, "LOCAL_FILE_NOT_FOUND", [
        "Check the path; it must be a readable file on this machine",
        "Nothing was drafted",
      ]);
    }
    if (st.isDirectory()) {
      throw new AxiError(`Attachment is a directory, not a file: ${path}`, "LOCAL_PATH_NOT_FILE", [
        "Attach files one by one, or zip the folder first",
      ]);
    }
    files.push({ path: abs, size: st.size });
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    throw new AxiError(
      `Attachments total ${mb(total)}, over Gmail's ${mb(MAX_ATTACHMENT_BYTES)} limit`,
      "ATTACHMENT_TOO_LARGE",
      [
        "Upload the file to Drive and share a link instead: `gws-axi drive upload <path> --account <email>`, then `gws-axi drive share <id> --with <recipient> --account <email>`",
        "Nothing was drafted",
      ],
    );
  }
  return files.map((f) => ({
    name: basename(f.path),
    mimeType: detectMimeType(f.path),
    content: readFileSync(f.path),
  }));
}

export async function gmailDraftCommand(account: string, args: string[]): Promise<string> {
  const flags = parseFlags(args);
  if (flags.to.length === 0) {
    throw new AxiError("--to is required", "VALIDATION_ERROR", [
      `Usage: gws-axi gmail draft --to <emails> --subject <text> --body <text>`,
    ]);
  }
  const body = resolveBody(flags);
  const attachments = readAttachments(flags.attach);

  const mime = buildMessage({
    from: account,
    to: flags.to,
    cc: flags.cc.length ? flags.cc : undefined,
    bcc: flags.bcc.length ? flags.bcc : undefined,
    subject: flags.subject,
    body,
    plain: flags.plain,
    attachments,
  });

  // Sent as an upload (message/rfc822) rather than a base64url `raw` field,
  // which keeps a full 25 MB of attachments inside the API's request limit.
  const message: gmail_v1.Schema$Message = {};
  if (flags.thread) message.threadId = flags.thread;

  const api = await gmailClient(account);
  let draft: gmail_v1.Schema$Draft;
  try {
    const res = await api.users.drafts.create({
      userId: "me",
      requestBody: { message },
      media: { mimeType: "message/rfc822", body: Readable.from([Buffer.from(mime, "utf8")]) },
    });
    draft = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.drafts.create",
    });
  }

  const result: Record<string, unknown> = {
    action: "drafted",
    account,
    draft_id: draft.id ?? "",
    message_id: draft.message?.id ?? "",
    to: flags.to.join(", "),
    subject: flags.subject || "(no subject)",
  };
  if (flags.cc.length) result.cc = flags.cc.join(", ");
  if (flags.thread) result.thread_id = flags.thread;

  return joinBlocks(
    renderObject(result),
    attachments.length
      ? renderList(
          "attachments",
          attachments.map((a) => ({
            name: a.name,
            size_bytes: a.content.length,
            mime_type: a.mimeType,
          })),
          [field("name"), field("size_bytes"), field("mime_type")],
        )
      : "",
    renderHelp([
      "Draft saved — NOT sent. Review and send it from the Gmail UI (Drafts folder)",
      `Edit or delete it later via the draft_id (${draft.id ?? ""})`,
    ]),
  );
}
