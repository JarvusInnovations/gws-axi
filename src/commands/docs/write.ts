import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { docs_v1 } from "googleapis";
import { docsClient, driveClient, translateGoogleError } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import {
  type Placement,
  type TabInfo,
  TAB_PROPERTIES_MASK,
  flattenTabInfos,
  parsePlacement,
  renderTabListing,
  resolvePlacement,
} from "./tabs.js";
import { parseArgs } from "../../util/flags.js";
import {
  locateTables,
  parseMarkdown,
  phase1Requests,
  phase2Requests,
  type Lossy,
  type Phase1,
} from "./md-to-doc.js";

/**
 * The Markdown writers: `docs create`, `docs write`, `docs append`
 * (specs/commands/docs-write.md). All three go through md-to-doc.ts and touch
 * exactly one tab. A write names the revision it read, so a Doc edited in
 * between is refused rather than overwritten.
 */

const SOURCE_HELP = `  <file> | - | --content <markdown>
                       Markdown to write: a local file, \`-\` for stdin, or an
                       inline string. Exactly one.`;

export const WRITE_HELP = `usage: gws-axi docs write <documentId> (<file> | - | --content <markdown>) [--tab <id> | --new-tab <title> [placement] [--emoji <emoji>]] [flags]
args[1]:
  <documentId>         The Doc to write into
flags[11]:
${SOURCE_HELP}
  --tab <id>           The tab to replace (id as \`docs read\` lists it). Omit on a
                       single-tab Doc; required on a multi-tab Doc.
  --new-tab <title>    Add a tab with this title and write into it instead
  --first | --last     Where the new tab goes (default: last). With --new-tab only
  --before <tabId>     … or next to an existing tab, in that tab's parent
  --after <tabId>
  --under <tabId>      … or as a child of that tab (last child, or --first)
  --emoji <emoji>      The new tab's icon
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi docs write 1BxAbc... ./notes.md --account you@example.com
  gws-axi docs write 1BxAbc... ./notes.md --tab t.k3j2 --account you@example.com
  gws-axi docs write 1BxAbc... --content "# Decisions" --new-tab Decisions --account you@example.com
  gws-axi docs write 1BxAbc... ./round-3.md --new-tab "Round 3" --first --emoji 📝 --account you@example.com
  gws-axi docs read 1BxAbc... --tab t.0 --out ./tab.md && … && gws-axi docs write 1BxAbc... ./tab.md --tab t.0 --account you@example.com
notes:
  Replaces the content of ONE tab; every other tab is untouched. Markdown goes
  through gws-axi's converter (not Google's importer), the one \`docs read\`
  round-trips: headings, emphasis, code, links, lists, tasks, quotes, tables,
  rules, images by URL, footnotes. What cannot be represented is written as text
  and reported under lossy[]. Checked tasks are written unchecked (no API for the
  state). The write is refused if the Doc changed since it was read.
  Re-running with --new-tab adds another tab; \`docs tabs update\` moves, renames
  or marks an existing one with the same placement flags.
`;

export const APPEND_HELP = `usage: gws-axi docs append <documentId> (<file> | - | --content <markdown>) [--tab <id>] [flags]
args[1]:
  <documentId>         The Doc to append to
flags[4]:
${SOURCE_HELP}
  --tab <id>           The tab to append to. Omit on a single-tab Doc.
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi docs append 1BxAbc... --content "## Update\\nShipped v2." --account you@example.com
  gws-axi docs append 1BxAbc... ./minutes.md --tab t.0 --account you@example.com
notes:
  Adds the Markdown at the end of one tab, after the existing content, through
  the same converter as \`docs write\` (see \`docs write --help\`).
`;

