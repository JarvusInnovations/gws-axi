import { AxiError } from "axi-sdk-js";
import type { drive_v3 } from "googleapis";
import { driveClient, translateGoogleError } from "../../google/client.js";
import {
  field,
  renderList,
  renderObject,
  joinBlocks,
  renderHelp,
  type FieldDef,
} from "../../output/index.js";

export const PERMISSIONS_HELP = `usage: gws-axi drive permissions <file-id> [flags]
args[1]:
  <file-id>            The Drive file ID (from URL or \`drive get\` / \`drive ls\`)
flags[1]:
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi drive permissions 1AbC...
output:
  A \`file{id,name,shared}\` header plus a \`permissions[N]{role,type,
  email_or_domain,display_name,deleted}\` table. \`role\` is owner/
  organizer/fileOrganizer/writer/commenter/reader; \`type\` is user/
  group/domain/anyone.
notes:
  Permissions only enumerate explicit grants — inherited folder
  permissions and shared-drive memberships aren't surfaced. Pass
  \`supportsAllDrives: true\` is automatic; shared-drive ACLs may
  include a longer chain than what shows here.
`;

interface ParsedFlags {
  fileId: string;
}

function parseFlags(args: string[]): ParsedFlags {
  let fileId: string | undefined;
  for (const arg of args) {
    if (!arg.startsWith("--") && fileId === undefined) fileId = arg;
  }
  if (!fileId) {
    throw new AxiError("Missing file ID argument", "VALIDATION_ERROR", [
      "Usage: gws-axi drive permissions <file-id>",
    ]);
  }
  return { fileId };
}

function permissionSchema(): FieldDef[] {
  return [
    field("role"),
    field("type"),
    field("email_or_domain"),
    field("display_name"),
    field("deleted"),
  ];
}

export async function drivePermissionsCommand(account: string, args: string[]): Promise<string> {
  const flags = parseFlags(args);
  const api = await driveClient(account);

  // File metadata first so we can show name + shared flag alongside.
  let file: drive_v3.Schema$File;
  try {
    const res = await api.files.get({
      fileId: flags.fileId,
      fields: "id,name,shared,owners(emailAddress)",
      supportsAllDrives: true,
    });
    file = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "drive.files.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `File '${flags.fileId}' not found (or ${account} doesn't have access)`,
        "FILE_NOT_FOUND",
        [`Verify the file ID is correct (from a Drive URL or \`drive search\`)`],
      );
    }
    throw translated;
  }

  let perms: drive_v3.Schema$Permission[] = [];
  try {
    const res = await api.permissions.list({
      fileId: flags.fileId,
      fields: "permissions(id,type,role,emailAddress,domain,displayName,deleted,pendingOwner)",
      supportsAllDrives: true,
    });
    perms = res.data.permissions ?? [];
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "drive.permissions.list",
    });
  }

  const rows = perms.map((p) => ({
    role: p.role ?? "",
    type: p.type ?? "",
    email_or_domain: p.emailAddress ?? p.domain ?? (p.type === "anyone" ? "anyone with link" : ""),
    display_name: p.displayName ?? "",
    deleted: p.deleted ? "✓" : "",
  }));

  const blocks: string[] = [];
  blocks.push(renderObject({ account }));
  blocks.push(
    renderObject({
      file: {
        id: file.id ?? flags.fileId,
        name: file.name ?? "",
        shared: file.shared ?? false,
      },
    }),
  );

  if (rows.length === 0) {
    blocks.push(renderObject({ permissions: "no explicit permissions" }));
  } else {
    blocks.push(renderList("permissions", rows, permissionSchema()));
  }

  const suggestions: string[] = [];
  const anyone = perms.find((p) => p.type === "anyone");
  if (anyone) {
    suggestions.push(
      `"anyone with link" (role: ${anyone.role}) — this file is accessible without sign-in`,
    );
  }
  const externalUsers = perms.filter(
    (p) =>
      p.type === "user" &&
      p.emailAddress &&
      !p.emailAddress.endsWith(`@${account.split("@")[1] ?? ""}`),
  );
  if (externalUsers.length > 0) {
    suggestions.push(
      `${externalUsers.length} external user${externalUsers.length === 1 ? "" : "s"} have access (not on ${account.split("@")[1] ?? "your"} domain)`,
    );
  }
  if (suggestions.length > 0) blocks.push(renderHelp(suggestions));

  return joinBlocks(...blocks);
}
