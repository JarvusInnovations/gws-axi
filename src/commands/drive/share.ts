import { AxiError } from "axi-sdk-js";
import type { drive_v3 } from "googleapis";
import { driveClient, translateGoogleError } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { parseArgs, parseChoice } from "../chat/flags.js";

/**
 * Granting and removing named people's access to a Drive file or folder.
 *
 * Only named people and groups: gws-axi never makes anything public or
 * domain-wide, and no flag unlocks it. Drive's permissions.create upgrades a
 * role silently and ignores a downgrade silently, so the current permission is
 * read first and a role change goes through permissions.update.
 *
 * See specs/commands/drive-share.md.
 */

export const SHARE_HELP = `usage: gws-axi drive share <file-id> --with <email>[,<email>…] --role <role> [flags]
args[1]:
  <file-id>            The file or folder to share
flags[6]:
  --with <email>       Who to share with. Comma-separated, or repeat the flag.
                       Named people and groups only — never "anyone" or a domain.
  --role <role>        REQUIRED — reader, commenter, or writer. The role they end up
                       with, up or down from what they had.
  --group              The addresses are Google Groups
  --no-notify          Don't email them (default: notify). Drive requires the email
                       for an address with no Google account.
  --message <text>     Text for the notification email
  --account <email>    REQUIRED when 2+ accounts are authenticated (or set GWS_AXI_ACCOUNT)
examples:
  gws-axi drive share 1AbC... --with lead@school.org --role reader --account you@example.com
  gws-axi drive share 1AbC... --with a@x.org,b@x.org --role commenter --message "For review" --account you@example.com
output:
  \`file{id,name,type}\` and \`results[N]{email,status,role,note}\`. status is shared,
  already_shared, role_changed, or failed; role is read back from Drive.
notes:
  Sharing a folder shares everything in it.
  gws-axi does not make files public or domain-wide. Use the Drive UI for that.
`;

export const UNSHARE_HELP = `usage: gws-axi drive unshare <file-id> --with <email>[,<email>…] [flags]
args[1]:
  <file-id>            The file or folder
flags[2]:
  --with <email>       Whose access to remove. Comma-separated, or repeat the flag.
  --account <email>    REQUIRED when 2+ accounts are authenticated (or set GWS_AXI_ACCOUNT)
examples:
  gws-axi drive unshare 1AbC... --with lead@school.org --account you@example.com
output:
  \`results[N]{email,status,role,note}\`. status is unshared, not_shared, inherited
  (access comes from a parent folder — remove it there), owner, or failed.
`;

export const ROLES = ["reader", "commenter", "writer"] as const;
export type Role = (typeof ROLES)[number];
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const FOLDER = "application/vnd.google-apps.folder";
const PERMISSION_FIELDS = "id,type,role,emailAddress,permissionDetails(inherited,role)";

/** Collect every --with, whether comma-separated or repeated. */
function collectWith(args: string[]): { addresses: string[]; rest: string[] } {
  const addresses: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--with") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new AxiError("--with needs a value", "VALIDATION_ERROR", [
          "Pass one or more addresses: --with a@x.org,b@x.org",
        ]);
      }
      addresses.push(
        ...value
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
      );
      i++;
      continue;
    }
    rest.push(args[i]);
  }
  return { addresses, rest };
}

/**
 * Only named addresses. Anything else — "anyone", a domain, a typo — is
 * refused outright, before any call.
 */
export function checkAddresses(addresses: string[]): string[] {
  if (addresses.length === 0) {
    throw new AxiError("Missing --with", "VALIDATION_ERROR", [
      "Pass who to share with: --with lead@school.org",
    ]);
  }
  const bad = addresses.filter((a) => !EMAIL.test(a));
  if (bad.length > 0) {
    throw new AxiError(
      `Not an email address: ${bad.join(", ")} — gws-axi only shares with named people and groups`,
      "PUBLIC_SHARING_REFUSED",
      [
        "gws-axi never makes files public or shares them across a domain; there is no flag for it",
        "If that's really wanted, a person can do it in the Drive UI (Share → General access)",
      ],
    );
  }
  return [...new Set(addresses.map((a) => a.toLowerCase()))];
}

export interface ShareFlags {
  fileId: string;
  addresses: string[];
  role: Role;
  group: boolean;
  notify: boolean;
  message?: string;
}

