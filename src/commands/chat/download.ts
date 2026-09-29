import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { chat_v1 } from "googleapis";
import { chatClient } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { resolveOutputPath, sanitizeFileName } from "../../util/paths.js";
import { parseMessageTarget, spaceResourceName } from "./address.js";
import { parseArgs } from "./flags.js";
import { fetchMessage } from "./react.js";
import { bareId, chatError, resolveSpace, retryingChat } from "./shared.js";

export const DOWNLOAD_HELP = `usage: gws-axi chat download <space> <message> [flags]
       gws-axi chat download spaces/<space>/messages/<id> [flags]
args[2]:
  <space>              A conversation id (AAAA… or spaces/AAAA…) or a Chat URL
  <message>            A message id as \`chat messages\` prints it, or a
                       client-assigned id (client-…)
flags[4]:
  --attachment <n|name> Only this attachment: its 1-based position in the
                       message, or its exact file name. Default: all.
  --out <path>         A directory to save into (default: the current one),
                       or — for a single attachment — a file path
  --with <email>       Use the 1:1 direct message with this person as <space>
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi chat download AAAAxyz Hk2.Hk2
  gws-axi chat download AAAAxyz Hk2.Hk2 --attachment 2 --out ./report.pdf
  gws-axi chat download AAAAxyz Hk2.Hk2 --out ./chat-files/
output:
  A \`saved[N]{name,type,bytes,path}\` table, and a \`drive_files[N]\` block for
  attachments that are Drive files.
notes:
  Find messages with attachments via \`gws-axi chat messages <space> --fields attachments\`.
  Drive-file attachments aren't fetched here: use \`gws-axi docs download <id>\`,
  which handles every Drive type and its export formats.
  An existing file at the destination is overwritten.
`;

const COMMAND = "chat download";
const USAGE =
  "Usage: gws-axi chat download <space> <message> [--attachment <n|name>] [--out <path>]";

type Attachment = chat_v1.Schema$Attachment;

interface Flags {
  positionals: string[];
  withEmail: string | undefined;
  attachment: string | undefined;
  out: string | undefined;
}

export function parseDownloadFlags(args: string[]): Flags {
  const parsed = parseArgs(args, { value: ["--attachment", "--out", "--with"] }, COMMAND);
  // Validated here so a bad address fails before anything is fetched.
  parseMessageTarget(parsed.positionals, parsed.values["--with"], USAGE);
  return {
    positionals: parsed.positionals,
    withEmail: parsed.values["--with"],
    attachment: parsed.values["--attachment"],
    out: parsed.values["--out"],
  };
}

export const isDriveFile = (a: Attachment): boolean =>
  Boolean(a.driveDataRef?.driveFileId) || a.source === "DRIVE_FILE";

/** Pick attachments by 1-based position or exact file name; all when unspecified. */
export function selectAttachments(all: Attachment[], which: string | undefined): Attachment[] {
  if (which === undefined) return all;
  const index = /^\d+$/.test(which) ? Number(which) : undefined;
  const picked = index !== undefined ? all[index - 1] : all.find((a) => a.contentName === which);
  if (!picked) {
    throw new AxiError(`No attachment ${which} on this message`, "ATTACHMENT_NOT_FOUND", [
      `It has ${all.length}: ${all.map((a, i) => `${i + 1}. ${a.contentName ?? "(unnamed)"}`).join(", ")}`,
    ]);
  }
  return [picked];
}

/** Safe, distinct file names for one message's attachments: `a.pdf`, `a (2).pdf`. */
export function distinctNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = sanitizeFileName(raw || "attachment");
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count === 1) return name;
    const ext = extname(name);
    return `${name.slice(0, name.length - ext.length)} (${count})${ext}`;
  });
}

function nextStep(type: string, path: string): string {
  if (type === "application/pdf")
    return `PDF saved — \`pdftotext "${basename(path)}" -\` to extract text`;
  if (type.startsWith("image/")) return `Image saved — \`open "${path}"\` to view`;
  if (type.startsWith("text/")) return `Text saved — \`cat "${path}"\``;
  return `Inspect with \`file "${path}"\``;
}

