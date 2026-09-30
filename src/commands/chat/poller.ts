import type { chat_v1 } from "googleapis";

/**
 * Finding new Chat messages by polling, delivering each exactly once.
 *
 * Every check makes one `spaces.list` call. The largest `lastActiveTime` in it
 * is the *snapshot* — in message-time terms, "now". A check reads messages
 * only from watched conversations that moved past the previous snapshot, and
 * delivers those in (previous snapshot, current snapshot]. A message posted
 * after the `spaces.list` call falls outside that window and belongs to the
 * next check. So nothing is skipped or repeated, across checks or across runs
 * resumed from a cursor, and the local clock is never consulted.
 *
 * Pure over injected calls, so every rule is testable without Chat.
 * See specs/commands/chat-watch.md § How new messages are found.
 */

type Space = chat_v1.Schema$Space;
type Message = chat_v1.Schema$Message;

/** Before any possible message: the snapshot of an account with no conversations. */
export const EPOCH = "1970-01-01T00:00:00.000000Z";

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * A Chat timestamp as microseconds since the epoch. Compared as integers —
 * never through `Date`, which would drop the microseconds that distinguish two
 * messages in the same millisecond.
 */
export function toMicros(timestamp: string): bigint {
  const match = TIMESTAMP.exec(timestamp);
  if (!match) throw new Error(`Not a Chat timestamp: ${timestamp}`);
  const seconds = BigInt(Date.parse(`${match[1]}Z`) / 1000);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0").slice(0, 6));
  return seconds * 1_000_000n + fraction;
}

export const isTimestamp = (value: string): boolean => TIMESTAMP.test(value);

/** A JS date as a cursor, in Chat's microsecond form. */
export function cursorFromDate(date: Date): string {
  return date.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

export interface PollDeps {
  /** Every conversation the account is in, with `lastActiveTime`. */
  listSpaces: () => Promise<Space[]>;
  /** A conversation's messages created strictly after `after`, any order. */
  listMessages: (spaceName: string, after: string) => Promise<Message[]>;
}

export interface CheckResult {
  snapshot: string;
  /** New messages in watched conversations, oldest first. */
  messages: Message[];
}

function later(a: string, b: string | null | undefined): string {
  if (!b) return a;
  return toMicros(b) > toMicros(a) ? b : a;
}

/** The current snapshot, with no messages read — where a fresh run starts. */
export async function snapshotNow(deps: PollDeps): Promise<string> {
  const spaces = await deps.listSpaces();
  return spaces.reduce((max, s) => later(max, s.lastActiveTime), EPOCH);
}

/** One check: everything new in watched conversations since `previous`. */
export async function check(
  deps: PollDeps,
  previous: string,
  watched: (space: Space) => boolean,
): Promise<CheckResult> {
  const spaces = await deps.listSpaces();
  const snapshot = spaces.reduce((max, s) => later(max, s.lastActiveTime), previous);
  const prev = toMicros(previous);
  const upTo = toMicros(snapshot);

  const moved = spaces.filter(
    (s) => watched(s) && s.lastActiveTime && toMicros(s.lastActiveTime) > prev,
  );
  const messages: Message[] = [];
  for (const space of moved) {
    for (const message of await deps.listMessages(space.name ?? "", previous)) {
      const created = message.createTime ? toMicros(message.createTime) : undefined;
      // Only this window: later ones belong to the next check.
      if (created !== undefined && created > prev && created <= upTo) messages.push(message);
    }
  }
  messages.sort((a, b) => {
    const x = toMicros(a.createTime ?? EPOCH);
    const y = toMicros(b.createTime ?? EPOCH);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { snapshot, messages };
}

export interface MatchRules {
  /** The account's own `users/{id}`, when known. */
  self?: string;
  account: string;
  includeMine: boolean;
  /** Full thread resource name. */
  thread?: string;
  /** Lowercased sender address. */
  from?: string;
  mentionsMe: boolean;
}

export function matches(message: Message, rules: MatchRules): boolean {
  const sender = message.sender as (chat_v1.Schema$User & { email?: string | null }) | undefined;
  const isMine =
    (rules.self !== undefined && sender?.name === rules.self) ||
    sender?.email?.toLowerCase() === rules.account.toLowerCase();
  if (isMine && !rules.includeMine) return false;
  if (rules.thread && message.thread?.name !== rules.thread) return false;
  if (rules.from && sender?.email?.toLowerCase() !== rules.from) return false;
  if (rules.mentionsMe) {
    const mentioned = (message.annotations ?? []).some(
      (a) =>
        a.type === "USER_MENTION" &&
        ((rules.self !== undefined && a.userMention?.user?.name === rules.self) ||
          (a.userMention?.user as { email?: string } | undefined)?.email?.toLowerCase() ===
            rules.account.toLowerCase()),
    );
    if (!mentioned) return false;
  }
  return true;
}
