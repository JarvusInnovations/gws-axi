import { AxiError } from "axi-sdk-js";
import type { chat_v1 } from "googleapis";
import type { ChatUser } from "./identity.js";
import { retryingChat } from "./shared.js";

/**
 * Mentions in a `chat send` body.
 *
 * `@bob@example.com` is rewritten to Chat's mention tag. Every mention —
 * shorthand or a tag written by hand — must then name a member of the
 * conversation, because Chat doesn't refuse one it can't resolve: it posts the
 * literal text `<chat-user>` in its place.
 *
 * See specs/commands/chat-send.md § Body.
 */

// An address directly after `@`, at the start or after whitespace/punctuation.
// A backslash before `@` isn't a boundary, so `\@x@y.z` stays literal.
const SHORTHAND =
  /(^|[\s([{,;:!?"'>*_~])@([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const TAG = /<chat-user\s+([^>]*)>\s*<\/chat-user>/g;
const DATA_EMAIL = /data-email="([^"]*)"/;
const DATA_USER = /data-user="([^"]*)"/;
const FENCE = /^\s*(```|~~~)/;

export interface Mentions {
  /** The body with shorthand rewritten to tags. */
  body: string;
  /** Addresses mentioned, lowercased, in order of first appearance. */
  emails: string[];
  /** `users/{id}` references mentioned by tag. */
  userIds: string[];
}

export const mentionTag = (email: string): string =>
  `<chat-user data-email="${email}"></chat-user>`;

/** Rewrite shorthand in prose, leaving inline code spans alone. */
function rewriteProse(text: string): string {
  return text
    .split(/(`+[^`]*?`+)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(SHORTHAND, (_m, pre, email) => `${pre}${mentionTag(email)}`),
    )
    .join("");
}

export function expandMentions(body: string): Mentions {
  const lines = body.split("\n");
  let inFence = false;
  const out = lines.map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return line;
    }
    return inFence ? line : rewriteProse(line);
  });
  const rewritten = out.join("\n");

  // Collected from the rewritten body, outside code, so hand-written tags count too.
  const emails: string[] = [];
  const userIds: string[] = [];
  inFence = false;
  for (const line of rewritten.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const prose = line
      .split(/(`+[^`]*?`+)/)
      .filter((_p, i) => i % 2 === 0)
      .join(" ");
    for (const match of prose.matchAll(TAG)) {
      const email = DATA_EMAIL.exec(match[1])?.[1]?.trim().toLowerCase();
      const user = DATA_USER.exec(match[1])?.[1]?.trim();
      if (email && !emails.includes(email)) emails.push(email);
      if (user && user !== "users/all" && !userIds.includes(user)) userIds.push(user);
    }
  }
  return { body: rewritten, emails, userIds };
}

/** Mentions that don't name a member: addresses and ids, as given. */
export function nonMembers(
  mentions: Pick<Mentions, "emails" | "userIds">,
  members: ChatUser[],
): string[] {
  const emails = new Set(members.map((m) => m.email?.toLowerCase()).filter(Boolean));
  const ids = new Set(members.map((m) => m.name).filter(Boolean));
  return [
    ...mentions.emails.filter((e) => !emails.has(e)),
    ...mentions.userIds.filter((u) => !ids.has(u)),
  ];
}

/** Refuse, before sending, a mention of anyone outside the conversation. */
export async function checkMentions(
  api: chat_v1.Chat,
  spaceName: string,
  spaceId: string,
  mentions: Mentions,
): Promise<void> {
  if (mentions.emails.length === 0 && mentions.userIds.length === 0) return;
  const members: ChatUser[] = [];
  let pageToken: string | undefined;
  do {
    const res = await retryingChat(() =>
      api.spaces.members.list({ parent: spaceName, pageSize: 1000, pageToken }),
    );
    for (const m of res.data.memberships ?? []) {
      if (m.member) members.push(m.member as ChatUser);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const refused = nonMembers(mentions, members);
  if (refused.length > 0) {
    throw new AxiError(
      `Not a member of conversation ${spaceId}: ${refused.join(", ")} — nothing was posted`,
      "MENTION_NOT_MEMBER",
      [
        `Run \`gws-axi chat members ${spaceId}\` to see who can be mentioned here`,
        "Check the address for typos; Chat would post an unresolved mention as the literal text <chat-user>",
        "To write an address without mentioning anyone, drop the leading @ or escape it as \\@",
      ],
    );
  }
}
