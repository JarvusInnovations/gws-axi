import { AxiError } from "axi-sdk-js";
import type { chat_v1 } from "googleapis";
import { chatClient } from "../../google/client.js";
import { OUTSIDE_DIRECTORY_NOTE } from "../../google/people.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { resolveSpaceTarget } from "./address.js";
import { parseArgs, parseChoice, parseLimit } from "./flags.js";
import {
  chatError,
  nameSpaces,
  resolveSpace,
  SPACE_KINDS,
  TYPE_BY_KIND,
  type SpaceKind,
  retryingChat,
} from "./shared.js";

export const SPACES_HELP = `usage: gws-axi chat spaces [flags]
flags[5]:
  --type <kind>        Only this kind: space (named space), group (group chat),
                       dm (direct message)
  --name <text>        Only conversations whose name contains this text,
                       case-insensitive. Matches derived names too.
  --with <email>       The 1:1 direct message with this person
  --limit <n>          Max conversations to return (default: 50)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi chat spaces
  gws-axi chat spaces --type dm --limit 10
  gws-axi chat spaces --name transit
  gws-axi chat spaces --with bob@example.com
output:
  A \`spaces[N]{id,type,name,last_active}\` list, most recently active first.
  The id is what every other chat command takes.
notes:
  Direct messages and unnamed group chats have no name of their own; theirs
  is derived from their other members, and \`names_derived: N\` counts them.
  Conversations are addressed by id, never by name — names aren't unique.
  Google omits direct messages and group chats that have never had a message.
`;

const COMMAND = "chat spaces";
const DEFAULT_LIMIT = 50;
const PAGE_SIZE = 1000;

interface Flags {
  type: SpaceKind | undefined;
  name: string | undefined;
  withEmail: string | undefined;
  limit: number;
}

export function parseSpacesFlags(args: string[]): Flags {
  const parsed = parseArgs(args, { value: ["--type", "--name", "--with", "--limit"] }, COMMAND);
  if (parsed.positionals.length > 0) {
    // A stray `chat spaces <id>` is a wrong turn worth naming, not ignoring.
    throw new AxiError(
      `\`${COMMAND}\` takes no positional argument: ${parsed.positionals[0]}`,
      "VALIDATION_ERROR",
      [
        "Run `gws-axi chat messages <space>` to read one conversation",
        "Run `gws-axi chat spaces --name <text>` to find one by name",
      ],
    );
  }
  return {
    type: parseChoice("--type", parsed.values["--type"], SPACE_KINDS),
    name: parsed.values["--name"]?.trim().toLowerCase() || undefined,
    withEmail: parsed.values["--with"],
    limit: parseLimit(parsed.values["--limit"], { fallback: DEFAULT_LIMIT, max: 1000 }, COMMAND),
  };
}

/** Most recently active first; conversations with no activity time go last. */
export function byLastActive(a: chat_v1.Schema$Space, b: chat_v1.Schema$Space): number {
  return (b.lastActiveTime ?? "").localeCompare(a.lastActiveTime ?? "");
}

async function listAllSpaces(
  account: string,
  type: SpaceKind | undefined,
): Promise<chat_v1.Schema$Space[]> {
  const api = await chatClient(account);
  const spaces: chat_v1.Schema$Space[] = [];
  let pageToken: string | undefined;
  try {
    do {
      const res = await retryingChat(() =>
        api.spaces.list({
          pageSize: PAGE_SIZE,
          pageToken,
          filter: type ? `spaceType = "${TYPE_BY_KIND[type]}"` : undefined,
        }),
      );
      spaces.push(...(res.data.spaces ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    throw chatError(err, { account, operation: "chat.spaces.list" });
  }
  return spaces;
}

export async function chatSpacesCommand(account: string, args: string[]): Promise<string> {
  const flags = parseSpacesFlags(args);
  const api = await chatClient(account);

  let candidates: chat_v1.Schema$Space[];
  if (flags.withEmail !== undefined) {
    const target = resolveSpaceTarget({ withEmail: flags.withEmail }, SPACES_HELP.split("\n")[0]);
    candidates = [await resolveSpace(api, account, target)];
  } else {
    // The whole set is fetched and sorted before the limit applies, so a
    // truncated list is the most recently active N rather than an arbitrary N.
    candidates = (await listAllSpaces(account, flags.type)).sort(byLastActive);
  }
  const total = candidates.length;

  // Naming costs a members lookup per unnamed conversation. Without --name only
  // the rows that will be shown are named; --name has to name all it filters.
  const toName = flags.name ? candidates : candidates.slice(0, flags.limit);
  const { named, resolution, unresolved } = await nameSpaces(api, account, toName);
  const matched = flags.name
    ? named.filter((s) => s.name.toLowerCase().includes(flags.name as string))
    : named;
  const rows = matched.slice(0, flags.limit);
  const matchedTotal = flags.name ? matched.length : total;

  const blocks: string[] = [renderObject({ account })];

  if (rows.length === 0) {
    const why = flags.name
      ? `no conversations with a name containing "${flags.name}"`
      : flags.type
        ? `no ${flags.type} conversations found`
        : "no conversations found";
    blocks.push(renderObject({ spaces: why }));
    blocks.push(
      renderHelp([
        "Run `gws-axi chat spaces` to list every conversation",
        "Google omits direct messages and group chats that have never had a message",
      ]),
    );
    return joinBlocks(...blocks);
  }

  const derived = rows.filter((r) => r.derived).length;
  blocks.push(
    renderObject({
      count: `${rows.length} of ${matchedTotal}`,
      ...(derived > 0 ? { names_derived: derived } : {}),
      ...(unresolved > 0 ? { unresolved } : {}),
    }),
  );
  blocks.push(
    renderList(
      "spaces",
      rows.map((r) => ({ id: r.id, type: r.type, name: r.name, last_active: r.lastActive })),
      [field("id"), field("type"), field("name"), field("last_active")],
    ),
  );

  const notes: string[] = [];
  if (derived > 0) {
    notes.push(
      "Names of direct messages and unnamed group chats are derived from their members; Chat gives them none.",
    );
  }
  if (resolution.degraded) notes.push(resolution.degraded);
  else if (unresolved > 0) notes.push(OUTSIDE_DIRECTORY_NOTE);
  if (notes.length > 0) blocks.push(renderObject({ note: notes.join(" ") }));

  const first = rows[0].id;
  const help = [
    `Run \`gws-axi chat messages ${first}\` to read a conversation`,
    `Run \`gws-axi chat members ${first}\` to see who is in it`,
  ];
  if (rows.length < matchedTotal) {
    help.push(
      `Showing the ${rows.length} most recently active of ${matchedTotal} — pass \`--limit ${matchedTotal}\` for all, or narrow with \`--type\` / \`--name\``,
    );
  }
  help.push("Run `gws-axi chat search <keywords>` to search messages across conversations");
  blocks.push(renderHelp(help));
  return joinBlocks(...blocks);
}
