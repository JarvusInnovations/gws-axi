import { AxiError } from "axi-sdk-js";
import { gmailClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { fetchLabels, labelNamesFor, resolveLabelIds } from "./labels-shared.js";

export const MODIFY_HELP = `usage: gws-axi gmail modify <message-id> [--add-label <name>...] [--remove-label <name>...] [flags]
args[1]:
  <message-id>           Message ID to modify (or thread ID with --thread)
flags[5]:
  --add-label <name>     Label to apply. Repeatable; also accepts comma lists.
                         Accepts user labels AND system labels (INBOX, UNREAD,
                         STARRED, IMPORTANT, SPAM, TRASH)
  --remove-label <name>  Label to remove. Repeatable; same name rules as above
  --thread               Treat <message-id> as a THREAD id and modify every
                         message in the thread
  --account <email>      REQUIRED when 2+ accounts are authenticated
  --yes                  Reserved (no-op) — writes are already explicit
examples:
  gws-axi gmail modify 1899abcd --remove-label INBOX          # archive
  gws-axi gmail modify 1899abcd --remove-label UNREAD         # mark read
  gws-axi gmail modify 1899abcd --add-label STARRED           # star
  gws-axi gmail modify 1899abcd --add-label "Work/Clients" --remove-label INBOX
  gws-axi gmail modify <thread-id> --thread --remove-label UNREAD
notes:
  Gmail state IS labels — archive = remove INBOX, mark-read = remove UNREAD,
  star = add STARRED, trash = add TRASH. Idempotent: adding a label already
  present (or removing one already absent) is a safe no-op. At least one of
  --add-label / --remove-label is required.
`;

interface ParsedFlags {
  id: string | undefined;
  add: string[];
  remove: string[];
  thread: boolean;
}

function collect(target: string[], value: string | undefined): void {
  if (!value) return;
  for (const part of value.split(",")) {
    const t = part.trim();
    if (t) target.push(t);
  }
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { id: undefined, add: [], remove: [], thread: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--add-label":
        collect(flags.add, next);
        i++;
        break;
      case "--remove-label":
        collect(flags.remove, next);
        i++;
        break;
      case "--thread":
        flags.thread = true;
        break;
      case "--yes":
        break;
      default:
        if (!arg.startsWith("--") && flags.id === undefined) {
          flags.id = arg;
        }
    }
  }
  return flags;
}

export async function gmailModifyCommand(account: string, args: string[]): Promise<string> {
  const flags = parseFlags(args);
  if (!flags.id) {
    throw new AxiError("Missing message ID argument", "VALIDATION_ERROR", [
      "Usage: gws-axi gmail modify <message-id> [--add-label <name>] [--remove-label <name>]",
      "Get an ID from `gws-axi gmail search`",
    ]);
  }
  if (flags.add.length === 0 && flags.remove.length === 0) {
    throw new AxiError(
      "Nothing to do — pass --add-label and/or --remove-label",
      "VALIDATION_ERROR",
      [
        "Archive: --remove-label INBOX · Mark read: --remove-label UNREAD · Star: --add-label STARRED",
      ],
    );
  }

  const api = await gmailClient(account);
  const labels = await fetchLabels(api, account);
  const addLabelIds = resolveLabelIds(flags.add, labels);
  const removeLabelIds = resolveLabelIds(flags.remove, labels);

  const requestBody = { addLabelIds, removeLabelIds };
  let resultingLabelIds: string[];
  try {
    if (flags.thread) {
      const res = await api.users.threads.modify({
        userId: "me",
        id: flags.id,
        requestBody,
      });
      // threads.modify returns the thread; derive the union of message labels.
      const union = new Set<string>();
      for (const m of res.data.messages ?? []) {
        for (const l of m.labelIds ?? []) union.add(l);
      }
      resultingLabelIds = [...union];
    } else {
      const res = await api.users.messages.modify({
        userId: "me",
        id: flags.id,
        requestBody,
      });
      resultingLabelIds = res.data.labelIds ?? [];
    }
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: flags.thread ? "gmail.threads.modify" : "gmail.messages.modify",
    });
  }

  const result: Record<string, unknown> = {
    action: "modified",
    account,
    target: flags.thread ? "thread" : "message",
    id: flags.id,
  };
  if (flags.add.length) result.added = labelNamesFor(addLabelIds, labels).join(", ");
  if (flags.remove.length) {
    result.removed = labelNamesFor(removeLabelIds, labels).join(", ");
  }
  result.current_labels = labelNamesFor(resultingLabelIds, labels).join(", ") || "(none)";

  return joinBlocks(
    renderObject(result),
    renderHelp([`Verify with \`gws-axi gmail read ${flags.id}\``]),
  );
}
