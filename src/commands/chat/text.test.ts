import { describe, expect, it } from "vitest";
import {
  mentionedUsers,
  renderMessageText,
  truncateKeepingLinks,
  unwrapSoftBreaks,
} from "./text.js";

const label = (user: { name?: string | null; displayName?: string | null }): string =>
  user.displayName ?? user.name ?? "";

const TAG = (id: string): string => `<chat-user data-user="users/${id}"></chat-user>`;

describe("renderMessageText", () => {
  it("returns Markdown untouched when there are no mentions", () => {
    const text = "See [the run](https://example.com/run) for details";
    expect(renderMessageText({ formattedText: text }, label)).toBe(text);
  });

  it("replaces a mention tag with what the message shows for it", () => {
    const message = {
      text: "@Bob Tran can you look?",
      formattedText: `${TAG("1")} can you look?`,
      annotations: [
        {
          type: "USER_MENTION",
          startIndex: 0,
          length: 9,
          userMention: { user: { name: "users/1", displayName: "Bob Tran" } },
        },
      ],
    };
    expect(renderMessageText(message, label)).toBe("@Bob Tran can you look?");
  });

  it("matches several mentions in order, including the same person twice", () => {
    const message = {
      text: "@Bob Tran and @Carol Wu — @Bob Tran first",
      formattedText: `${TAG("1")} and ${TAG("2")} — ${TAG("1")} first`,
      annotations: [
        {
          type: "USER_MENTION",
          startIndex: 0,
          length: 9,
          userMention: { user: { name: "users/1" } },
        },
        {
          type: "USER_MENTION",
          startIndex: 14,
          length: 9,
          userMention: { user: { name: "users/2" } },
        },
        {
          type: "USER_MENTION",
          startIndex: 26,
          length: 9,
          userMention: { user: { name: "users/1" } },
        },
      ],
    };
    expect(renderMessageText(message, label)).toBe("@Bob Tran and @Carol Wu — @Bob Tran first");
  });

  it("falls back to the label, then the id, when no annotation covers a tag", () => {
    expect(renderMessageText({ formattedText: `${TAG("7")} hi` }, () => "")).toBe("@users/7 hi");
    expect(renderMessageText({ formattedText: `${TAG("7")} hi` }, () => "Dee")).toBe("@Dee hi");
  });

  it("renders a mention of everyone as @all", () => {
    const text = '<chat-user data-user="users/all"></chat-user> heads up';
    expect(renderMessageText({ formattedText: text }, label)).toBe("@all heads up");
  });

  it("uses the plain text when there is no formatted text", () => {
    expect(renderMessageText({ text: "plain" }, label)).toBe("plain");
  });
});

describe("mentionedUsers", () => {
  it("returns the users behind mention annotations only", () => {
    const users = mentionedUsers({
      text: "@Bob see https://x.test",
      annotations: [
        {
          type: "USER_MENTION",
          startIndex: 0,
          length: 4,
          userMention: { user: { name: "users/1" } },
        },
        { type: "RICH_LINK", startIndex: 9, length: 14 },
      ],
    });
    expect(users).toEqual([{ name: "users/1" }]);
  });
});

describe("unwrapSoftBreaks", () => {
  it("joins a sentence upstream wrapped at 80 columns", () => {
    expect(unwrapSoftBreaks("I have invited both of you to a new\nchat. Please join.\n")).toBe(
      "I have invited both of you to a new chat. Please join.",
    );
  });

  it("keeps paragraph gaps", () => {
    expect(unwrapSoftBreaks("First line\nstill first.\n\nSecond para.")).toBe(
      "First line still first.\n\nSecond para.",
    );
  });

  it("keeps list items apart, and joins a wrapped item to itself", () => {
    expect(unwrapSoftBreaks("- one that is long\n  and wraps\n- two\n1. three\n2) four")).toBe(
      "- one that is long and wraps\n- two\n1. three\n2) four",
    );
  });

  it("keeps quotes and headings on their own lines", () => {
    expect(unwrapSoftBreaks("# Title\nbody text\n> quoted\nafter")).toBe(
      "# Title\nbody text\n> quoted after",
    );
  });

  it("leaves everything inside a code fence exactly as it was", () => {
    const code = "before\n```\nline one\n  line two\n```\nafter";
    expect(unwrapSoftBreaks(code)).toBe(code);
  });

  it("keeps a break the author marked as hard", () => {
    expect(unwrapSoftBreaks("line one  \nline two")).toBe("line one  \nline two");
    expect(unwrapSoftBreaks("line one\\\nline two")).toBe("line one\\\nline two");
  });

  it("leaves Markdown escapes alone", () => {
    expect(unwrapSoftBreaks("Please join\\! Item \\#4")).toBe("Please join\\! Item \\#4");
  });
});

describe("truncateKeepingLinks", () => {
  it("returns short text as it is", () => {
    expect(truncateKeepingLinks("short", 500)).toBe("short");
  });

  it("cuts long text at the cap and reports the full length", () => {
    const text = "x".repeat(600);
    const out = truncateKeepingLinks(text, 500);
    expect(out.startsWith("x".repeat(500))).toBe(true);
    expect(out).toContain("… (truncated, 600 chars total)");
  });

  it("moves the cut to the end of a link it would have split", () => {
    const link = "[the run](https://example.com/a/very/long/path)";
    const text = `${"x".repeat(490)} ${link} ${"Z".repeat(200)}`;
    const out = truncateKeepingLinks(text, 500);
    expect(out).toContain(link);
    expect(out).not.toContain("Z");
  });

  it("keeps an autolink whole too", () => {
    const link = "<https://example.com/a/long/path/to/something>";
    const out = truncateKeepingLinks(`${"x".repeat(490)} ${link} ${"Z".repeat(200)}`, 500);
    expect(out).toContain(link);
    expect(out).not.toContain("Z");
  });

  it("does not extend for a link that starts after the cap", () => {
    const text = `${"x".repeat(520)} [late](https://example.com)`;
    expect(truncateKeepingLinks(text, 500)).not.toContain("[late]");
  });
});
