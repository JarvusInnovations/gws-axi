import { AxiError } from "axi-sdk-js";
import type { chat_v1 } from "googleapis";
import { chatClient } from "../../google/client.js";
import { resolvePeople } from "../../google/people.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { resolveSpaceTarget, type SpaceTarget } from "./address.js";
import { parseArgs, parseLimit } from "./flags.js";
import { IdentityLedger, UNRESOLVED_NOTE, type ChatUser } from "./identity.js";
import { bareId, chatError, nameSpaces, resolveSpace, retryingChat } from "./shared.js";

export const MEMBERS_HELP = `usage: gws-axi chat members <space> [flags]
       gws-axi chat members --with <email> [flags]
args[1]:
  <space>              A conversation id (AAAA… or spaces/AAAA…) or a Chat URL
flags[5]:
  --with <email>       The 1:1 direct message with this person
  --include-invited    Also list people invited but not yet joined; adds a
                       \`state\` column
  --include-groups     Also list Google Groups that are members
  --limit <n>          Max members to return (default: 100, max: 1000)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi chat members AAAAxyz
  gws-axi chat members AAAAxyz --include-invited
output:
  A \`space{id,type,name}\` header, then
  \`members[N]{id,name,email,type,role}\`.
`;

const COMMAND = "chat members";
const USAGE = "Usage: gws-axi chat members <space> | --with <email>";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

interface Flags {
  target: SpaceTarget;
  includeInvited: boolean;
  includeGroups: boolean;
  limit: number;
}

export function parseMembersFlags(args: string[]): Flags {
  const parsed = parseArgs(
    args,
    { value: ["--with", "--limit"], boolean: ["--include-invited", "--include-groups"] },
    COMMAND,
  );
  if (parsed.positionals.length > 1) {
    throw new AxiError(
      `\`${COMMAND}\` lists one conversation, got ${parsed.positionals.length}`,
      "VALIDATION_ERROR",
      [USAGE],
    );
  }
  return {
    target: resolveSpaceTarget(
      { positional: parsed.positionals[0], withEmail: parsed.values["--with"] },
      USAGE,
    ),
    includeInvited: parsed.booleans.has("--include-invited"),
    includeGroups: parsed.booleans.has("--include-groups"),
    limit: parseLimit(
      parsed.values["--limit"],
      { fallback: DEFAULT_LIMIT, max: MAX_LIMIT },
      COMMAND,
    ),
  };
}

export interface MemberRow {
  id: string;
  name: string;
  email: string;
  type: "human" | "bot" | "group";
  role: string;
  state: string;
}

const ROLE_LABELS: Record<string, string> = {
  ROLE_MEMBER: "member",
  ROLE_MANAGER: "manager",
  ROLE_ASSISTANT_MANAGER: "assistant_manager",
};

const STATE_LABELS: Record<string, string> = {
  JOINED: "joined",
  INVITED: "invited",
  NOT_A_MEMBER: "not_a_member",
};

export function toMemberRow(
  membership: chat_v1.Schema$Membership,
  ledger: IdentityLedger,
): MemberRow {
  const role = ROLE_LABELS[membership.role ?? ""] ?? (membership.role ?? "").toLowerCase();
  const state = STATE_LABELS[membership.state ?? ""] ?? (membership.state ?? "").toLowerCase();
  if (membership.groupMember) {
    const name = membership.groupMember.name ?? "";
    return { id: name, name, email: "", type: "group", role, state };
  }
  const user = membership.member as ChatUser | undefined;
  const row = ledger.rows().find((r) => r.id === user?.name);
  return {
    id: user?.name ?? "",
    // The label, so two members sharing a name stay tell-apart-able.
    name: row?.name ? ledger.label(user) : "",
    email: row?.email ?? "",
    type: row?.type ?? "human",
    role,
    state,
  };
}

export async function chatMembersCommand(account: string, args: string[]): Promise<string> {
  const flags = parseMembersFlags(args);
  const api = await chatClient(account);
  const space = await resolveSpace(api, account, flags.target);
  const spaceName = space.name ?? "";
  const spaceId = bareId(spaceName);

  const memberships: chat_v1.Schema$Membership[] = [];
  let pageToken: string | undefined;
  try {
    do {
      const res = await retryingChat(() =>
        api.spaces.members.list({
          parent: spaceName,
          pageSize: Math.min(flags.limit, MAX_LIMIT),
          pageToken,
          showInvited: flags.includeInvited || undefined,
          showGroups: flags.includeGroups || undefined,
        }),
      );
      memberships.push(...(res.data.memberships ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken && memberships.length < flags.limit);
  } catch (err) {
    throw chatError(err, { account, operation: "chat.spaces.members.list", space: spaceId });
  }
  const more = Boolean(pageToken) || memberships.length > flags.limit;
  const shown = memberships.slice(0, flags.limit);

  const ledger = new IdentityLedger();
  for (const m of shown) ledger.add(m.member as ChatUser);
  const [resolution, { named }] = await Promise.all([
    resolvePeople(account, ledger.needsLookup()),
    nameSpaces(api, account, [space]),
  ]);
  ledger.applyResolution(resolution);
  const header = named[0];

  const blocks: string[] = [
    renderObject({ account }),
    renderObject({ space: { id: header.id, type: header.type, name: header.name } }),
  ];

  if (shown.length === 0) {
    blocks.push(renderObject({ members: "no members visible in this conversation" }));
    return joinBlocks(...blocks);
  }

  const rows = shown.map((m) => toMemberRow(m, ledger));
  const unresolved = ledger.unresolved();
  blocks.push(
    renderObject({
      count: more ? `${rows.length} (more exist)` : `${rows.length} of ${rows.length}`,
      ...(unresolved > 0 ? { unresolved } : {}),
    }),
  );
  const schema = [field("id"), field("name"), field("email"), field("type"), field("role")];
  if (flags.includeInvited) schema.push(field("state"));
  blocks.push(renderList("members", rows as unknown as Array<Record<string, unknown>>, schema));

  const notes: string[] = [];
  if (resolution.degraded) notes.push(resolution.degraded);
  else if (unresolved > 0) notes.push(UNRESOLVED_NOTE);
  if (notes.length > 0) blocks.push(renderObject({ note: notes.join(" ") }));

  const help = [`Run \`gws-axi chat messages ${spaceId}\` to read this conversation`];
  if (more) help.push(`Run \`gws-axi chat members ${spaceId} --limit ${MAX_LIMIT}\` for more`);
  if (!flags.includeInvited) {
    help.push(`Add \`--include-invited\` to see people invited but not yet joined`);
  }
  blocks.push(renderHelp(help));
  return joinBlocks(...blocks);
}
