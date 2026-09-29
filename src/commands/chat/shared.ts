import { AxiError } from "axi-sdk-js";
import type { chat_v1 } from "googleapis";
import { existsSync, readFileSync } from "node:fs";
import { profilePathForAccount } from "../../config.js";
import { translateGoogleError } from "../../google/client.js";
import { personId, resolvePeople, type PeopleResolution } from "../../google/people.js";
import { toLocalOffsetISO } from "../calendar/dateish.js";
import { spaceResourceName, type SpaceTarget } from "./address.js";
import { deriveSpaceName, IdentityLedger, type ChatUser } from "./identity.js";

/**
 * Pieces every chat read shares: classifying Chat's failures, resolving a
 * destination to a conversation, and naming conversations that have no name
 * of their own.
 */

type Chat = chat_v1.Chat;
type Space = chat_v1.Schema$Space;

export type SpaceKind = "space" | "group" | "dm";

export const SPACE_KINDS: readonly SpaceKind[] = ["space", "group", "dm"];

const KIND_BY_TYPE: Record<string, SpaceKind> = {
  SPACE: "space",
  GROUP_CHAT: "group",
  DIRECT_MESSAGE: "dm",
};

export const TYPE_BY_KIND: Record<SpaceKind, string> = {
  space: "SPACE",
  group: "GROUP_CHAT",
  dm: "DIRECT_MESSAGE",
};

/** `unknown` when Chat would not describe the conversation at all. */
export function kindOf(space: Space): SpaceKind | "unknown" {
  return KIND_BY_TYPE[space.spaceType ?? ""] ?? "unknown";
}

function httpStatus(err: unknown): number | undefined {
  const shape = err as { code?: number; response?: { status?: number } };
  return shape.response?.status ?? (typeof shape.code === "number" ? shape.code : undefined);
}

/** The bare id from a resource name: `spaces/AAAA` → `AAAA`. */
export function bareId(name: string | null | undefined): string {
  return (name ?? "").split("/").pop() ?? "";
}

export function localTime(iso: string | null | undefined): string {
  return iso ? toLocalOffsetISO(iso) : "";
}

const FIND_SPACE = "Run `gws-axi chat spaces --name <text>` to find a conversation's id";

/**
 * Translate a Chat API failure. Chat's own conditions are classified first,
 * because the generic translation would file several of them under codes whose
 * advice can't fix them.
 */
export function chatError(
  err: unknown,
  context: { account: string; operation: string; space?: string; thread?: string },
): AxiError {
  if (err instanceof AxiError) return err;
  const { account, operation, space, thread } = context;
  const shape = err as {
    code?: number;
    message?: string;
    response?: { status?: number; data?: { error?: { code?: number; message?: string } } };
  };
  const status = shape.response?.data?.error?.code ?? shape.code ?? shape.response?.status ?? 0;
  const message = shape.response?.data?.error?.message ?? shape.message ?? "";

  if (
    thread &&
    /thread resource name|thread/i.test(message) &&
    (status === 400 || status === 404)
  ) {
    return new AxiError(
      `No thread ${thread} in conversation ${space ?? ""}`.trim(),
      "THREAD_NOT_FOUND",
      [`Run \`gws-axi chat messages ${space ?? "<space>"} --fields thread\` to see thread ids`],
    );
  }

  // A malformed or unknown id comes back 400; one the account isn't in, 403 or 404.
  const spaceProblem =
    status === 404 ||
    (status === 400 && /space resource name/i.test(message)) ||
    (status === 403 &&
      space !== undefined &&
      !/scope|not enabled|disabled|has not been used/i.test(message));
  if (space && spaceProblem) {
    return new AxiError(
      `Conversation ${space} not found, or ${account} is not in it`,
      "SPACE_NOT_FOUND",
      [FIND_SPACE, `Confirm ${account} is a member of the conversation`],
    );
  }

  return translateGoogleError(err, { account, operation });
}

/**
 * Retry a Chat call that was rate limited, and rethrow anything else **as it
 * came**. The shared `withRateLimitRetry` translates errors on the way out,
 * which would hide from `chatError` the very detail it classifies on.
 */
