import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import type { gmail_v1 } from "googleapis";
import { gmailClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { buildRawMessage, parseRecipients } from "./compose.js";

export const DRAFT_HELP = `usage: gws-axi gmail draft --to <emails> --subject <text> --body <markdown> [flags]
flags[8]:
  --to <emails>        REQUIRED — comma-separated recipient addresses
  --subject <text>     Subject line (default: empty)
  --body <text>        Body text. Pass via quoted string or shell heredoc
  --body-file <path>   Read the body from a file instead of --body (mutually
                       exclusive with --body; use for long/multi-line bodies)
  --cc <emails>        Comma-separated Cc addresses
  --bcc <emails>       Comma-separated Bcc addresses
  --thread <thread-id> Attach the draft to an existing thread (reply draft)
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi gmail draft --to alice@x.com --subject "Re: budget" --body "Looks good — approving."
  gws-axi gmail draft --to a@x.com,b@x.com --subject Hi --body-file ./note.txt
  gws-axi gmail draft --to alice@x.com --subject "Re: thread" --body "..." --thread 1899abcd
notes:
  Creates a DRAFT only — gws-axi never sends mail. Review and send from the
  Gmail UI. Body is sent as plain text (text/plain; UTF-8); any markdown is
  preserved verbatim, not rendered to HTML.
output:
  Returns \`action: drafted\` plus the new draft_id, message_id, recipients,
  and subject. A help line links to where to review/send it.
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
    }
  }
  return flags;
}

function resolveBody(flags: ParsedFlags): string {
  if (flags.body !== undefined && flags.bodyFile !== undefined) {
    throw new AxiError(
      "--body and --body-file are mutually exclusive",
      "VALIDATION_ERROR",
      ["Pass the body inline with --body OR from a file with --body-file, not both"],
    );
  }
  if (flags.bodyFile !== undefined) {
    try {
      return readFileSync(flags.bodyFile, "utf8");
    } catch {
      throw new AxiError(
        `Cannot read --body-file: ${flags.bodyFile}`,
        "VALIDATION_ERROR",
        ["Check the path exists and is readable"],
      );
    }
  }
  return flags.body ?? "";
}

export async function gmailDraftCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  if (flags.to.length === 0) {
    throw new AxiError("--to is required", "VALIDATION_ERROR", [
      `Usage: gws-axi gmail draft --to <emails> --subject <text> --body <text>`,
    ]);
  }
  const body = resolveBody(flags);

  const raw = buildRawMessage({
    from: account,
    to: flags.to,
    cc: flags.cc.length ? flags.cc : undefined,
    bcc: flags.bcc.length ? flags.bcc : undefined,
    subject: flags.subject,
    body,
  });

  const message: gmail_v1.Schema$Message = { raw };
  if (flags.thread) message.threadId = flags.thread;

  const api = await gmailClient(account);
  let draft: gmail_v1.Schema$Draft;
  try {
    const res = await api.users.drafts.create({
      userId: "me",
      requestBody: { message },
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
    renderHelp([
      "Draft saved — NOT sent. Review and send it from the Gmail UI (Drafts folder)",
      `Edit or delete it later via the draft_id (${draft.id ?? ""})`,
    ]),
  );
}
