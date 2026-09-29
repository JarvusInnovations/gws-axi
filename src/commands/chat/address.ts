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
