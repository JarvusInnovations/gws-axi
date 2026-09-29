import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { toMemberRow } from "./members.js";
import { IdentityLedger } from "./identity.js";
import { attachmentRows, messageSchema, threadsCarryInformation, toRow } from "./message-rows.js";
import { buildListFilter, parseMessagesFlags, rangeEcho } from "./messages.js";
import { buildSearchFilter, parseSearchFlags } from "./search.js";
import { byLastActive, parseSpacesFlags } from "./spaces.js";
import { chatError, kindOf } from "./shared.js";

// A fixed "now" keeps range tokens deterministic; assertions that name local
// boundaries assume the repo's America/New_York zone, as dateish.test.ts does.
const NOW = new Date("2026-09-29T15:00:00-04:00");

function errorFrom(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AxiError);
    return err as AxiError;
  }
  throw new Error("expected a throw");
}

describe("chat messages flags", () => {
  it("expands a day on each edge, so --since D --until D is all of D", () => {
    const flags = parseMessagesFlags(
      ["AAAA", "--since", "2026-09-25", "--until", "2026-09-25"],
      NOW,
    );
    expect(rangeEcho(flags.since, flags.until)).toBe(
      "2026-09-25T00:00:00-04:00 → 2026-09-26T00:00:00-04:00",
    );
  });

  it("refuses an empty window instead of returning an empty list", () => {
    const err = errorFrom(() =>
      parseMessagesFlags(["AAAA", "--since", "2026-09-26", "--until", "2026-09-25"], NOW),
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("--since");
    expect(err.message).toContain("--until");
  });

  it("takes a thread as a bare id or a resource name", () => {
    expect(parseMessagesFlags(["AAAA", "--thread", "t8Q"], NOW).thread).toBe("t8Q");
    expect(parseMessagesFlags(["AAAA", "--thread", "spaces/AAAA/threads/t8Q"], NOW).thread).toBe(
      "t8Q",
    );
  });

  it("refuses two conversations", () => {
    expect(errorFrom(() => parseMessagesFlags(["AAAA", "BBBB"], NOW)).code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("refuses an unknown field", () => {
    expect(
      errorFrom(() => parseMessagesFlags(["AAAA", "--fields", "color"], NOW)).message,
    ).toContain("color");
  });
});

describe("buildListFilter", () => {
  it("is absent when nothing narrows the read", () => {
    expect(buildListFilter("spaces/AAAA", {})).toBeUndefined();
  });

  it("sends an inclusive lower edge as strictly-after the millisecond before", () => {
    const filter = buildListFilter("spaces/AAAA", { since: "2026-09-25T04:00:00.000Z" });
    expect(filter).toBe('createTime > "2026-09-25T03:59:59.999Z"');
  });

  it("combines a window and a thread", () => {
    expect(
      buildListFilter("spaces/AAAA", {
        since: "2026-09-25T04:00:00.000Z",
        until: "2026-09-26T04:00:00.000Z",
        thread: "t8Q",
      }),
    ).toBe(
      'createTime > "2026-09-25T03:59:59.999Z" AND createTime < "2026-09-26T04:00:00.000Z" AND thread.name = spaces/AAAA/threads/t8Q',
    );
  });
});

describe("chat search", () => {
  it("requires a keyword or a filter, and names the browsing commands", () => {
    const err = errorFrom(() => parseSearchFlags([], NOW));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.suggestions.join(" ")).toContain("chat spaces");
  });

  it("accepts a filter with no keyword", () => {
    expect(parseSearchFlags(["--unread"], NOW).unread).toBe(true);
  });

  it("uses the field names the API accepts, not the ones it documents", () => {
    const flags = parseSearchFlags(
      ["budget", "--from", "Bob@Example.com", "--space", "spaces/AAAA", "--since", "2026-09-25"],
      NOW,
    );
    expect(buildSearchFilter(flags)).toBe(
      'budget AND space.name = "spaces/AAAA" AND sender.name = "users/bob@example.com" AND create_time >= "2026-09-25T04:00:00.000Z"',
    );
  });

  it("quotes a phrase and leaves a single word bare", () => {
    expect(buildSearchFilter(parseSearchFlags(["status update"], NOW))).toBe('"status update"');
    expect(buildSearchFilter(parseSearchFlags(["status", "update"], NOW))).toBe(
      "status AND update",
    );
  });

  it("maps every boolean filter", () => {
    const flags = parseSearchFlags(
      ["--unread", "--mentions-me", "--has-link", "--has-attachment", "--type", "dm"],
      NOW,
    );
    expect(buildSearchFilter(flags)).toBe(
      'space.space_type = "DIRECT_MESSAGE" AND is_unread() AND annotations.user_mentions.user.name:users/me AND has_link() AND attachment:*',
    );
  });

  it("refuses a sender that is not an address", () => {
    expect(errorFrom(() => parseSearchFlags(["x", "--from", "Bob Tran"], NOW)).code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("caps the limit at the API's ceiling", () => {
    expect(parseSearchFlags(["x", "--limit", "500"], NOW).limit).toBe(100);
  });
});

describe("chat spaces", () => {
  it("sorts most recently active first, with the never-active last", () => {
    const spaces = [
      { name: "spaces/a", lastActiveTime: "2026-01-01T00:00:00Z" },
      { name: "spaces/b" },
      { name: "spaces/c", lastActiveTime: "2026-09-01T00:00:00Z" },
    ];
    expect(spaces.sort(byLastActive).map((s) => s.name)).toEqual([
      "spaces/c",
      "spaces/a",
      "spaces/b",
    ]);
  });

  it("refuses a positional, pointing at the command that takes one", () => {
    const err = errorFrom(() => parseSpacesFlags(["AAAA"]));
    expect(err.suggestions.join(" ")).toContain("chat messages <space>");
  });

  it("maps conversation types, and admits when Chat gave none", () => {
    expect(kindOf({ spaceType: "DIRECT_MESSAGE" })).toBe("dm");
    expect(kindOf({ spaceType: "GROUP_CHAT" })).toBe("group");
    expect(kindOf({ spaceType: "SPACE" })).toBe("space");
    expect(kindOf({})).toBe("unknown");
  });
});

describe("thread column", () => {
  const message = (id: string, thread: string, reply = false) => ({
    name: `spaces/AAAA/messages/${id}`,
    thread: { name: `spaces/AAAA/threads/${thread}` },
    threadReply: reply,
  });

  it("is omitted when every message is its own thread", () => {
    expect(threadsCarryInformation([message("1", "a"), message("2", "b")])).toBe(false);
  });

  it("appears when messages share a thread, or one is a reply", () => {
    expect(threadsCarryInformation([message("1", "a"), message("2", "a")])).toBe(true);
    expect(threadsCarryInformation([message("1", "a", true)])).toBe(true);
  });

  it("can be asked for regardless", () => {
    const names = (fields: Parameters<typeof messageSchema>[0]["fields"]): string[] =>
      messageSchema({ withSpace: false, withThread: false, fields }).map((f) => f.name);
    expect(names([])).toEqual(["id", "time", "sender", "text"]);
    expect(names(["thread"])).toEqual(["id", "time", "sender", "thread", "text"]);
    expect(names(["reactions", "attachments"])).toEqual([
      "id",
      "time",
      "sender",
      "attachments",
      "reactions",
      "text",
    ]);
  });
});

describe("message rows", () => {
  const ledger = new IdentityLedger();
  const sender = { name: "users/1", displayName: "Bob Tran", type: "HUMAN" };
  ledger.add(sender);

  it("keeps ids whole and counts what it does not show", () => {
    const row = toRow(
      {
        name: "spaces/AAAA/messages/Hk2.Hk2",
        space: { name: "spaces/AAAA" },
        thread: { name: "spaces/AAAA/threads/t8Q" },
        sender,
        createTime: "2026-09-25T17:24:15.000Z",
        formattedText: "hello",
        attachment: [{ contentName: "a.pdf" }, { contentName: "b.pdf" }],
        emojiReactionSummaries: [{ reactionCount: 2 }, { reactionCount: 1 }],
      },
      ledger,
      { full: false },
    );
    expect(row).toMatchObject({
      space: "AAAA",
      id: "Hk2.Hk2",
      thread: "t8Q",
      sender: "Bob Tran",
      text: "hello",
      attachments: 2,
      reactions: 3,
      time: "2026-09-25T13:24:15-04:00",
    });
  });

  it("truncates unless asked not to", () => {
    const long = { name: "spaces/A/messages/m", sender, formattedText: "x".repeat(700) };
    expect(toRow(long, ledger, { full: false }).text).toContain("truncated, 700 chars total");
    expect(toRow(long, ledger, { full: true }).text).toHaveLength(700);
  });

  it("separates Drive attachments, which have an id to follow, from uploads", () => {
    const rows = attachmentRows([
      {
        name: "spaces/A/messages/m1",
        attachment: [
          {
            contentName: "Plan",
            contentType: "application/vnd.google-apps.document",
            source: "DRIVE_FILE",
            driveDataRef: { driveFileId: "1AbC" },
          },
          { contentName: "scan.pdf", contentType: "application/pdf", source: "UPLOADED_CONTENT" },
        ],
      },
    ]);
    expect(rows).toEqual([
      {
        message: "m1",
        name: "Plan",
        type: "application/vnd.google-apps.document",
        source: "drive",
        drive_file: "1AbC",
      },
      {
        message: "m1",
        name: "scan.pdf",
        type: "application/pdf",
        source: "upload",
        drive_file: "",
      },
    ]);
  });
});

describe("member rows", () => {
  it("renders a person, a group, and the labels for role and state", () => {
    const ledger = new IdentityLedger();
    const user = {
      name: "users/1",
      displayName: "Bob Tran",
      email: "bob@example.com",
      type: "HUMAN",
    };
    ledger.add(user);
    expect(toMemberRow({ member: user, role: "ROLE_MANAGER", state: "JOINED" }, ledger)).toEqual({
      id: "users/1",
      name: "Bob Tran",
      email: "bob@example.com",
      type: "human",
      role: "manager",
      state: "joined",
    });
    expect(
      toMemberRow(
        { groupMember: { name: "groups/77" }, role: "ROLE_MEMBER", state: "INVITED" },
        ledger,
      ),
    ).toMatchObject({ id: "groups/77", type: "group", role: "member", state: "invited" });
  });

  it("leaves the name empty, not invented, for someone nobody could name", () => {
    const ledger = new IdentityLedger();
    const user = { name: "users/2", type: "HUMAN" };
    ledger.add(user);
    expect(toMemberRow({ member: user, role: "ROLE_MEMBER" }, ledger)).toMatchObject({
      id: "users/2",
      name: "",
      email: "",
    });
  });
});

describe("chatError", () => {
  const ctx = { account: "alice@example.com", operation: "chat.spaces.messages.list" };
  const api = (code: number, message: string): unknown => ({
    response: { status: code, data: { error: { code, message } } },
  });

  it("calls a missing or malformed conversation SPACE_NOT_FOUND", () => {
    const malformed = api(400, "Missing or malformed space resource name in the request.");
    for (const err of [malformed, api(404, "Not found"), api(403, "Permission denied")]) {
      const out = chatError(err, { ...ctx, space: "AAAA" });
      expect(out.code).toBe("SPACE_NOT_FOUND");
      expect(out.suggestions[0]).toContain("chat spaces --name");
    }
  });

  it("calls a missing thread THREAD_NOT_FOUND", () => {
    const err = api(400, "Missing or malformed thread resource name in the filter query.");
    expect(chatError(err, { ...ctx, space: "AAAA", thread: "t8Q" }).code).toBe("THREAD_NOT_FOUND");
  });

  it("does not mistake a scope or API problem for a missing conversation", () => {
    const scope = api(403, "Request had insufficient authentication scopes.");
    const disabled = api(
      403,
      "Google Chat API has not been used in project 1 before or it is disabled.",
    );
    expect(chatError(scope, { ...ctx, space: "AAAA" }).code).toBe("SCOPE_MISSING");
    expect(chatError(disabled, { ...ctx, space: "AAAA" }).code).toBe("API_NOT_ENABLED");
  });

  it("passes an AxiError through unchanged", () => {
    const original = new AxiError("x", "DM_NOT_FOUND", []);
    expect(chatError(original, ctx)).toBe(original);
  });
});