export const CREATE_HELP = `usage: gws-axi docs create --title <title> [<file> | - | --content <markdown>] [--parent <folder-id>] [flags]
flags[4]:
  --title <title>      REQUIRED. The new Doc's name
${SOURCE_HELP}
                       Optional here: no source makes an empty Doc.
  --parent <folder-id> Folder to create in (default: My Drive root)
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi docs create --title "Sprint notes" ./notes.md --account you@example.com
  gws-axi docs create --title "Decision log" --parent 1FoLdEr... --account you@example.com
notes:
  Creates a native Google Doc and writes the Markdown through gws-axi's
  converter (see \`docs write --help\`). Prefer this over \`drive upload --convert\`
  for Markdown: the result reads back with \`docs read\`, opens without a gap
  above the first heading, and the same converter can later target one tab.
  Re-running creates another Doc with the same title.
`;

export type WriteMode = "write" | "append" | "create";

export interface WriteFlags {
  documentId?: string;
  localPath?: string;
  stdin: boolean;
  content?: string;
  tab?: string;
  newTab?: string;
  /** Where `--new-tab` goes (specs/commands/docs-write.md § Placing a new tab). */
  placement?: Placement;
  emoji?: string;
  title?: string;
  parent?: string;
}

const NEW_TAB_FLAGS = ["--first", "--last", "--before", "--after", "--under", "--emoji"];

const FLAGS: Record<WriteMode, { value: string[]; boolean: string[] }> = {
  write: {
    value: ["--content", "--tab", "--new-tab", "--before", "--after", "--under", "--emoji"],
    boolean: ["--first", "--last"],
  },
  append: { value: ["--content", "--tab"], boolean: [] },
  create: { value: ["--content", "--title", "--parent"], boolean: [] },
};

