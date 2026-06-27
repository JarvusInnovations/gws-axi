import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AxiError } from "axi-sdk-js";
import { createTwoFilesPatch, structuredPatch } from "diff";
import { driveClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { resolveOutputPath } from "../../util/paths.js";
import { fetchNativeRevisionExport, listRecentRevisions } from "./revision-content.js";

export const DIFF_HELP = `usage: gws-axi docs diff <fileId> <revA> [revB] [flags]
args[3]:
  <fileId>             The Google Doc / Drive file ID (the portion of the URL after /d/)
  <revA>               The "from" revision id (from \`gws-axi docs revisions <fileId>\`)
  <revB>               The "to" revision id (optional; defaults to the head revision)
flags[3]:
  --full               Don't truncate the diff (default cap: 8000 chars)
  --out <path>         Write the full unified diff to a file (implies --full)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi docs diff 1Kc9mv... 841 865
  gws-axi docs diff 1Kc9mv... 841            # 841 vs head
  gws-axi docs diff 1Kc9mv... 841 865 --out ./change.diff
output:
  A \`document{id,name,type}\` header, \`from{revision,modified,author}\` and
  \`to{revision,modified,author}\` provenance blocks, a \`summary{lines_added,
  lines_removed,changed}\`, and a \`diff\` block of the unified diff (truncated
  unless --full/--out). The diff shows the changes that transform revA into revB.
notes:
  Native Google Docs only. Google exposes no diff API, so this exports BOTH
  revisions to markdown server-side and diffs them locally — the result is a
  diff of two markdown exports (lossy relevance previews), NOT a faithful
  editorial diff: formatting-only or Google-specific changes may be invisible,
  and native revision history is itself a sparse sample.
`;

const DEFAULT_TRUNCATE_CHARS = 8000;

interface ParsedFlags {
  fileId: string;
  revA: string;
  revB: string | undefined;
  full: boolean;
  out: string | undefined;
}

export function parseFlags(args: string[]): ParsedFlags {
  const positionals: string[] = [];
  let full = false;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--full":
        full = true;
        break;
      case "--out":
        out = next;
        i++;
        break;
      default:
        if (!arg.startsWith("--")) positionals.push(arg);
    }
  }
  const [fileId, revA, revB] = positionals;
  if (!fileId || !revA) {
    throw new AxiError("docs diff needs a fileId and at least one revision", "VALIDATION_ERROR", [
      "Usage: gws-axi docs diff <fileId> <revA> [revB]",
      "List revision ids with `gws-axi docs revisions <fileId>`",
    ]);
  }
  // --out writes the full diff; truncation only protects an inline response.
  if (out) full = true;
  return { fileId, revA, revB, full, out };
}

export interface DiffResult {
  unified: string;
  linesAdded: number;
  linesRemoved: number;
  changed: boolean;
}

/**
 * Compute a unified diff (and added/removed line counts) of two text blobs.
 * Argument order is respected — the diff transforms `textA` into `textB`.
 * Pure (no I/O) so it's unit-testable.
 */
export function computeDiff(
  labelA: string,
  labelB: string,
  textA: string,
  textB: string,
  headerA = "",
  headerB = "",
): DiffResult {
  const patch = structuredPatch(labelA, labelB, textA, textB, "", "");
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) linesAdded++;
      else if (line.startsWith("-")) linesRemoved++;
    }
  }
  return {
    unified: createTwoFilesPatch(labelA, labelB, textA, textB, headerA, headerB),
    linesAdded,
    linesRemoved,
    changed: textA !== textB,
  };
}

