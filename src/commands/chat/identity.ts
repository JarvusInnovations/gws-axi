import type { chat_v1 } from "googleapis";
import { personId, type PeopleResolution } from "../../google/people.js";

/**
 * How every chat command renders a person.
 *
 * The Chat API names people itself — against the letter of Google's reference,
 * and including people outside the account's domain, whom no directory lookup
 * can name. So the response is the source, and the shared people resolver is
 * only the fallback for anyone the response leaves unnamed.
 *
 * See specs/commands/chat-read.md § Identities.
 */

/**
 * `email` is not in Google's schema for a Chat user — the client library's
 * type omits it — but the API returns it. Read as optional, never assumed.
 */
export type ChatUser = chat_v1.Schema$User & { email?: string | null };

export interface IdentityRow {
  /** `users/<id>`, as the API returned it. */
  id: string;
  name: string;
  email: string;
  type: "human" | "bot";
}

interface Known {
  ref: string;
  name: string;
  email: string;
  type: "human" | "bot";
}

function typeOf(user: ChatUser): "human" | "bot" {
  return user.type === "BOT" ? "bot" : "human";
}

/**
 * Collects the people a response mentions, then answers how each should be
 * shown. Build it up with `add`, resolve whoever `needsLookup` returns, hand
 * the result to `applyResolution`, and only then ask for labels.
 */
export class IdentityLedger {
  private readonly known = new Map<string, Known>();

  add(user: ChatUser | null | undefined): void {
    const ref = user?.name;
    if (!user || !ref) return;
    const name = user.displayName?.trim() ?? "";
    const email = user.email?.trim() ?? "";
    const existing = this.known.get(ref);
    if (!existing) {
      this.known.set(ref, { ref, name, email, type: typeOf(user) });
      return;
    }
    // The same person can arrive named in one place and bare in another.
    if (!existing.name && name) existing.name = name;
    if (!existing.email && email) existing.email = email;
  }

  /** People the response left unnamed. Bots are not people and are never looked up. */
  needsLookup(): string[] {
    return [...this.known.values()].filter((k) => k.type === "human" && !k.name).map((k) => k.ref);
  }

  /** Fill in anyone the response left unnamed. Chat's own answer always wins. */
  applyResolution(resolution: PeopleResolution): void {
    for (const entry of this.known.values()) {
      if (entry.name) continue;
      const id = personId(entry.ref);
      const person = id ? resolution.people.get(id) : undefined;
      if (!person) continue;
      entry.name = person.name;
      if (!entry.email) entry.email = person.email;
    }
  }

  /**
   * The display label for a person: their name, `name <email>` when another
   * person in this response shares that name, or the raw id when nobody could
   * name them.
   */
  label(user: ChatUser | null | undefined): string {
    const ref = user?.name;
    if (!ref) return "";
    const entry = this.known.get(ref);
    const name = entry?.name || user?.displayName?.trim() || "";
    // An app nobody named is still an app, not an unresolved person.
    if (!name) return (entry?.type ?? typeOf(user ?? {})) === "bot" ? `bot ${ref}` : ref;
    const shared = [...this.known.values()].filter((k) => k.name === name).length > 1;
    const email = entry?.email || user?.email?.trim() || "";
    return shared && email ? `${name} <${email}>` : name;
  }

  /** The `senders[]` / `members[]` legend: each person once. */
  rows(): IdentityRow[] {
    return [...this.known.values()].map((k) => ({
      id: k.ref,
      name: k.name,
      email: k.email,
      type: k.type,
    }));
  }

  /** People neither Chat nor the directory could name. */
  unresolved(): number {
    return [...this.known.values()].filter((k) => k.type === "human" && !k.name).length;
  }
}

export const UNRESOLVED_NOTE =
  "Some people could not be named: Chat did not provide a name and they are outside this account's directory. They are shown by id.";

/**
 * A name for a conversation that has none of its own — a direct message or an
 * unnamed group chat — built from the labels of everyone in it but the account.
 */
export function deriveSpaceName(others: string[]): string {
  if (others.length === 0) return "(only you)";
  if (others.length <= 2) return others.join(", ");
  return `${others.slice(0, 2).join(", ")}, +${others.length - 2}`;
}