export function parseWriteFlags(args: string[], mode: WriteMode): WriteFlags {
  const flags: WriteFlags = { stdin: false };
  // `-` is stdin; parseArgs already treats it as a positional.
  const parsed = parseArgs(args, FLAGS[mode], `docs ${mode}`);
  const positionals: string[] = [];
  for (const arg of parsed.positionals) {
    if (arg === "-") flags.stdin = true;
    else positionals.push(arg);
  }
  flags.content = parsed.values["--content"];
  flags.tab = parsed.values["--tab"];
  flags.newTab = parsed.values["--new-tab"];
  flags.title = parsed.values["--title"];
  flags.parent = parsed.values["--parent"];
  flags.emoji = parsed.values["--emoji"];
  flags.placement = parsePlacement(parsed);
  if ((flags.placement || flags.emoji !== undefined) && !flags.newTab) {
    const given = NEW_TAB_FLAGS.filter((f) => args.includes(f));
    throw new AxiError(
      `${given.join(", ")} place a new tab — pass --new-tab <title> with ${given.length > 1 ? "them" : "it"}`,
      "VALIDATION_ERROR",
      [
        "To move, rename or mark an existing tab: `gws-axi docs tabs update <documentId> <tabId> --first|--title …`",
        "Nothing was written",
      ],
    );
  }
  if (mode !== "create") {
    flags.documentId = positionals.shift();
    if (!flags.documentId) {
      throw new AxiError("Missing documentId argument", "VALIDATION_ERROR", [
        `Usage: gws-axi docs ${mode} <documentId> (<file> | - | --content <markdown>)`,
        "The documentId is the portion of the URL after /d/ and before /edit",
      ]);
    }
  }
  if (positionals.length > 1) {
    throw new AxiError(`Unexpected argument: ${positionals[1]}`, "VALIDATION_ERROR", [
      `Usage: gws-axi docs ${mode} --help`,
    ]);
  }
  flags.localPath = positionals[0];

  const sources =
    (flags.localPath ? 1 : 0) + (flags.stdin ? 1 : 0) + (flags.content !== undefined ? 1 : 0);
  if (sources > 1) {
    throw new AxiError("Provide exactly one content source", "VALIDATION_ERROR", [
      "A local path, `-` (stdin), and --content are mutually exclusive",
    ]);
  }
  if (sources === 0 && mode !== "create") {
    throw new AxiError("Missing content source", "VALIDATION_ERROR", [
      "Provide a local file path, `-` to read from stdin, or --content <markdown>",
      `Usage: gws-axi docs ${mode} <documentId> (<file> | - | --content <markdown>)`,
    ]);
  }
  if (flags.tab && flags.newTab) {
    throw new AxiError("--tab and --new-tab are mutually exclusive", "VALIDATION_ERROR", [
      "--tab writes into an existing tab; --new-tab adds one. Pick one",
    ]);
  }
  if (mode === "create" && !flags.title) {
    throw new AxiError("--title is required", "VALIDATION_ERROR", [
      'Usage: gws-axi docs create --title "<title>" [<file> | - | --content <markdown>]',
    ]);
  }
  return flags;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function readSource(flags: WriteFlags): Promise<string | undefined> {
  if (flags.content !== undefined) return flags.content;
  if (flags.stdin) return readStdin();
  if (!flags.localPath) return undefined;
  const absolutePath = resolve(process.cwd(), flags.localPath);
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch {
    throw new AxiError(`Local file not found: ${flags.localPath}`, "LOCAL_FILE_NOT_FOUND", [
      "Check the path; it must be a readable file on this machine",
    ]);
  }
  if (fileStat.isDirectory()) {
    throw new AxiError(
      `Local path is a directory, not a file: ${flags.localPath}`,
      "LOCAL_PATH_NOT_FILE",
      ["Pass a single Markdown file"],
    );
  }
  return readFile(absolutePath, "utf8");
}

// ---------------------------------------------------------------------------
// Document access

export interface TabTarget extends TabInfo {
  /** The tab body's end index (2 for an empty tab; unknown on a properties-only read). */
  end: number;
}

export interface DocState {
  id: string;
  title: string;
  revisionId: string;
  tabs: TabTarget[];
}

const stateFields = (withBodies: boolean) => {
  const tab = withBodies
    ? `${TAB_PROPERTIES_MASK},documentTab(body(content(endIndex)))`
    : TAB_PROPERTIES_MASK;
  return `documentId,title,revisionId,tabs(${tab},childTabs(${tab},childTabs(${tab})))`;
};

function tabTargets(tabs: docs_v1.Schema$Tab[] | undefined): TabTarget[] {
  const ends = new Map<string, number>();
  const walk = (list: docs_v1.Schema$Tab[] | undefined) => {
    for (const tab of list ?? []) {
      const content = tab.documentTab?.body?.content ?? [];
      ends.set(tab.tabProperties?.tabId ?? "", content[content.length - 1]?.endIndex ?? 2);
      walk(tab.childTabs ?? undefined);
    }
  };
  walk(tabs);
  return flattenTabInfos(tabs).map((info) => ({ ...info, end: ends.get(info.id) ?? 2 }));
}

/**
 * The Doc's tabs and head revision. `properties: true` skips the bodies — the
 * tab commands need the tree, not the end indexes.
 */
export async function readState(
  api: docs_v1.Docs,
  account: string,
  documentId: string,
  options: { properties?: boolean } = {},
): Promise<DocState> {
  try {
    const res = await api.documents.get({
      documentId,
      includeTabsContent: true,
      fields: stateFields(!options.properties),
    });
    return {
      id: res.data.documentId ?? documentId,
      title: res.data.title ?? "",
      revisionId: res.data.revisionId ?? "",
      tabs: tabTargets(res.data.tabs ?? undefined),
    };
  } catch (err) {
    const translated = translateGoogleError(err, { account, operation: "docs.documents.get" });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `Document '${documentId}' not found (or ${account} doesn't have access)`,
        "DOCUMENT_NOT_FOUND",
        [
          "Verify the document ID is correct (the portion of the URL after /d/)",
          `Confirm ${account} has edit access to the document`,
        ],
      );
    }
    if (translated.code === "OPERATION_NOT_SUPPORTED") {
      throw new AxiError(
        `'${documentId}' is not a native Google Doc — the Docs API can't write to it`,
        "NON_NATIVE_DOCUMENT",
        [
          `Run \`gws-axi drive upload <file> --update ${documentId} --convert --account ${account}\` to replace an uploaded file's content`,
          "Or open it in Drive and use File → Save as Google Docs, then write to the new Doc",
        ],
      );
    }
    throw translated;
  }
}