export async function retryingChat<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (httpStatus(err) !== 429 || attempt >= delays.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** The account's own user id, from the profile sign-in stored. */
export function selfUserRef(account: string): string | undefined {
  try {
    const path = profilePathForAccount(account);
    if (!existsSync(path)) return undefined;
    const profile = JSON.parse(readFileSync(path, "utf-8")) as { sub?: unknown };
    const id = personId(typeof profile.sub === "string" ? profile.sub : undefined);
    return id ? `users/${id}` : undefined;
  } catch {
    return undefined;
  }
}

/** Find the conversation a command was pointed at. */
export async function resolveSpace(
  api: Chat,
  account: string,
  target: SpaceTarget,
): Promise<Space> {
  if (target.kind === "dm") {
    try {
      const res = await api.spaces.findDirectMessage({ name: `users/${target.email}` });
      return res.data;
    } catch (err) {
      const status = httpStatus(err);
      if (status === 404 || status === 400) {
        return Promise.reject(
          new AxiError(
            status === 404
              ? `No direct message between ${account} and ${target.email}`
              : `${target.email} is not a Google Chat user ${account} can message`,
            "DM_NOT_FOUND",
            [
              "gws-axi cannot start a new direct message — there is no command that does",
              "Run `gws-axi chat spaces --type dm` to list the direct messages that exist",
            ],
          ),
        );
      }
      throw chatError(err, { account, operation: "chat.spaces.findDirectMessage" });
    }
  }

  const name = spaceResourceName(target.id);
  try {
    const res = await api.spaces.get({ name });
    return res.data;
  } catch (err) {
    // Some direct messages refuse to describe themselves (403) yet still let
    // their messages be read. Carry on with the bare conversation and let the
    // call that needs it decide whether the account really has no access.
    if (httpStatus(err) === 403) return { name };
    throw chatError(err, { account, operation: "chat.spaces.get", space: target.id });
  }
}

export interface NamedSpace {
  id: string;
  type: SpaceKind | "unknown";
  name: string;
  /** True when `name` was built from members rather than given by Chat. */
  derived: boolean;
  lastActive: string;
}

const CONCURRENCY = 8;

async function inPool<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  return results;
}

async function listMembers(
  api: Chat,
  account: string,
  space: string,
): Promise<chat_v1.Schema$Membership[]> {
  const res = await retryingChat(() => api.spaces.members.list({ parent: space, pageSize: 100 }));
  return res.data.memberships ?? [];
}

/**
 * Name a set of conversations. Those Chat names keep their name; the rest get
 * one derived from their members. A conversation whose members can't be read
 * falls back to its id — a name is decoration and never fails the listing.
 */
export async function nameSpaces(
  api: Chat,
  account: string,
  spaces: Space[],
): Promise<{ named: NamedSpace[]; resolution: PeopleResolution; unresolved: number }> {
  const self = selfUserRef(account);
  const ledger = new IdentityLedger();
  const unnamed = spaces.filter((s) => !s.displayName?.trim());

  const memberships = await inPool(unnamed, async (space) => {
    try {
      return await listMembers(api, account, space.name ?? "");
    } catch {
      return undefined;
    }
  });

  const isSelf = (user: ChatUser): boolean =>
    user.name === self || user.email?.toLowerCase() === account.toLowerCase();

  const othersBySpace = new Map<string, ChatUser[]>();
  unnamed.forEach((space, index) => {
    const members = memberships[index];
    if (!members) return;
    const others = members
      .map((m) => m.member as ChatUser | undefined)
      .filter((u): u is ChatUser => Boolean(u?.name))
      .filter((u) => !isSelf(u));
    for (const user of others) ledger.add(user);
    othersBySpace.set(space.name ?? "", others);
  });

  // Two cases the member list can't name, both answered by what was said:
  // an app arrives unnamed as a *member* but named as a *sender*; and some
  // direct messages refuse their member list while still serving messages.
  const needSenders = unnamed.filter((space) => {
    const others = othersBySpace.get(space.name ?? "");
    return !others || others.some((u) => u.type === "BOT" && !u.displayName);
  });
  await inPool(needSenders, async (space) => {
    const key = space.name ?? "";
    try {
      const res = await retryingChat(() =>
        api.spaces.messages.list({ parent: key, pageSize: 10, orderBy: "createTime desc" }),
      );
      const senders = (res.data.messages ?? [])
        .map((m) => m.sender as ChatUser | undefined)
        .filter((u): u is ChatUser => Boolean(u?.name))
        .filter((u) => !isSelf(u));
      for (const user of senders) ledger.add(user);
      if (!othersBySpace.has(key) && senders.length > 0) {
        othersBySpace.set(key, [...new Map(senders.map((u) => [u.name, u])).values()]);
      }
    } catch {
      // Left as it was: listed by id instead.
    }
  });

  const resolution = await resolvePeople(account, ledger.needsLookup());
  ledger.applyResolution(resolution);

  const named = spaces.map((space): NamedSpace => {
    const id = bareId(space.name);
    const given = space.displayName?.trim();
    const base = { id, type: kindOf(space), lastActive: localTime(space.lastActiveTime) };
    if (given) return { ...base, name: given, derived: false };
    const others = othersBySpace.get(space.name ?? "");
    if (!others) return { ...base, name: "(members not visible)", derived: true };
    return { ...base, name: deriveSpaceName(others.map((u) => ledger.label(u))), derived: true };
  });

  return { named, resolution, unresolved: ledger.unresolved() };
}
