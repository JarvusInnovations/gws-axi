import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import type { chat_v1 } from "googleapis";
import { isJoinedInstall, readSetupState } from "../../config.js";
import { chatClient } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { resolveSpaceTarget, type SpaceTarget } from "./address.js";
import { parseArgs } from "./flags.js";
import { IdentityLedger, type ChatUser } from "./identity.js";
import { checkMentions, expandMentions } from "./mentions.js";
import { bareId, chatError, localTime, nameSpaces, resolveSpace } from "./shared.js";
import { mentionedUsers, renderMessageText } from "./text.js";

export const SEND_HELP = `usage: gws-axi chat send <space> (--text <string> | --body-file <path> | -) [flags]
       gws-axi chat send --with <email> (--text <string> | --body-file <path> | -) [flags]
args[2]:
  <space>              A conversation id (AAAA… or spaces/AAAA…) or a Chat URL.
                       ONE conversation — there is no way to send to several.
  -                    Read the message body from stdin
flags[6]:
  --text <string>      The message body, inline
  --body-file <path>   Read the message body from a file
  --with <email>       Send to the 1:1 direct message with this person instead
                       of naming a conversation
  --thread <id>        Reply inside this thread. Fails if the thread doesn't
                       exist — it never falls back to starting a new one.
  --request-id <key>   Make the send safe to retry: a second send with the
                       same key in the same conversation posts nothing.
                       Lowercase letters, digits, hyphens; up to 56 chars.
  --account <email>    REQUIRED when 2+ accounts are authenticated
                       (or set GWS_AXI_ACCOUNT)
examples:
  gws-axi chat send AAAAxyz --text "Feed is back up — @bob@example.com can you confirm?" --account you@example.com
  gws-axi chat send AAAAxyz --thread t8Q… --body-file ./reply.md --account you@example.com
  echo "deploy finished" | gws-axi chat send AAAAxyz - --request-id deploy-4821 --account you@example.com
output:
  \`action\` (sent | already_sent), the \`space{id,type,name}\` it went to, a
  \`message{id,thread,time,request_id}\` block, and \`text\` as Chat stored it.
notes:
  THIS SENDS. The message is delivered the moment the command returns, and
  gws-axi cannot delete it. There is no draft step.
  The body is Markdown: **bold**, *italic*, ~~strike~~, \`code\`, fenced code,
  lists, > quotes and [text](url) all render as formatting. The characters
  * _ ~ \` # > [ ] are therefore interpreted, not literal.
  Mention someone with @ + their email: @bob@example.com. They're notified,
  and it shows as @Bob Tran. Everyone mentioned must be a member of the
  conversation — otherwise nothing is sent (MENTION_NOT_MEMBER). A bare
  address, one in \`code\`, or \\@bob@example.com stays plain text.
  Re-running without --request-id sends the message AGAIN.
  Members see the message as sent by the account, with the name of the Chat
  app configured on the Google Cloud project shown beside it.
  Sending needs that Chat app to be configured; reading does not.
`;

const COMMAND = "chat send";
const USAGE =
  "Usage: gws-axi chat send <space> (--text <string> | --body-file <path> | -) [--thread <id>]";
/** Chat's limit on a message, contents included. */
export const MAX_BYTES = 32_000;
const REQUEST_ID = /^[a-z0-9-]{1,56}$/;

export type BodySource =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string }
  | { kind: "stdin" };

interface Flags {
  target: SpaceTarget;
  body: BodySource;
  thread: string | undefined;
  requestId: string;
  /** True when the caller chose the request id, so a retry is plausible. */
  requestIdGiven: boolean;
}