function chooseTab(
  state: DocState,
  requested: string | undefined,
  command: string,
  account: string,
): TabTarget {
  if (requested) {
    const found = state.tabs.find((t) => t.id === requested);
    if (found) return found;
    throw new AxiError(`Tab '${requested}' not found in document '${state.id}'`, "TAB_NOT_FOUND", [
      `Available tabs: ${state.tabs.map((t) => `${t.id} (${t.title})`).join(", ") || "(none)"}`,
      `Run \`gws-axi docs read ${state.id}\` to see the tabs list`,
    ]);
  }
  if (state.tabs.length === 1) return state.tabs[0];
  throw new AxiError(
    `Document '${state.id}' has ${state.tabs.length} tabs — pass --tab <id> to choose one`,
    "TAB_REQUIRED",
    [
      renderTabListing(state.tabs),
      `Run \`gws-axi docs ${command} ${state.id} <source> --tab <id> --account ${account}\` with one of the ids above`,
      "Nothing was written",
    ],
  );
}

function isStaleRevision(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? "";
  return /revision id .* does not match/i.test(message);
}

function isInvalidEmoji(err: unknown): boolean {
  return /not a valid emoji/i.test((err as { message?: string })?.message ?? "");
}

/** One `batchUpdate` under the revision read; stale and emoji refusals translated. */
export async function batch(
  api: docs_v1.Docs,
  account: string,
  documentId: string,
  requests: docs_v1.Schema$Request[],
  requiredRevisionId: string | undefined,
): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
  try {
    const res = await api.documents.batchUpdate({
      documentId,
      requestBody: {
        requests,
        writeControl: requiredRevisionId ? { requiredRevisionId } : undefined,
      },
    });
    return res.data;
  } catch (err) {
    if (isStaleRevision(err)) {
      throw new AxiError(
        `Document '${documentId}' changed since it was read — nothing was written`,
        "DOCUMENT_CHANGED",
        ["Re-run the command; it reads the current version and writes against it"],
      );
    }
    if (isInvalidEmoji(err)) {
      throw new AxiError(
        "Google refused the --emoji value: it must be exactly one emoji — nothing was written",
        "INVALID_EMOJI",
        ["Pass a single emoji character, e.g. --emoji 📝"],
      );
    }
    throw translateGoogleError(err, { account, operation: "docs.documents.batchUpdate" });
  }
}

// ---------------------------------------------------------------------------
// The shared write path

interface WriteResult {
  state: DocState;
  tab: TabInfo;
  revisionId: string;
  phase1: Phase1;
  lossy: Lossy[];
}

async function writeTab(
  api: docs_v1.Docs,
  account: string,
  state: DocState,
  tab: TabTarget,
  markdown: string,
  mode: "replace" | "append",
): Promise<WriteResult> {
  const parsed = parseMarkdown(markdown);
  const emptyTab = tab.end <= 2;
  const replacing = mode === "replace" && !emptyTab;
  const placement = {
    tabId: tab.id,
    base: mode === "replace" || emptyTab ? 1 : tab.end,
    emptyTab: mode === "replace" || emptyTab,
    atTop: mode === "replace" || emptyTab,
  };
  const phase1 = phase1Requests(parsed.blocks, placement);
  const requests: docs_v1.Schema$Request[] = [];
  if (replacing) {
    requests.push({
      deleteContentRange: { range: { startIndex: 1, endIndex: tab.end - 1, tabId: tab.id } },
    });
  }
  requests.push(...phase1.requests);

  let revisionId = state.revisionId;
  if (requests.length === 0) return { state, tab, revisionId, phase1, lossy: parsed.lossy };

  const reply = await batch(api, account, state.id, requests, revisionId);
  revisionId = reply.writeControl?.requiredRevisionId ?? revisionId;

  if (phase1.tables.length || phase1.footnotes.length) {
    const offset = requests.length - phase1.requests.length;
    const footnoteIds = phase1.footnoteRequestIndices.map(
      (i) => reply.replies?.[i + offset]?.createFootnote?.footnoteId ?? "",
    );
    let phase2: docs_v1.Schema$Request[];
    try {
      const res = await api.documents.get({ documentId: state.id, includeTabsContent: true });
      const content = findTab(res.data.tabs ?? undefined, tab.id)?.documentTab?.body?.content ?? [];
      const located = locateTables(content, placement.base);
      phase2 = phase2Requests(phase1, { tabId: tab.id, ...located, footnoteIds });
      if (phase2.length) {
        const second = await batch(api, account, state.id, phase2, revisionId);
        revisionId = second.writeControl?.requiredRevisionId ?? revisionId;
      }
    } catch (err) {
      const cause = err instanceof AxiError ? err.message : String(err);
      throw new AxiError(
        `The text was written but its tables/footnotes were not filled: ${cause}`,
        "WRITE_INCOMPLETE",
        [
          `Run \`gws-axi docs read ${state.id} --tab ${tab.id}\` to see what landed`,
          `Run \`gws-axi docs diff ${state.id} ${state.revisionId}\` to compare with the version before the write`,
          "Re-running the write replaces the tab's content again",
        ],
      );
    }
  }
  return { state, tab, revisionId, phase1, lossy: parsed.lossy };
}