export function parseShareFlags(args: string[]): ShareFlags {
  const { addresses, rest } = collectWith(args);
  const parsed = parseArgs(
    rest,
    { value: ["--role", "--message"], boolean: ["--group", "--no-notify"] },
    "drive share",
  );
  const usage =
    "Usage: gws-axi drive share <file-id> --with <email> --role reader|commenter|writer";
  if (parsed.positionals.length !== 1) {
    throw new AxiError(
      parsed.positionals.length === 0 ? "Missing file id" : "Share one file at a time",
      "VALIDATION_ERROR",
      [usage],
    );
  }
  const role = parseChoice("--role", parsed.values["--role"], ROLES);
  if (!role) throw new AxiError("Missing --role", "VALIDATION_ERROR", [usage]);
  const notify = !parsed.booleans.has("--no-notify");
  const message = parsed.values["--message"];
  if (message !== undefined && !notify) {
    throw new AxiError(
      "--message goes in the notification email; drop --no-notify",
      "VALIDATION_ERROR",
      [usage],
    );
  }
  return {
    fileId: parsed.positionals[0],
    addresses: checkAddresses(addresses),
    role,
    group: parsed.booleans.has("--group"),
    notify,
    message,
  };
}

export function parseUnshareFlags(args: string[]): { fileId: string; addresses: string[] } {
  const { addresses, rest } = collectWith(args);
  const parsed = parseArgs(rest, {}, "drive unshare");
  if (parsed.positionals.length !== 1) {
    throw new AxiError("Pass exactly one file id", "VALIDATION_ERROR", [
      "Usage: gws-axi drive unshare <file-id> --with <email>",
    ]);
  }
  return { fileId: parsed.positionals[0], addresses: checkAddresses(addresses) };
}

type Permission = drive_v3.Schema$Permission;

/** Whether an address holds a permission granted on this file itself. */
export const isDirect = (p: Permission): boolean =>
  !p.permissionDetails?.length || p.permissionDetails.some((d) => d.inherited === false);

export type ShareStep =
  | { kind: "create" }
  | { kind: "none"; status: "already_shared" }
  | { kind: "update"; permissionId: string; from: string };

/** What sharing needs to do, given what the address already has. */
export function planShare(existing: Permission | undefined, role: Role): ShareStep {
  if (!existing || !isDirect(existing)) return { kind: "create" };
  if (existing.role === role) return { kind: "none", status: "already_shared" };
  return { kind: "update", permissionId: existing.id ?? "", from: existing.role ?? "" };
}

export type UnshareStep =
  | { kind: "delete"; permissionId: string; role: string }
  | { kind: "none"; status: "not_shared" | "inherited" | "owner"; role: string };

export function planUnshare(existing: Permission | undefined): UnshareStep {
  if (!existing) return { kind: "none", status: "not_shared", role: "" };
  if (existing.role === "owner") return { kind: "none", status: "owner", role: "owner" };
  if (!isDirect(existing)) return { kind: "none", status: "inherited", role: existing.role ?? "" };
  return { kind: "delete", permissionId: existing.id ?? "", role: existing.role ?? "" };
}

interface Target {
  api: drive_v3.Drive;
  file: drive_v3.Schema$File;
  byEmail: Map<string, Permission>;
}

async function loadTarget(account: string, fileId: string): Promise<Target> {
  const api = await driveClient(account);
  try {
    const file = (
      await api.files.get({ fileId, fields: "id,name,mimeType", supportsAllDrives: true })
    ).data;
    const byEmail = await listPermissions(api, fileId);
    return { api, file, byEmail };
  } catch (err) {
    const translated = translateGoogleError(err, { account, operation: "drive.permissions.list" });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(`File ${fileId} not found, or ${account} can't see it`, "FILE_NOT_FOUND", [
        "Check the id — `gws-axi drive search <query>` finds files by name",
      ]);
    }
    if (translated.code === "FORBIDDEN") {
      translated.suggestions.unshift(`${account} may not change sharing on this file`);
    }
    throw translated;
  }
}