export function parseSendFlags(args: string[], newId: () => string = randomUUID): Flags {
  const parsed = parseArgs(
    args,
    { value: ["--text", "--body-file", "--with", "--thread", "--request-id"] },
    COMMAND,
  );
  const stdin = parsed.positionals.includes("-");
  const positionals = parsed.positionals.filter((p) => p !== "-");
  if (positionals.length > 1) {
    // The one rule that keeps a send from reaching an audience nobody chose.
    throw new AxiError(
      `\`${COMMAND}\` sends to one conversation, got ${positionals.length}: ${positionals.join(", ")}`,
      "VALIDATION_ERROR",
      ["Send to each conversation with its own command", USAGE],
    );
  }

  const sources: BodySource[] = [];
  if (parsed.values["--text"] !== undefined) {
    sources.push({ kind: "text", text: parsed.values["--text"] });
  }
  if (parsed.values["--body-file"] !== undefined) {
    sources.push({ kind: "file", path: parsed.values["--body-file"] });
  }
  if (stdin) sources.push({ kind: "stdin" });
  if (sources.length !== 1) {
    throw new AxiError(
      sources.length === 0
        ? "No message body: pass --text, --body-file, or - for stdin"
        : "Pass exactly one of --text, --body-file, or - (stdin)",
      "VALIDATION_ERROR",
      [USAGE],
    );
  }

  const given = parsed.values["--request-id"];
  if (given !== undefined && !REQUEST_ID.test(given)) {
    throw new AxiError(`Invalid --request-id: ${given}`, "VALIDATION_ERROR", [
      "Use lowercase letters, digits, and hyphens, up to 56 characters — e.g. deploy-4821",
    ]);
  }

  return {
    target: resolveSpaceTarget(
      { positional: positionals[0], withEmail: parsed.values["--with"] },
      USAGE,
    ),
    body: sources[0],
    thread: parsed.values["--thread"] ? bareId(parsed.values["--thread"]) : undefined,
    requestId: given ?? newId(),
    requestIdGiven: given !== undefined,
  };
}

export function readBody(
  source: BodySource,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): string {
  let text: string;
  if (source.kind === "text") {
    text = source.text;
  } else if (source.kind === "stdin") {
    text = readStdin();
  } else {
    try {
      text = readFileSync(source.path, "utf8");
    } catch {
      throw new AxiError(`Cannot read --body-file: ${source.path}`, "VALIDATION_ERROR", [
        "Check the path exists and is readable",
      ]);
    }
  }
  if (text.trim() === "") {
    throw new AxiError("The message body is empty", "VALIDATION_ERROR", [USAGE]);
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_BYTES) {
    throw new AxiError(
      `Message is ${bytes} bytes; Chat's limit is ${MAX_BYTES}`,
      "MESSAGE_TOO_LARGE",
      ["Shorten it, or send it as several messages"],
    );
  }
  return text;
}

function statusOf(err: unknown): number | undefined {
  const shape = err as {
    code?: number | string;
    response?: { status?: number; data?: { error?: { code?: number } } };
  };
  return (
    shape.response?.data?.error?.code ??
    shape.response?.status ??
    (typeof shape.code === "number" ? shape.code : undefined)
  );
}

function messageOf(err: unknown): string {
  const shape = err as { message?: string; response?: { data?: { error?: { message?: string } } } };
  return shape.response?.data?.error?.message ?? shape.message ?? "";
}

/**
 * Whether a failed send may nonetheless have posted. Chat answering with a
 * refusal (4xx) means it didn't. No answer at all, or a server error, means
 * nobody knows — which is the case a blind retry turns into a duplicate.
 */
export function mayHavePosted(err: unknown): boolean {
  const status = statusOf(err);
  return status === undefined || status >= 500;
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** This invocation again, carrying the request id that makes it safe to repeat. */
export function retryCommand(args: string[], requestId: string, account: string): string {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--request-id") {
      i++;
      continue;
    }
    kept.push(quoteArg(args[i]));
  }
  return `gws-axi chat send ${kept.join(" ")} --request-id ${requestId} --account ${account}`;
}

/** The error for a send nobody can confirm, leading with the safe retry. */
export function unconfirmedSend(
  err: unknown,
  context: { args: string[]; requestId: string; account: string; spaceId: string },
): AxiError {
  const status = statusOf(err);
  const detail = status ? `HTTP ${status}` : messageOf(err) || "no response";
  return new AxiError(
    `The send to ${context.spaceId} did not complete (${detail}) — it may or may not have been posted`,
    "SEND_UNCONFIRMED",
    [
      `Retry safely — this cannot post a duplicate: \`${retryCommand(context.args, context.requestId, context.account)}\``,
      `Or check first: \`gws-axi chat messages ${context.spaceId} --limit 5\``,
    ],
  );
}

export function appNotConfigured(account: string): AxiError {
  let joined = false;
  try {
    joined = isJoinedInstall(readSetupState());
  } catch {
    // Unreadable setup state: fall through to the owner's guidance.
  }
  const suggestions = joined
    ? [
        "Ask whoever distributed your gws-axi credentials to configure a Chat app on the shared project",
        "You don't need Google Cloud Console access — this is a project-side setting only they can change",
      ]
    : [
        "In the Google Cloud Console for your gws-axi project, open the Google Chat API → Configuration, and set an app name, avatar URL, and description",
        "Choose the app name with care: it is shown beside every message sent",
        "Interactive features can be left off — gws-axi only posts as you",
      ];
  suggestions.push(`Reading is unaffected: \`gws-axi chat messages <space>\` needs no Chat app`);
  return new AxiError(
    `Sending needs a Chat app configured on the Google Cloud project behind ${account}'s sign-in`,
    "CHAT_APP_NOT_CONFIGURED",
    suggestions,
  );
}