export async function docsDiffCommand(account: string, args: string[]): Promise<string> {
  const flags = parseFlags(args);
  const api = await driveClient(account);

  // Step 1: metadata — name + native classification.
  let meta: { name: string; mimeType: string };
  try {
    const res = await api.files.get({
      fileId: flags.fileId,
      fields: "id,name,mimeType",
      supportsAllDrives: true,
    });
    meta = {
      name: res.data.name ?? "(unnamed)",
      mimeType: res.data.mimeType ?? "application/octet-stream",
    };
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "drive.files.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `File '${flags.fileId}' not found (or ${account} doesn't have access)`,
        "FILE_NOT_FOUND",
        [
          "Verify the file ID is correct (the portion of the URL after /d/)",
          `Confirm ${account} has at least view access to the file`,
        ],
      );
    }
    throw translated;
  }

  if (!meta.mimeType.startsWith("application/vnd.google-apps.")) {
    throw new AxiError(
      `'${flags.fileId}' is not a native Google Doc — diff compares markdown exports, which binary files don't have`,
      "NON_NATIVE_DOCUMENT",
      [
        `Compare size/mime across revisions with \`gws-axi drive revisions ${flags.fileId} --full\``,
        `Or fetch each revision's bytes with \`gws-axi docs download ${flags.fileId} --revision <id>\` and diff locally`,
      ],
    );
  }

  // Step 2: resolve revB → head when omitted.
  let revB = flags.revB;
  if (!revB) {
    const head = await listRecentRevisions(api, flags.fileId, 1);
    if (head.length === 0) {
      throw new AxiError(`No revisions found for '${flags.fileId}'`, "REVISION_NOT_FOUND", [
        `List revisions with \`gws-axi docs revisions ${flags.fileId}\``,
      ]);
    }
    revB = head[0].id;
  }

  // Step 3: export both revisions to markdown (server-side), in parallel.
  // A bad id surfaces as REVISION_NOT_FOUND from the helper.
  const [exportA, exportB] = await Promise.all([
    fetchNativeRevisionExport(api, account, flags.fileId, flags.revA, undefined),
    fetchNativeRevisionExport(api, account, flags.fileId, revB, undefined),
  ]);

  const textA = exportA.bytes.toString("utf8");
  const textB = exportB.bytes.toString("utf8");

  // Step 4: compute the diff. Argument order is respected (revA → revB);
  // never reordered chronologically.
  const labelA = `r${flags.revA}`;
  const labelB = `r${revB}`;
  const { unified, linesAdded, linesRemoved, changed } = computeDiff(
    labelA,
    labelB,
    textA,
    textB,
    exportA.modified,
    exportB.modified,
  );

  const blocks: string[] = [];
  blocks.push(renderObject({ account }));
  blocks.push(
    renderObject({
      document: { id: flags.fileId, name: meta.name, type: "native" },
    }),
  );
  blocks.push(
    renderObject({
      from: {
        revision: flags.revA,
        modified: exportA.modified,
        author: exportA.author,
      },
    }),
  );
  blocks.push(
    renderObject({
      to: { revision: revB, modified: exportB.modified, author: exportB.author },
    }),
  );
  blocks.push(
    renderObject({
      summary: {
        lines_added: linesAdded,
        lines_removed: linesRemoved,
        changed,
      },
    }),
  );

  const suggestions: string[] = [];

  if (!changed) {
    // Identical markdown exports — which does NOT prove the source revisions
    // were identical, only their previews.
    blocks.push(
      renderObject({
        diff: "no differences (the two markdown exports are identical)",
      }),
    );
  } else {
    const total = unified.length;
    if (flags.out) {
      const defaultName = `${stripExt(meta.name)}.r${flags.revA}-r${revB}.diff`;
      const outPath = await resolveOutputPath(flags.out, defaultName);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, unified);
      blocks.push(renderObject({ saved: outPath, diff_total_chars: total }));
    } else {
      const cap = flags.full ? Number.POSITIVE_INFINITY : DEFAULT_TRUNCATE_CHARS;
      const truncated = total > cap;
      blocks.push(renderObject({ diff: truncated ? `${unified.slice(0, cap)}…` : unified }));
      if (truncated) {
        blocks.push(renderObject({ diff_truncated: true, diff_total_chars: total }));
        suggestions.push(
          `Run \`gws-axi docs diff ${flags.fileId} ${flags.revA} ${revB} --out <path>\` to save the full diff, or --full to expand inline`,
        );
      }
    }
  }

  for (const n of [exportA.note, exportB.note]) {
    if (n) blocks.push(renderObject({ note: n }));
  }

  suggestions.push(
    `Fetch a side's full content: \`gws-axi docs download ${flags.fileId} --revision ${flags.revA}\` (or --revision ${revB})`,
  );
  suggestions.push(`List all revisions: \`gws-axi docs revisions ${flags.fileId}\``);
  suggestions.push(
    "Diff compares markdown exports (lossy) — formatting-only changes may be invisible, and native revision history is a sparse sample",
  );

  blocks.push(renderHelp(suggestions));
  return joinBlocks(...blocks);
}

/** Strip a trailing extension from a filename, if present. */
function stripExt(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}