async function listPermissions(
  api: drive_v3.Drive,
  fileId: string,
): Promise<Map<string, Permission>> {
  const byEmail = new Map<string, Permission>();
  let pageToken: string | undefined;
  do {
    const res = await api.permissions.list({
      fileId,
      fields: `nextPageToken,permissions(${PERMISSION_FIELDS})`,
      supportsAllDrives: true,
      pageToken,
    });
    for (const p of res.data.permissions ?? []) {
      if (p.emailAddress) byEmail.set(p.emailAddress.toLowerCase(), p);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return byEmail;
}

function reason(err: unknown, account: string, operation: string): string {
  const shape = err as {
    response?: { data?: { error?: { errors?: Array<{ reason?: string }>; message?: string } } };
  };
  const why = shape.response?.data?.error?.errors?.[0]?.reason;
  if (why === "invalidSharingRequest") {
    return "no Google account at this address; Drive needs to send it an invite, so drop --no-notify";
  }
  return translateGoogleError(err, { account, operation }).message;
}

function fileBlock(file: drive_v3.Schema$File): Record<string, unknown> {
  const isFolder = file.mimeType === FOLDER;
  return { file: { id: file.id, name: file.name, type: isFolder ? "folder" : "file" } };
}

export async function driveShareCommand(account: string, args: string[]): Promise<string> {
  const flags = parseShareFlags(args);
  const { api, file, byEmail } = await loadTarget(account, flags.fileId);

  const rows: Array<Record<string, string>> = [];
  for (const email of flags.addresses) {
    const existing = byEmail.get(email);
    const step = planShare(existing, flags.role);
    try {
      if (step.kind === "none") {
        rows.push({ email, status: step.status, role: flags.role, note: "" });
      } else if (step.kind === "update") {
        const res = await api.permissions.update({
          fileId: flags.fileId,
          permissionId: step.permissionId,
          requestBody: { role: flags.role },
          fields: PERMISSION_FIELDS,
          supportsAllDrives: true,
        });
        rows.push({
          email,
          status: "role_changed",
          role: res.data.role ?? flags.role,
          note: `was ${step.from}`,
        });
      } else {
        const res = await api.permissions.create({
          fileId: flags.fileId,
          requestBody: {
            type: flags.group ? "group" : "user",
            role: flags.role,
            emailAddress: email,
          },
          sendNotificationEmail: flags.notify,
          emailMessage: flags.message,
          fields: PERMISSION_FIELDS,
          supportsAllDrives: true,
        });
        const inherited = existing ? `also has ${existing.role} from a parent folder` : "";
        rows.push({ email, status: "shared", role: res.data.role ?? flags.role, note: inherited });
      }
    } catch (err) {
      rows.push({
        email,
        status: "failed",
        role: existing?.role ?? "",
        note: reason(err, account, "drive.permissions.create"),
      });
    }
  }

  const failed = rows.some((r) => r.status === "failed");
  if (failed) process.exitCode = 1;
  const isFolder = file.mimeType === FOLDER;
  const blocks = [
    renderObject({ account }),
    renderObject(fileBlock(file)),
    renderList("results", rows, [field("email"), field("status"), field("role"), field("note")]),
  ];
  const notes: string[] = [];
  if (isFolder) notes.push("This is a folder: everything in it is shared the same way.");
  if (!flags.notify) notes.push("No notification emails were sent.");
  if (notes.length > 0) blocks.push(renderObject({ note: notes.join(" ") }));
  const granted = rows.filter((r) => r.status === "shared" || r.status === "role_changed");
  const help = [`Run \`gws-axi drive permissions ${flags.fileId}\` to see everyone with access`];
  if (granted.length > 0) {
    help.push(
      `Run \`gws-axi drive unshare ${flags.fileId} --with ${granted.map((r) => r.email).join(",")} --account ${account}\` to undo`,
    );
  }
  blocks.push(renderHelp(help));
  return joinBlocks(...blocks);
}

export async function driveUnshareCommand(account: string, args: string[]): Promise<string> {
  const flags = parseUnshareFlags(args);
  const { api, file, byEmail } = await loadTarget(account, flags.fileId);

  const rows: Array<Record<string, string>> = [];
  for (const email of flags.addresses) {
    const step = planUnshare(byEmail.get(email));
    if (step.kind === "none") {
      const note =
        step.status === "inherited"
          ? "access comes from a parent folder — remove it there"
          : step.status === "owner"
            ? "an owner can't be unshared"
            : "";
      rows.push({ email, status: step.status, role: step.role, note });
      continue;
    }
    try {
      await api.permissions.delete({
        fileId: flags.fileId,
        permissionId: step.permissionId,
        supportsAllDrives: true,
      });
      // Access may also come from a parent folder; say so rather than imply it's gone.
      const after = (await listPermissions(api, flags.fileId)).get(email);
      rows.push({
        email,
        status: "unshared",
        role: after?.role ?? "",
        note: after ? `still has ${after.role} from a parent folder` : `was ${step.role}`,
      });
    } catch (err) {
      rows.push({
        email,
        status: "failed",
        role: step.role,
        note: reason(err, account, "drive.permissions.delete"),
      });
    }
  }

  if (rows.some((r) => r.status === "failed")) process.exitCode = 1;
  return joinBlocks(
    renderObject({ account }),
    renderObject(fileBlock(file)),
    renderList("results", rows, [field("email"), field("status"), field("role"), field("note")]),
    renderHelp([`Run \`gws-axi drive permissions ${flags.fileId}\` to see everyone with access`]),
  );
}
