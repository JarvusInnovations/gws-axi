import { describe, expect, it } from "vitest";
import type { chat_v1 } from "googleapis";
import {
  check,
  cursorFromDate,
  EPOCH,
  matches,
  snapshotNow,
  toMicros,
  type MatchRules,
  type PollDeps,
} from "./poller.js";

type Message = chat_v1.Schema$Message;

/** A little Chat: conversations and their messages, with times in microseconds. */
class FakeChat implements PollDeps {
  messages: Message[] = [];
  private seq = 0;
  constructor(private readonly spaces: string[]) {}

  post(space: string, at: string, extra: Partial<Message> = {}): Message {
    const message = {
      name: `${space}/messages/m${++this.seq}`,
      space: { name: space },
      createTime: at,
      thread: { name: `${space}/threads/m${this.seq}` },
      sender: { name: "users/2", email: "bob@example.com" },
      ...extra,
    };
    this.messages.push(message);
    return message;
  }

  /** Posts made during the next listSpaces call — the race the window exists for. */
  duringNextList: Array<() => void> = [];

  async listSpaces(): Promise<chat_v1.Schema$Space[]> {
    const snapshot = this.spaces.map((name) => {
      const own = this.messages.filter((m) => m.space?.name === name);
      const last = own
        .map((m) => m.createTime as string)
        .sort()
        .at(-1);
      return { name, lastActiveTime: last };
    });
    for (const post of this.duringNextList.splice(0)) post();
    return snapshot;
  }

  async listMessages(space: string, after: string): Promise<Message[]> {
    return this.messages.filter(
      (m) => m.space?.name === space && toMicros(m.createTime as string) > toMicros(after),
    );
  }
}

const t = (seconds: number, micros = 0): string =>
  `2026-09-30T14:00:${String(seconds).padStart(2, "0")}.${String(micros).padStart(6, "0")}Z`;
const all = (): boolean => true;
const ids = (ms: Message[]): string[] => ms.map((m) => m.name?.split("/").pop() ?? "");

describe("timestamps", () => {
  it("compares at microsecond precision", () => {
    expect(toMicros(t(1, 255999)) - toMicros(t(1, 255998))).toBe(1n);
    expect(toMicros("2026-09-30T14:00:01Z")).toBe(toMicros(t(1, 0)));
    expect(toMicros("2026-09-30T14:00:01.25Z")).toBe(toMicros(t(1, 250000)));
  });

  it("turns a date into a cursor without losing its milliseconds", () => {
    expect(cursorFromDate(new Date("2026-09-30T14:00:01.255Z"))).toBe(t(1, 255000));
  });
});

describe("delivery", () => {
  it("starts from now: nothing already posted is delivered", async () => {
    const chat = new FakeChat(["spaces/A"]);
    chat.post("spaces/A", t(1));
    const start = await snapshotNow(chat);
    expect(start).toBe(t(1));
    expect((await check(chat, start, all)).messages).toEqual([]);
  });

  it("delivers each new message once, oldest first, across conversations", async () => {
    const chat = new FakeChat(["spaces/A", "spaces/B"]);
    let cursor = await snapshotNow(chat);
    chat.post("spaces/B", t(3));
    chat.post("spaces/A", t(2));
    const first = await check(chat, cursor, all);
    expect(ids(first.messages)).toEqual(["m2", "m1"]);
    cursor = first.snapshot;
    expect((await check(chat, cursor, all)).messages).toEqual([]);
  });

  it("holds a message posted during the check for the next one — no gap, no repeat", async () => {
    const chat = new FakeChat(["spaces/A", "spaces/B"]);
    let cursor = await snapshotNow(chat);
    chat.post("spaces/A", t(2));
    // Lands after the snapshot is taken but before messages are read.
    chat.duringNextList.push(() => chat.post("spaces/A", t(3)));
    const first = await check(chat, cursor, all);
    expect(ids(first.messages)).toEqual(["m1"]);
    cursor = first.snapshot;
    const second = await check(chat, cursor, all);
    expect(ids(second.messages)).toEqual(["m2"]);
  });

  it("resumes from a cursor exactly, even between messages a microsecond apart", async () => {
    const chat = new FakeChat(["spaces/A"]);
    chat.post("spaces/A", t(5, 1));
    chat.post("spaces/A", t(5, 2));
    const resumed = await check(chat, t(5, 1), all);
    expect(ids(resumed.messages)).toEqual(["m2"]);
  });

  it("reads only watched conversations, and only ones that moved", async () => {
    const chat = new FakeChat(["spaces/A", "spaces/B"]);
    const cursor = await snapshotNow(chat);
    chat.post("spaces/B", t(2));
    const listed: string[] = [];
    const spy: PollDeps = {
      listSpaces: () => chat.listSpaces(),
      listMessages: (space, after) => {
        listed.push(space);
        return chat.listMessages(space, after);
      },
    };
    const result = await check(spy, cursor, (s) => s.name === "spaces/A");
    expect(result.messages).toEqual([]);
    expect(listed).toEqual([]);
    // The snapshot still moves, so B's message isn't delivered later either.
    expect(result.snapshot).toBe(t(2));
  });

  it("starts at the epoch for an account with no conversations", async () => {
    expect(await snapshotNow(new FakeChat([]))).toBe(EPOCH);
  });
});

describe("matches", () => {
  const rules = (over: Partial<MatchRules> = {}): MatchRules => ({
    self: "users/1",
    account: "alice@example.com",
    includeMine: false,
    mentionsMe: false,
    ...over,
  });
  const from = (name: string, email: string, extra: Partial<Message> = {}): Message => ({
    sender: { name, email } as chat_v1.Schema$User,
    thread: { name: "spaces/A/threads/t1" },
    ...extra,
  });

  it("skips the account's own messages unless asked, by id or by address", () => {
    expect(matches(from("users/1", ""), rules())).toBe(false);
    expect(matches(from("users/9", "Alice@Example.com"), rules())).toBe(false);
    expect(matches(from("users/1", ""), rules({ includeMine: true }))).toBe(true);
    expect(matches(from("users/2", "bob@example.com"), rules())).toBe(true);
  });

  it("filters by thread and by sender address", () => {
    const m = from("users/2", "Bob@Example.com");
    expect(matches(m, rules({ thread: "spaces/A/threads/t1" }))).toBe(true);
    expect(matches(m, rules({ thread: "spaces/A/threads/t2" }))).toBe(false);
    expect(matches(m, rules({ from: "bob@example.com" }))).toBe(true);
    expect(matches(m, rules({ from: "carol@example.com" }))).toBe(false);
  });

  it("finds a mention of the account", () => {
    const mention = (name: string): Message =>
      from("users/2", "bob@example.com", {
        annotations: [{ type: "USER_MENTION", userMention: { user: { name } } }],
      });
    expect(matches(mention("users/1"), rules({ mentionsMe: true }))).toBe(true);
    expect(matches(mention("users/3"), rules({ mentionsMe: true }))).toBe(false);
    expect(matches(from("users/2", "bob@example.com"), rules({ mentionsMe: true }))).toBe(false);
  });
});
