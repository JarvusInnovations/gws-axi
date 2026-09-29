import { AxiError } from "axi-sdk-js";
import type { chat_v1 } from "googleapis";
import { chatClient } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { parseMessageTarget, spaceResourceName, type SpaceTarget } from "./address.js";
import { parseArgs } from "./flags.js";
import { reactionSummary } from "./message-rows.js";
import { bareId, chatError, resolveSpace, retryingChat, selfUserRef } from "./shared.js";

/**
 * The account's own emoji reactions. Both commands are writes — a reaction is
 * seen by everyone in the conversation — and both are idempotent.
 *
 * See specs/commands/chat-react.md.
 */

const usageFor = (verb: string): string =>
  `Usage: gws-axi chat ${verb} <space> <message> --emoji <emoji>`;

const helpFor = (
  verb: "react" | "unreact",
): string => `usage: gws-axi chat ${verb} <space> <message> --emoji <emoji> [flags]
       gws-axi chat ${verb} spaces/<space>/messages/<id> --emoji <emoji> [flags]
args[2]:
  <space>              A conversation id (AAAA… or spaces/AAAA…) or a Chat URL
  <message>            A message id as \`chat messages\` prints it, or a
                       client-assigned id (client-…) from \`chat send --request-id\`
flags[3]:
  --emoji <emoji>      One Unicode emoji, exactly as it should appear: 👍, 👍🏽, 🎉.
                       Skin tones are different emoji. No :shortcodes:.
  --with <email>       Use the 1:1 direct message with this person as <space>
  --account <email>    REQUIRED when 2+ accounts are authenticated
                       (or set GWS_AXI_ACCOUNT)
examples:
  gws-axi chat ${verb} AAAAxyz Hk2.Hk2 --emoji 👍 --account you@example.com
output:
  \`action\` (${verb === "react" ? "reacted | already_reacted" : "unreacted | not_reacted"}), the message, the emoji, and
  \`reactions\` — the message's reaction summary after the change.
notes:
  ${verb === "react" ? "Everyone in the conversation sees the reaction, and its author is notified.\n  Reacting twice with the same emoji is a no-op." : "Removes only this account's reaction; others' stay.\n  Removing a reaction that isn't there is a no-op."}
`;

export const REACT_HELP = helpFor("react");
export const UNREACT_HELP = helpFor("unreact");

interface Flags {
  target: SpaceTarget;
  message: string;
  emoji: string;
}

/**
 * Refuse what is plainly not an emoji before asking Chat. Anything subtler is
 * left to Chat, whose refusal becomes INVALID_EMOJI.
 */
export function checkEmoji(raw: string | undefined, usage: string): string {
  const emoji = raw?.trim() ?? "";
  if (!emoji) {
    throw new AxiError("Missing --emoji", "VALIDATION_ERROR", [usage]);
  }
  if (/^:[\w+-]+:$/.test(emoji)) {
    throw new AxiError(`Shortcodes aren't supported: ${emoji}`, "VALIDATION_ERROR", [
      "Pass the emoji character itself, e.g. --emoji 👍",
    ]);
  }
  if (
    /^[\x20-\x7e]+$/.test(emoji) ||
    !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(emoji)
  ) {
    throw new AxiError(`Not an emoji: ${emoji}`, "VALIDATION_ERROR", [
      "Pass one Unicode emoji character, e.g. --emoji 👍",
    ]);
  }
  return emoji;
}

export function parseReactFlags(args: string[], verb: "react" | "unreact"): Flags {
  const usage = usageFor(verb);
  const parsed = parseArgs(args, { value: ["--emoji", "--with"] }, `chat ${verb}`);
  const withEmail = parsed.values["--with"];
  const positionals = parsed.positionals;

  const { target, message } = parseMessageTarget(positionals, withEmail, usage);
  return { target, message, emoji: checkEmoji(parsed.values["--emoji"], usage) };
}

function statusOf(err: unknown): number | undefined {
  const shape = err as { code?: number; response?: { status?: number } };
  return shape.response?.status ?? (typeof shape.code === "number" ? shape.code : undefined);
}

function messageOf(err: unknown): string {
  const shape = err as { message?: string; response?: { data?: { error?: { message?: string } } } };
  return shape.response?.data?.error?.message ?? shape.message ?? "";
}