export async function chatDownloadCommand(account: string, args: string[]): Promise<string> {
  const flags = parseDownloadFlags(args);
  const { target, message: messageRef } = parseMessageTarget(
    flags.positionals,
    flags.withEmail,
    USAGE,
  );

  const api = await chatClient(account);
  const space = await resolveSpace(api, account, target);
  const spaceName = space.name ?? spaceResourceName(target.kind === "space" ? target.id : "");
  const message = await fetchMessage(api, account, spaceName, messageRef);
  const spaceId = bareId(spaceName);
  const messageId = bareId(message.name);

  const all = message.attachment ?? [];
  if (all.length === 0) {
    throw new AxiError(`Message ${messageId} has no attachments`, "NO_ATTACHMENTS", [
      `Run \`gws-axi chat messages ${spaceId} --fields attachments\` to find messages that have some`,
    ]);
  }

  const selected = selectAttachments(all, flags.attachment);
  const uploads = selected.filter((a) => !isDriveFile(a));
  const driveFiles = selected.filter(isDriveFile);

  const outIsDirectory =
    flags.out === undefined || flags.out.endsWith("/") || flags.out.endsWith("\\");
  if (uploads.length > 1 && !outIsDirectory) {
    // resolveOutputPath would also accept an existing directory; only a path
    // that can't be one is refused here, before anything is fetched.
    const { stat } = await import("node:fs/promises");
    const isDir = await stat(flags.out as string).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDir) {
      throw new AxiError(
        `--out ${flags.out} names one file, but ${uploads.length} attachments are selected`,
        "VALIDATION_ERROR",
        ["Pass a directory (ending in /), or pick one with --attachment <n|name>"],
      );
    }
  }

  const names = distinctNames(uploads.map((a) => a.contentName ?? ""));
  const saved: Array<Record<string, unknown>> = [];
  for (const [i, attachment] of uploads.entries()) {
    const resourceName = attachment.attachmentDataRef?.resourceName;
    if (!resourceName) continue;
    let bytes: Buffer;
    try {
      const res = await retryingChat(() =>
        api.media.download({ resourceName, alt: "media" }, { responseType: "arraybuffer" }),
      );
      bytes = Buffer.from(res.data as unknown as ArrayBuffer);
    } catch (err) {
      throw chatError(err, { account, operation: "chat.media.download", space: spaceId });
    }
    const path = await resolveOutputPath(flags.out, names[i]);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    saved.push({
      name: attachment.contentName ?? names[i],
      type: attachment.contentType ?? "",
      bytes: bytes.length,
      path,
    });
  }

  const blocks = [
    renderObject({ account }),
    renderObject({ message: { space: spaceId, id: messageId } }),
  ];
  if (saved.length > 0) {
    blocks.push(
      renderList("saved", saved, [field("name"), field("type"), field("bytes"), field("path")]),
    );
  } else {
    blocks.push(
      renderObject({ saved: "nothing saved — the selected attachments are all Drive files" }),
    );
  }

  const help: string[] = saved.map((s) => nextStep(String(s.type), String(s.path))).slice(0, 3);
  if (driveFiles.length > 0) {
    blocks.push(
      renderList(
        "drive_files",
        driveFiles.map((a) => ({
          name: a.contentName ?? "",
          type: a.contentType ?? "",
          drive_file: a.driveDataRef?.driveFileId ?? "",
        })),
        [field("name"), field("type"), field("drive_file")],
      ),
    );
    for (const a of driveFiles.slice(0, 3)) {
      const id = a.driveDataRef?.driveFileId;
      if (id) help.push(`Drive file — \`gws-axi docs download ${id}\` to save it`);
    }
  }
  blocks.push(renderHelp(help));
  return joinBlocks(...blocks);
}
