import { describe, expect, it } from "vitest";
import { expandMentions, mentionTag, nonMembers } from "./mentions.js";

const tag = mentionTag;

describe("expandMentions", () => {
  it("turns @ + an address into a mention", () => {
    const out = expandMentions("@bob@example.com can you look?");
    expect(out.body).toBe(`${tag("bob@example.com")} can you look?`);
    expect(out.emails).toEqual(["bob@example.com"]);
  });

  it("works mid-sentence and after punctuation, keeping trailing punctuation", () => {
    expect(expandMentions("thanks @bob@example.com, and (@carol@example.org).").body).toBe(
      `thanks ${tag("bob@example.com")}, and (${tag("carol@example.org")}).`,
    );
  });

  it("leaves a bare address alone", () => {
    const out = expandMentions("mail bob@example.com instead");
    expect(out.body).toBe("mail bob@example.com instead");
    expect(out.emails).toEqual([]);
  });

  it("leaves an @ that follows a word character alone", () => {
    expect(expandMentions("foo@bob@example.com").body).toBe("foo@bob@example.com");
  });

  it("treats \\@ as a literal", () => {
    const out = expandMentions("write to \\@bob@example.com");
    expect(out.body).toBe("write to \\@bob@example.com");
    expect(out.emails).toEqual([]);
  });

  it("leaves inline code and fenced code alone", () => {
    const body =
      "run `notify @bob@example.com`\n```\n@carol@example.org\n```\nthen @dee@example.net";
    const out = expandMentions(body);
    expect(out.body).toBe(
      `run \`notify @bob@example.com\`\n\`\`\`\n@carol@example.org\n\`\`\`\nthen ${tag("dee@example.net")}`,
    );
    expect(out.emails).toEqual(["dee@example.net"]);
  });

  it("does not treat @name as a mention", () => {
    expect(expandMentions("@bob can you look?").emails).toEqual([]);
  });

  it("collects hand-written tags too, by address and by id, once each", () => {
    const body =
      '<chat-user data-email="Bob@Example.com"></chat-user> and <chat-user data-user="users/42"></chat-user> and @bob@example.com';
    const out = expandMentions(body);
    expect(out.emails).toEqual(["bob@example.com"]);
    expect(out.userIds).toEqual(["users/42"]);
  });

  it("ignores users/all, which isn't a person", () => {
    expect(expandMentions('<chat-user data-user="users/all"></chat-user> hi').userIds).toEqual([]);
  });
});

describe("nonMembers", () => {
  const members = [
    { name: "users/1", email: "Bob@Example.com" },
    { name: "users/2", email: "carol@example.org" },
  ];

  it("passes members, matching addresses without regard to case", () => {
    expect(nonMembers({ emails: ["bob@example.com"], userIds: ["users/2"] }, members)).toEqual([]);
  });

  it("names every mention that isn't a member", () => {
    expect(
      nonMembers(
        { emails: ["bob@example.com", "typo@example.com"], userIds: ["users/9"] },
        members,
      ),
    ).toEqual(["typo@example.com", "users/9"]);
  });
});
