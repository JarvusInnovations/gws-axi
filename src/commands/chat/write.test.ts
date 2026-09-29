import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { allApis } from "../../auth/scopes.js";
import { writeSetupHtml } from "../../auth/setup-html.js";
import { defaultSetupState, SETUP_STEP_ORDER } from "../../config.js";
import { isAlreadyRead, isAlreadyUnreadFrom, parseMarkUnreadFlags } from "./read-state.js";
import {
  appNotConfigured,
  MAX_BYTES,
  mayHavePosted,
  parseSendFlags,
  readBody,
  retryCommand,
  unconfirmedSend,
} from "./send.js";

function errorFrom(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AxiError);
    return err as AxiError;
  }
  throw new Error("expected a throw");
}

const newId = (): string => "generated-id";

describe("chat send flags", () => {
  it("takes a conversation and one body", () => {
    const flags = parseSendFlags(["AAAA", "--text", "hello"], newId);
    expect(flags.target).toEqual({ kind: "space", id: "AAAA" });
    expect(flags.body).toEqual({ kind: "text", text: "hello" });
  });

  it("reads a lone dash as stdin, not as a conversation", () => {
    const flags = parseSendFlags(["AAAA", "-"], newId);
    expect(flags.target).toEqual({ kind: "space", id: "AAAA" });
    expect(flags.body).toEqual({ kind: "stdin" });
  });

  it("refuses zero bodies and refuses several", () => {
    expect(errorFrom(() => parseSendFlags(["AAAA"], newId)).message).toContain("No message body");
    expect(
      errorFrom(() => parseSendFlags(["AAAA", "--text", "a", "--body-file", "f"], newId)).message,
    ).toContain("exactly one");
    expect(errorFrom(() => parseSendFlags(["AAAA", "-", "--text", "a"], newId)).message).toContain(
      "exactly one",
    );
  });

  it("refuses more than one conversation — there is no broadcast", () => {
    const err = errorFrom(() => parseSendFlags(["AAAA", "BBBB", "--text", "a"], newId));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("one conversation");
  });

  it("generates a request id when none is given, and keeps the caller's when one is", () => {
    expect(parseSendFlags(["AAAA", "--text", "a"], newId)).toMatchObject({
      requestId: "generated-id",
      requestIdGiven: false,
    });
    expect(
      parseSendFlags(["AAAA", "--text", "a", "--request-id", "deploy-4821"], newId),
    ).toMatchObject({ requestId: "deploy-4821", requestIdGiven: true });
  });

  it.each(["Deploy-1", "has space", "under_score", "x".repeat(57), ""])(
    "refuses the request id %j",
    (id) => {
      const err = errorFrom(() =>
        parseSendFlags(["AAAA", "--text", "a", "--request-id", id], newId),
      );
      expect(err.code).toBe("VALIDATION_ERROR");
    },
  );

  it("accepts a generated UUID as a request id", () => {
    const uuid = "3f2b1c9e-7a4d-4e8b-9c1a-5d6e7f8a9b0c";
    expect(parseSendFlags(["AAAA", "--text", "a", "--request-id", uuid], newId).requestId).toBe(
      uuid,
    );
  });

  it("takes --with in place of a conversation, and refuses both", () => {
    expect(parseSendFlags(["--with", "bob@example.com", "--text", "a"], newId).target).toEqual({
      kind: "dm",
      email: "bob@example.com",
    });
    expect(
      errorFrom(() => parseSendFlags(["AAAA", "--with", "bob@example.com", "--text", "a"], newId))
        .message,
    ).toContain("not both");
  });

  it("refuses an unknown flag rather than sending without it", () => {
    expect(
      errorFrom(() => parseSendFlags(["AAAA", "--text", "a", "--silent"], newId)).message,
    ).toContain("--silent");
  });
});

