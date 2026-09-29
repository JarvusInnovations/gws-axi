import type { chat_v1 } from "googleapis";
import type { ChatUser } from "./identity.js";

/**
 * Message text as Markdown.
 *
 * Messages are requested with the Markdown markup syntax, so links already
 * arrive as `[text](url)`. Mentions don't arrive usable: the Markdown form
 * carries an empty `<chat-user data-user="users/{id}"></chat-user>` tag, while
 * the readable `@Name` lives in the plain `text`, located by the mention
 * annotation's offsets. This puts the two together.
 */

type Message = chat_v1.Schema$Message;

const MENTION_TAG = /<chat-user\s+([^>]*)>[^<]*<\/chat-user>/g;
const DATA_USER = /data-user="([^"]*)"/;
const DATA_EMAIL = /data-email="([^"]*)"/;

export const TEXT_CAP = 500;

interface Mention {
  ref: string;
  /** What the message shows for this mention, e.g. `@Bob Tran`. */
  shown: string;
  user: ChatUser | undefined;
}

function mentionsOf(message: Message): Mention[] {
  const text = message.text ?? "";
  const mentions: Mention[] = [];
  for (const annotation of message.annotations ?? []) {
    if (annotation.type !== "USER_MENTION") continue;
    const user = annotation.userMention?.user ?? undefined;
    const ref = user?.name;
    if (!ref) continue;
    const start = annotation.startIndex ?? 0;
    const shown = text.slice(start, start + (annotation.length ?? 0));
    mentions.push({ ref, shown, user });
  }
  return mentions;
}

/** Every user a message mentions — so callers can register them for naming. */
export function mentionedUsers(message: Message): ChatUser[] {
  return mentionsOf(message).flatMap((m) => (m.user ? [m.user] : []));
}

/**
 * The message's text, with each mention tag replaced by what it displays.
 * `labelFor` supplies a name for a mention whose annotation is missing or
 * carries no readable text.
 */
export function renderMessageText(message: Message, labelFor: (user: ChatUser) => string): string {
  const source = message.formattedText ?? message.text ?? "";
  if (!source.includes("<chat-user")) return unwrapSoftBreaks(source);

  // Tags and annotations both follow reading order, so match them in turn,
  // per person, rather than by position in differently-encoded strings.
  const queues = new Map<string, Mention[]>();
  for (const mention of mentionsOf(message)) {
    const queue = queues.get(mention.ref) ?? [];
    queue.push(mention);
    queues.set(mention.ref, queue);
  }

  const named = source.replace(MENTION_TAG, (_tag, attrs: string) => {
    const ref = DATA_USER.exec(attrs)?.[1];
    if (ref === "users/all") return "@all";
    if (ref) {
      const mention = queues.get(ref)?.shift();
      if (mention?.shown.startsWith("@")) return mention.shown;
      const label = labelFor(mention?.user ?? { name: ref });
      return `@${label || ref}`;
    }
    const email = DATA_EMAIL.exec(attrs)?.[1];
    return email ? `@${email}` : "@(unknown)";
  });
  return unwrapSoftBreaks(named);
}

const FENCE = /^\s*(```|~~~)/;
// A line that begins a block of its own and so must not be joined to the last.
const STARTS_BLOCK = /^(\s*([-*+]\s|\d+[.)]\s|>|#{1,6}\s|\|)| {4}|\t)/;
const HEADING = /^\s*#{1,6}\s/;
// Two trailing spaces or a trailing backslash: a line break the author meant.
const HARD_BREAK = /( {2}|\\)$/;

/**
 * Undo the line wrapping Chat applies to Markdown.
 *
 * The Markdown form arrives wrapped at 80 columns. Those breaks are soft — a
 * Markdown renderer reads them as spaces — but this text is read as-is and
 * carried into other systems, where a break mid-sentence is just a defect.
 * Breaks that mean something are kept: blank lines between paragraphs, list
 * items, quotes, headings, hard breaks, and everything inside a code fence.
 */
export function unwrapSoftBreaks(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1];
    const standsAlone =
      inFence ||
      prev === undefined ||
      line.trim() === "" ||
      prev.trim() === "" ||
      STARTS_BLOCK.test(line) ||
      FENCE.test(prev) ||
      HEADING.test(prev) ||
      HARD_BREAK.test(prev);
    if (standsAlone) out.push(line);
    else out[out.length - 1] = `${prev.trimEnd()} ${line.trimStart()}`;
  }
  return out.join("\n").trimEnd();
}

/**
 * Cut text to `cap` characters without splitting a Markdown link: a cut that
 * would land inside `[text](url)` or an autolink `<https://…>` moves to the
 * end of that link instead. A truncated URL is a broken link, and the link is
 * usually the point.
 */
export function truncateKeepingLinks(text: string, cap: number = TEXT_CAP): string {
  if (text.length <= cap) return text;
  let cut = cap;
  const link = /\[[^\]]*\]\([^)\s]*\)|<https?:\/\/[^>\s]+>/g;
  for (let match = link.exec(text); match; match = link.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start >= cap) break;
    if (end > cap) {
      cut = end;
      break;
    }
  }
  if (cut >= text.length) return text;
  return `${text.slice(0, cut).trimEnd()}… (truncated, ${text.length} chars total)`;
}