type Chat = chat_v1.Chat;

/**
 * The message, fetched by whatever id was given. Also turns a client-assigned
 * id into the system id, which is the only form the reactions endpoint takes.
 */
export async function fetchMessage(
  api: Chat,
  account: string,
  spaceName: string,
  message: string,
): Promise<chat_v1.Schema$Message> {
  try {
    const res = await retryingChat(() =>
      api.spaces.messages.get({ name: `${spaceName}/messages/${message}` }),
    );
    return res.data;
  } catch (err) {
    const status = statusOf(err);
    if (status === 404 || status === 400 || status === 403) {
      throw new AxiError(
        `No message ${message} in conversation ${bareId(spaceName)}`,
        "MESSAGE_NOT_FOUND",
        [`Run \`gws-axi chat messages ${bareId(spaceName)}\` to see message ids`],
      );
    }
    throw chatError(err, {
      account,
      operation: "chat.spaces.messages.get",
      space: bareId(spaceName),
    });
  }
}

async function run(account: string, args: string[], verb: "react" | "unreact"): Promise<string> {
  const flags = parseReactFlags(args, verb);
  const api = await chatClient(account);
  const space = await resolveSpace(api, account, flags.target);
  const spaceName =
    space.name ?? spaceResourceName(flags.target.kind === "space" ? flags.target.id : "");
  const message = await fetchMessage(api, account, spaceName, flags.message);
  const messageName = message.name ?? "";
  const operation = `chat.spaces.messages.reactions.${verb === "react" ? "create" : "delete"}`;

  let action: string;
  try {
    if (verb === "react") {
      try {
        await api.spaces.messages.reactions.create({
          parent: messageName,
          requestBody: { emoji: { unicode: flags.emoji } },
        });
        action = "reacted";
      } catch (err) {
        if (statusOf(err) === 409) action = "already_reacted";
        else throw err;
      }
    } else {
      const self = selfUserRef(account);
      if (!self) {
        throw new AxiError(
          `Can't tell which reactions are ${account}'s: its stored profile has no user id`,
          "PROFILE_INCOMPLETE",
          [`Re-authenticate to refresh it: \`gws-axi auth login --account ${account} --no-wait\``],
        );
      }
      // Filtering by users/me returns a 500, so the account's own id is used.
      const res = await retryingChat(() =>
        api.spaces.messages.reactions.list({
          parent: messageName,
          filter: `emoji.unicode = "${flags.emoji}" AND user.name = "${self}"`,
        }),
      );
      const mine = (res.data.reactions ?? []).filter((r) => r.user?.name === self);
      for (const reaction of mine) {
        await api.spaces.messages.reactions.delete({ name: reaction.name ?? "" });
      }
      action = mine.length > 0 ? "unreacted" : "not_reacted";
    }
  } catch (err) {
    if (err instanceof AxiError) throw err;
    if (statusOf(err) === 400 && /emoji/i.test(messageOf(err))) {
      throw new AxiError(`Chat doesn't accept ${flags.emoji} as an emoji`, "INVALID_EMOJI", [
        "Pass one standard Unicode emoji; custom emoji aren't supported",
      ]);
    }
    throw chatError(err, { account, operation, space: bareId(spaceName) });
  }

  const after = await fetchMessage(api, account, spaceName, bareId(messageName));
  const spaceId = bareId(spaceName);
  const messageId = bareId(messageName);
  const reverse =
    verb === "react"
      ? `Run \`gws-axi chat unreact ${spaceId} ${messageId} --emoji ${flags.emoji} --account ${account}\` to take it back`
      : `Run \`gws-axi chat react ${spaceId} ${messageId} --emoji ${flags.emoji} --account ${account}\` to react again`;

  return joinBlocks(
    renderObject({ account }),
    renderObject({ action }),
    renderObject({ message: { space: spaceId, id: messageId } }),
    renderObject({ emoji: flags.emoji }),
    renderObject({ reactions: reactionSummary(after) || "none" }),
    renderHelp([reverse]),
  );
}

export const chatReactCommand = (account: string, args: string[]): Promise<string> =>
  run(account, args, "react");

export const chatUnreactCommand = (account: string, args: string[]): Promise<string> =>
  run(account, args, "unreact");