describe("readBody", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gws-axi-send-"));
  });
  afterEach(() => undefined);

  it("reads inline text, a file, and stdin", () => {
    const path = join(dir, "msg.md");
    writeFileSync(path, "from a file");
    expect(readBody({ kind: "text", text: "inline" })).toBe("inline");
    expect(readBody({ kind: "file", path })).toBe("from a file");
    expect(readBody({ kind: "stdin" }, () => "from stdin")).toBe("from stdin");
  });

  it("refuses an empty or whitespace-only body", () => {
    expect(errorFrom(() => readBody({ kind: "text", text: "  \n " })).code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("refuses an unreadable file", () => {
    expect(
      errorFrom(() => readBody({ kind: "file", path: join(dir, "missing.md") })).message,
    ).toContain("Cannot read --body-file");
  });

  it("allows exactly the limit and refuses one byte more", () => {
    expect(readBody({ kind: "text", text: "x".repeat(MAX_BYTES) })).toHaveLength(MAX_BYTES);
    const err = errorFrom(() => readBody({ kind: "text", text: "x".repeat(MAX_BYTES + 1) }));
    expect(err.code).toBe("MESSAGE_TOO_LARGE");
    expect(err.message).toContain(String(MAX_BYTES + 1));
  });

  it("measures bytes, not characters", () => {
    // 10,667 three-byte characters is 32,001 bytes but far fewer characters.
    const err = errorFrom(() => readBody({ kind: "text", text: "€".repeat(10_667) }));
    expect(err.code).toBe("MESSAGE_TOO_LARGE");
  });
});

describe("a send that may or may not have happened", () => {
  const refused = (code: number): unknown => ({
    response: { status: code, data: { error: { code, message: "no" } } },
  });

  it("treats no answer and a server error as unknown", () => {
    expect(mayHavePosted(new Error("socket hang up"))).toBe(true);
    expect(mayHavePosted({ code: "ETIMEDOUT", message: "timeout" })).toBe(true);
    expect(mayHavePosted(refused(500))).toBe(true);
    expect(mayHavePosted(refused(503))).toBe(true);
  });

  it("treats a refusal as certain: nothing was posted", () => {
    for (const code of [400, 403, 404, 409, 429]) expect(mayHavePosted(refused(code))).toBe(false);
  });

  it("leads with a retry that carries the same request id", () => {
    const err = unconfirmedSend(new Error("socket hang up"), {
      args: ["AAAA", "--text", "it's done"],
      requestId: "generated-id",
      account: "alice@example.com",
      spaceId: "AAAA",
    });
    expect(err.code).toBe("SEND_UNCONFIRMED");
    expect(err.suggestions[0]).toContain("cannot post a duplicate");
    expect(err.suggestions[0]).toContain("--request-id generated-id");
    expect(err.suggestions[0]).toContain("--account alice@example.com");
  });

  it("rebuilds the command with its arguments quoted for a shell", () => {
    expect(retryCommand(["AAAA", "--text", "it's done"], "id-1", "a@b.co")).toBe(
      "gws-axi chat send AAAA --text 'it'\\''s done' --request-id id-1 --account a@b.co",
    );
  });

  it("replaces a request id the caller passed rather than repeating the flag", () => {
    const out = retryCommand(["AAAA", "--request-id", "old", "--text", "x"], "old", "a@b.co");
    expect(out.match(/--request-id/g)).toHaveLength(1);
  });
});

describe("read state", () => {
  const T1 = "2026-09-29T05:43:55.000Z";
  const T2 = "2026-09-29T05:44:25.000Z";

  it("is already read at or past the newest message, and in an empty conversation", () => {
    expect(isAlreadyRead(T2, T2)).toBe(true);
    expect(isAlreadyRead(T2, T1)).toBe(true);
    expect(isAlreadyRead(T1, T2)).toBe(false);
    expect(isAlreadyRead(undefined, T2)).toBe(false);
    expect(isAlreadyRead(T1, undefined)).toBe(true);
  });

  it("changes nothing when the point asked for is not earlier than the read position", () => {
    expect(isAlreadyUnreadFrom(T1, T2)).toBe(true);
    expect(isAlreadyUnreadFrom(T1, T1)).toBe(true);
    expect(isAlreadyUnreadFrom(T2, T1)).toBe(false);
  });

  it("requires exactly one of --from and --at, with no default point", () => {
    const none = errorFrom(() => parseMarkUnreadFlags(["AAAA"]));
    expect(none.code).toBe("VALIDATION_ERROR");
    expect(none.suggestions.join(" ")).toContain("no default point");
    expect(
      errorFrom(() => parseMarkUnreadFlags(["AAAA", "--from", "m", "--at", "2026-01-01"])).message,
    ).toContain("not both");
  });

  it("takes a message as a bare id or a resource name", () => {
    expect(parseMarkUnreadFlags(["AAAA", "--from", "Hk2.Hk2"]).from).toBe("Hk2.Hk2");
    expect(parseMarkUnreadFlags(["AAAA", "--from", "spaces/AAAA/messages/Hk2.Hk2"]).from).toBe(
      "Hk2.Hk2",
    );
  });

  it("takes one conversation", () => {
    expect(errorFrom(() => parseMarkUnreadFlags(["AAAA", "BBBB", "--from", "m"])).code).toBe(
      "VALIDATION_ERROR",
    );
  });
});

describe("Chat app configuration guidance", () => {
  let configHome: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), "gws-axi-chatapp-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  });

  /** A finished setup, owned or adopted through `auth join`. */
  function writeSetup(joined: boolean): void {
    const state = defaultSetupState();
    for (const key of SETUP_STEP_ORDER) {
      state.steps[key] =
        joined && key !== "tokens_obtained" ? { done: true, via: "team-join" } : { done: true };
    }
    state.steps.gcp_project.project_id = "my-project";
    // An owned step records what it enabled; without the list it reads as stale.
    if (!joined) state.steps.apis_enabled.apis = allApis();
    const dir = join(configHome, "gws-axi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "setup.json"), JSON.stringify(state));
  }

  it("sends an owner to the Console page, and warns that the name is public", () => {
    writeSetup(false);
    const err = appNotConfigured("alice@example.com");
    const text = err.suggestions.join(" ");
    expect(err.code).toBe("CHAT_APP_NOT_CONFIGURED");
    expect(text).toContain("Configuration");
    expect(text).toContain("shown beside every message");
    expect(text).toContain("Reading is unaffected");
  });

  it("sends a joined teammate to the distributor, never to the Console", () => {
    writeSetup(true);
    const text = appNotConfigured("alice@example.com").suggestions.join(" ");
    expect(text).toContain("distributed your gws-axi credentials");
    expect(text).not.toContain("Cloud Console for your");
    expect(text).not.toContain("console.cloud.google.com");
  });

  it("offers the setup page's Chat section to an owner only", () => {
    writeSetup(false);
    const owned = readFileSync(writeSetupHtml(), "utf-8");
    expect(owned).toContain("Optional: enable Chat sending");
    expect(owned).toContain("chat.googleapis.com/hangouts-chat?project=my-project");

    writeSetup(true);
    const joined = readFileSync(writeSetupHtml(), "utf-8");
    expect(joined).not.toContain("enable Chat sending");
    expect(joined).not.toContain("hangouts-chat");
  });
});
