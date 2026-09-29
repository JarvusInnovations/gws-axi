import type { chat_v1 } from "googleapis";
import { resolvePeople, type PeopleResolution } from "../../google/people.js";
import { field, type FieldDef } from "../../output/index.js";
import { IdentityLedger, type ChatUser } from "./identity.js";
import { bareId, localTime } from "./shared.js";
import { mentionedUsers, renderMessageText, TEXT_CAP, truncateKeepingLinks } from "./text.js";

/**
 * Turning Chat messages into rows — shared by `chat messages` and
 * `chat search`, which differ only in whether a row names its conversation.
 */

type Message = chat_v1.Schema$Message;

export const FIELD_CHOICES = ["thread", "attachments", "reactions", "edited", "quoted"] as const;
export type OptionalField = (typeof FIELD_CHOICES)[number];

export interface MessageRow {
  space: string;
  id: string;
  time: string;
  sender: string;
  thread: string;
  text: string;
  attachments: number;
  reactions: number;
  edited: string;
  quoted: string;
}

export interface AttachmentRow {
  message: string;
  name: string;
  type: string;
  source: "drive" | "upload";
  /** The Drive file id, for `drive get`. Empty for uploaded content. */
  drive_file: string;
}

/** Register everyone these messages involve, then name whoever Chat didn't. */
export async function identifyPeople(
  account: string,
  messages: Message[],
): Promise<{ ledger: IdentityLedger; resolution: PeopleResolution }> {
  const ledger = new IdentityLedger();
  for (const message of messages) {
    ledger.add(message.sender as ChatUser);
    for (const user of mentionedUsers(message)) ledger.add(user);
    ledger.add(message.quotedMessageMetadata?.quotedMessageSnapshot?.sender as ChatUser);
  }
  const resolution = await resolvePeople(account, ledger.needsLookup());
  ledger.applyResolution(resolution);
  return { ledger, resolution };
}

/**
 * Whether a `thread` column would tell the reader anything: some thread holds
 * more than one of these messages, or one is marked a reply. A conversation's
 * threading state can't answer this — direct messages report as threaded
 * while every message in them is its own thread.
 */
export function threadsCarryInformation(messages: Message[]): boolean {
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.threadReply) return true;
    const thread = message.thread?.name;
    if (!thread) continue;
    if (seen.has(thread)) return true;
    seen.add(thread);
  }
  return false;
}

function quotedSummary(message: Message, ledger: IdentityLedger): string {
  const snapshot = message.quotedMessageMetadata?.quotedMessageSnapshot;
  if (!snapshot) return "";
  const who = ledger.label(snapshot.sender as ChatUser);
  const text = truncateKeepingLinks(snapshot.text ?? "", 120);
  return who ? `${who}: ${text}` : text;
}

export function toRow(
  message: Message,
  ledger: IdentityLedger,
  options: { full: boolean },
): MessageRow {
  const text = renderMessageText(message, (user) => ledger.label(user));
  const reactions = (message.emojiReactionSummaries ?? []).reduce(
    (sum, r) => sum + (r.reactionCount ?? 0),
    0,
  );
  return {
    space: bareId(message.space?.name),
    id: bareId(message.name),
    time: localTime(message.createTime),
    sender: ledger.label(message.sender as ChatUser),
    thread: bareId(message.thread?.name),
    text: options.full ? text : truncateKeepingLinks(text, TEXT_CAP),
    attachments: message.attachment?.length ?? 0,
    reactions,
    edited: localTime(message.lastUpdateTime),
    quoted: quotedSummary(message, ledger),
  };
}

/** The senders legend: each sender once, keeping every id reachable. */
export function senderRows(messages: Message[], ledger: IdentityLedger): Record<string, unknown>[] {
  const refs = new Set(messages.map((m) => m.sender?.name).filter(Boolean));
  return ledger
    .rows()
    .filter((row) => refs.has(row.id))
    .map((row) => ({ ...row }));
}

export function attachmentRows(messages: Message[]): AttachmentRow[] {
  return messages.flatMap((message) =>
    (message.attachment ?? []).map((a): AttachmentRow => {
      const driveFile = a.driveDataRef?.driveFileId ?? "";
      return {
        message: bareId(message.name),
        name: a.contentName ?? "",
        type: a.contentType ?? "",
        source: driveFile || a.source === "DRIVE_FILE" ? "drive" : "upload",
        drive_file: driveFile,
      };
    }),
  );
}

/** Columns for a message table, in display order. */
export function messageSchema(options: {
  withSpace: boolean;
  withThread: boolean;
  fields: OptionalField[];
}): FieldDef[] {
  const schema: FieldDef[] = [];
  if (options.withSpace) schema.push(field("space"));
  schema.push(field("id"), field("time"), field("sender"));
  if (options.withThread || options.fields.includes("thread")) schema.push(field("thread"));
  for (const name of ["attachments", "reactions", "edited", "quoted"] as const) {
    if (options.fields.includes(name)) schema.push(field(name));
  }
  schema.push(field("text"));
  return schema;
}

export const ATTACHMENT_SCHEMA: FieldDef[] = [
  field("message"),
  field("name"),
  field("type"),
  field("source"),
  field("drive_file"),
];