function findTab(
  tabs: docs_v1.Schema$Tab[] | undefined,
  tabId: string,
): docs_v1.Schema$Tab | undefined {
  for (const tab of tabs ?? []) {
    if (tab.tabProperties?.tabId === tabId) return tab;
    const child = findTab(tab.childTabs ?? undefined, tabId);
    if (child) return child;
  }
  return undefined;
}

function render(
  action: string,
  account: string,
  result: WriteResult,
  extra: { previousRevision?: string; newTab?: boolean; tabs?: TabInfo[] },
): string {
  const { state, tab, phase1, lossy } = result;
  const blocks: string[] = [];
  blocks.push(renderObject({ action, account }));
  blocks.push(
    renderObject({
      document: {
        id: state.id,
        title: state.title,
        tab: tab.id,
        tab_title: tab.title,
        ...(extra.newTab ? { tab_index: tab.index, tab_parent: tab.parent } : {}),
        revision_id: result.revisionId,
        web_view_link: `https://docs.google.com/document/d/${state.id}/edit`,
      },
    }),
  );
  blocks.push(renderObject({ content: { chars: phase1.chars, blocks: phase1.blocks } }));
  if (lossy.length) {
    blocks.push(
      renderList("lossy", lossy as unknown as Array<Record<string, unknown>>, [
        field("construct"),
        field("count"),
        field("handling"),
      ]),
    );
  } else {
    blocks.push(renderObject({ lossy: "none" }));
  }
  if (extra.tabs) blocks.push(renderTabListing(extra.tabs));

  const help: string[] = [];
  help.push(`Verify: \`gws-axi docs read ${state.id} --tab ${tab.id}\``);
  if (extra.previousRevision && extra.previousRevision !== result.revisionId) {
    help.push(
      `Compare with the version before: \`gws-axi docs diff ${state.id} ${extra.previousRevision}\``,
    );
  }
  if (action === "created") {
    help.push(`Share it: \`gws-axi drive share ${state.id} --with <email> --account ${account}\``);
  }
  if (extra.newTab) {
    help.push(
      `Re-running with --new-tab adds another tab; to rewrite this one: \`gws-axi docs write ${state.id} <source> --tab ${tab.id} --account ${account}\``,
    );
    help.push(
      `Move, rename or mark it: \`gws-axi docs tabs update ${state.id} ${tab.id} --first|--title "<title>"|--emoji <emoji> --account ${account}\``,
    );
  }
  if (lossy.length) {
    const top = [...lossy].sort((a, b) => b.count - a.count)[0];
    help.push(
      `The Doc was written; ${top.count} ${top.construct}${top.count === 1 ? "" : "s"} ${top.handling} (see lossy[] above)`,
    );
  }
  help.push(`Open in browser: https://docs.google.com/document/d/${state.id}/edit`);
  blocks.push(renderHelp(help));
  return joinBlocks(...blocks);
}

// ---------------------------------------------------------------------------
// Commands

