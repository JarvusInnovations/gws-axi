import { AxiError } from "axi-sdk-js";

/**
 * How every chat command names a conversation.
 *
 * A conversation is addressed by id — `spaces/AAAA`, the bare `AAAA`, or a Chat
 * URL containing it — or, for a 1:1 direct message, by the other person's email
 * via `--with`. Never by display name: names aren't unique and direct messages
 * have none. See specs/commands/chat-read.md § Addressing a conversation.
 */

export type SpaceTarget =
  | { kind: "space"; id: string }
  /** The 1:1 direct message with this person, resolved by the caller. */
  | { kind: "dm"; email: string };

const ID = /^[A-Za-z0-9_-]+$/;
// Chat's web URLs put the id after one of these path segments, in the path or
// the fragment: chat.google.com/room/<id>, mail.google.com/chat/u/0/#chat/space/<id>.
const URL_ID = /\/(?:space|room|dm)\/([A-Za-z0-9_-]+)/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LOOKUP = "Run `gws-axi chat spaces --name <text>` to find a conversation's id";

/** Reduce any accepted spelling of a conversation to its bare id. */
export function parseSpaceId(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new AxiError("Missing conversation id", "VALIDATION_ERROR", [LOOKUP]);
  }

  if (/^https?:\/\//i.test(value)) {
    const match = URL_ID.exec(value);
    if (match) return match[1];
    throw new AxiError(`No conversation id found in URL: ${value}`, "VALIDATION_ERROR", [
      "Pass the id itself (the part of a Chat URL after /space/, /room/ or /dm/)",
      LOOKUP,
    ]);
  }

  const bare = value.startsWith("spaces/") ? value.slice("spaces/".length) : value;
  if (ID.test(bare)) return bare;

  // The likeliest mistake is passing a name; say why that can't work rather
  // than reporting a malformed id.
  throw new AxiError(`Not a conversation id: ${value}`, "VALIDATION_ERROR", [
    "Conversations are addressed by id, not by name — names aren't unique and direct messages have none",
    LOOKUP,
    "For the 1:1 direct message with someone, pass `--with <email>` instead",
  ]);
}

/** The API resource name for a conversation id. */
export function spaceResourceName(id: string): string {
  return `spaces/${id}`;
}

/**
 * Resolve a command's destination from its positional and `--with`, exactly one
 * of which must be present.
 */
export function resolveSpaceTarget(
  input: { positional?: string; withEmail?: string },
  usage: string,
): SpaceTarget {
  const { positional, withEmail } = input;
  if (positional !== undefined && withEmail !== undefined) {
    throw new AxiError("Pass a conversation id or --with <email>, not both", "VALIDATION_ERROR", [
      usage,
    ]);
  }
  if (withEmail !== undefined) {
    const email = withEmail.trim().toLowerCase();
    if (!EMAIL.test(email)) {
      throw new AxiError(`--with expects an email address, got: ${withEmail}`, "VALIDATION_ERROR", [
        usage,
      ]);
    }
    return { kind: "dm", email };
  }
  if (positional === undefined) {
    throw new AxiError("Missing conversation: pass an id or --with <email>", "VALIDATION_ERROR", [
      usage,
      LOOKUP,
    ]);
  }
  return { kind: "space", id: parseSpaceId(positional) };
}

const MESSAGE_NAME = /^spaces\/([A-Za-z0-9_-]+)\/messages\/([A-Za-z0-9_.-]+)$/;

/**
 * Resolve a command that names one message: `<space> <message>`, a full
 * `spaces/…/messages/…` resource name alone, or `--with <email>` plus a
 * message. The message id may be a client-assigned `client-…` id; callers
 * that need the system id fetch the message.
 */
export function parseMessageTarget(
  positionals: string[],
  withEmail: string | undefined,
  usage: string,
): { target: SpaceTarget; message: string } {
  const full =
    positionals.length === 1 && withEmail === undefined ? MESSAGE_NAME.exec(positionals[0]) : null;
  if (full) return { target: { kind: "space", id: full[1] }, message: full[2] };

  const expected = withEmail === undefined ? 2 : 1;
  if (positionals.length !== expected) {
    throw new AxiError(
      positionals.length < expected
        ? "Missing conversation or message"
        : `Too many arguments: ${positionals.join(" ")}`,
      "VALIDATION_ERROR",
      [usage, "Get message ids from `gws-axi chat messages <space>`"],
    );
  }
  const target = resolveSpaceTarget(
    { positional: withEmail === undefined ? positionals[0] : undefined, withEmail },
    usage,
  );
  const raw = positionals[positionals.length - 1];
  const nested = MESSAGE_NAME.exec(raw);
  if (nested && target.kind === "space" && nested[1] !== target.id) {
    throw new AxiError(`Message ${raw} is not in conversation ${target.id}`, "VALIDATION_ERROR", [
      usage,
    ]);
  }
  const message = nested ? nested[2] : (raw.split("/").pop() ?? "");
  if (!/^[A-Za-z0-9_.-]+$/.test(message)) {
    throw new AxiError(`Not a message id: ${raw}`, "VALIDATION_ERROR", [usage]);
  }
  return { target, message };
}