type Message = chat_v1.Schema$Message;

async function renderSent(
  account: string,
  api: chat_v1.Chat,
  space: chat_v1.Schema$Space,
  message: Message,
  flags: Flags,
  action: "sent" | "already_sent",
): Promise<string> {
  const { named } = await nameSpaces(api, account, [space]);
  const header = named[0];
  const ledger = new IdentityLedger();
  for (const user of mentionedUsers(message)) ledger.add(user);
  const stored = renderMessageText(message, (user: ChatUser) => ledger.label(user));
  const thread = bareId(message.thread?.name);

  const notes =
    action === "sent"
      ? `Delivered. Members see this as sent by ${account}, with the project's Chat app name shown beside it.`
      : `Nothing was posted: a message with request id ${flags.requestId} already exists in this conversation, and is shown above.`;

  const help = [
    `Run \`gws-axi chat messages ${header.id} --thread ${thread}\` to read the thread`,
    action === "sent"
      ? `Re-running this command without \`--request-id ${flags.requestId}\` sends the message again`
      : "Send a different message by changing or dropping --request-id",
  ];

  return joinBlocks(
    renderObject({ account }),
    renderObject({ action }),
    renderObject({ space: { id: header.id, type: header.type, name: header.name } }),
    renderObject({
      message: {
        id: bareId(message.name),
        thread,
        time: localTime(message.createTime),
        request_id: flags.requestId,
      },
    }),
    renderObject({ text: stored }),
    renderObject({ note: notes }),
    renderHelp(help),
  );
}

export async function chatSendCommand(account: string, args: string[]): Promise<string> {
  // Everything that can be refused without touching Chat is refused first.
  const flags = parseSendFlags(args);
  const mentions = expandMentions(readBody(flags.body));
  const text = mentions.body;

  const api = await chatClient(account);
  const space = await resolveSpace(api, account, flags.target);
  const spaceName = space.name ?? "";
  const spaceId = bareId(spaceName);

  if (flags.thread && space.spaceThreadingState === "UNTHREADED_MESSAGES") {
    throw new AxiError(
      `Conversation ${spaceId} does not thread its messages, so there is no thread to reply in`,
      "VALIDATION_ERROR",
      [`Drop --thread to post to the conversation: \`gws-axi chat send ${spaceId} --text "…"\``],
    );
  }

  // Chat posts an unresolvable mention as the literal text <chat-user>, so a
  // mention of anyone outside the conversation is refused before sending.
  try {
    await checkMentions(api, spaceName, spaceId, mentions);
  } catch (err) {
    if (err instanceof AxiError) throw err;
    throw chatError(err, { account, operation: "chat.spaces.members.list", space: spaceId });
  }

  // The request id rides as the message's client-assigned id. Chat refuses a
  // second message with the same id here, so a replay is recognized by Chat's
  // own answer rather than guessed from timing.
  const messageId = `client-${flags.requestId}`;

  try {
    const res = await api.spaces.messages.create({
      parent: spaceName,
      messageId,
      // A reply that can't find its thread must fail, not land as a new
      // top-level message in front of a different audience.
      messageReplyOption: flags.thread ? "REPLY_MESSAGE_OR_FAIL" : undefined,
      requestBody: {
        text,
        markupSyntax: "MARKUP_SYNTAX_MARKDOWN",
        ...(flags.thread ? { thread: { name: `${spaceName}/threads/${flags.thread}` } } : {}),
      },
    });
    return renderSent(account, api, space, res.data, flags, "sent");
  } catch (err) {
    const status = statusOf(err);
    const message = messageOf(err);

    if (status === 409 || /already exists/i.test(message)) {
      const existing = await api.spaces.messages
        .get({ name: `${spaceName}/messages/${messageId}`, markupSyntax: "MARKUP_SYNTAX_MARKDOWN" })
        .catch(() => undefined);
      if (existing) return renderSent(account, api, space, existing.data, flags, "already_sent");
    }

    if (/chat app not found|configure the app|chat app/i.test(message) && status !== 403) {
      throw appNotConfigured(account);
    }

    if (mayHavePosted(err)) {
      throw unconfirmedSend(err, { args, requestId: flags.requestId, account, spaceId });
    }

    const translated = chatError(err, {
      account,
      operation: "chat.spaces.messages.create",
      space: spaceId,
      thread: flags.thread,
    });
    translated.suggestions.unshift("Nothing was posted — Chat refused the message");
    throw translated;
  }
}