export async function docsWriteCommand(account: string, args: string[]): Promise<string> {
  const flags = parseWriteFlags(args, "write");
  const markdown = (await readSource(flags)) ?? "";
  const api = await docsClient(account);
  const state = await readState(api, account, flags.documentId!);
  const previousRevision = state.revisionId;

  let tab: TabTarget;
  let tabs: TabInfo[] | undefined;
  if (flags.newTab) {
    // Placement is resolved against the pre-read; an unknown anchor fails here,
    // before the tab exists. No placement → no index → the API appends.
    const placed = flags.placement ? resolvePlacement(flags.placement, state.tabs) : undefined;
    const tabProperties: docs_v1.Schema$TabProperties = { title: flags.newTab };
    if (placed && placed !== "unchanged") {
      tabProperties.index = placed.index;
      if (placed.parent) tabProperties.parentTabId = placed.parent;
    }
    if (flags.emoji !== undefined) tabProperties.iconEmoji = flags.emoji;
    const reply = await batch(
      api,
      account,
      state.id,
      [{ addDocumentTab: { tabProperties } }],
      state.revisionId,
    );
    const props = reply.replies?.[0]?.addDocumentTab?.tabProperties ?? {};
    tab = {
      id: props.tabId ?? "",
      title: props.title ?? flags.newTab,
      index: props.index ?? 0,
      parent: props.parentTabId ?? "",
      emoji: props.iconEmoji ?? "",
      end: 2,
    };
    state.revisionId = reply.writeControl?.requiredRevisionId ?? state.revisionId;
  } else {
    tab = chooseTab(state, flags.tab, "write", account);
  }
  const result = await writeTab(api, account, state, tab, markdown, "replace");
  if (flags.newTab) {
    // The listing is the proof of placement; one properties-only read.
    tabs = (await readState(api, account, state.id, { properties: true })).tabs;
  }
  return render("written", account, result, { previousRevision, newTab: !!flags.newTab, tabs });
}

export async function docsAppendCommand(account: string, args: string[]): Promise<string> {
  const flags = parseWriteFlags(args, "append");
  const markdown = (await readSource(flags)) ?? "";
  if (!markdown.trim()) {
    throw new AxiError("Nothing to append: the content is empty", "VALIDATION_ERROR", [
      "Pass Markdown with some content; `docs write` can empty a tab if that is the intent",
    ]);
  }
  const api = await docsClient(account);
  const state = await readState(api, account, flags.documentId!);
  const previousRevision = state.revisionId;
  const tab = chooseTab(state, flags.tab, "append", account);
  const result = await writeTab(api, account, state, tab, markdown, "append");
  return render("appended", account, result, { previousRevision });
}

export async function docsCreateCommand(account: string, args: string[]): Promise<string> {
  const flags = parseWriteFlags(args, "create");
  const markdown = (await readSource(flags)) ?? "";
  // Parse first: an unfetchable image should fail before a Doc exists.
  parseMarkdown(markdown);

  const drive = await driveClient(account);
  let documentId: string;
  try {
    const res = await drive.files.create({
      requestBody: {
        name: flags.title,
        mimeType: "application/vnd.google-apps.document",
        parents: flags.parent ? [flags.parent] : undefined,
      },
      fields: "id",
      supportsAllDrives: true,
    });
    documentId = res.data.id ?? "";
  } catch (err) {
    const translated = translateGoogleError(err, { account, operation: "drive.files.create" });
    if (translated.code === "NOT_FOUND" && flags.parent) {
      throw new AxiError(
        `Folder '${flags.parent}' not found (or ${account} can't write to it)`,
        "FILE_NOT_FOUND",
        [
          "Verify the folder ID (from a Drive URL, `drive ls`, or `drive mkdir`)",
          `Confirm ${account} has edit access`,
        ],
      );
    }
    throw translated;
  }

  const api = await docsClient(account);
  const state = await readState(api, account, documentId);
  const tab = state.tabs[0] ?? { id: "", title: "", index: 0, parent: "", emoji: "", end: 2 };
  const result = await writeTab(api, account, state, tab, markdown, "replace");
  return render("created", account, result, {});
}
