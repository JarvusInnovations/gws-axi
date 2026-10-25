import { AxiError } from "axi-sdk-js";
import { driveClient, sheetsClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { type FlagSpec, parseArgs } from "../../util/flags.js";
import { checkOneSource, takeStdin } from "../../util/source.js";
import { type SpreadsheetMeta, type TabInfo, fetchMeta, renderTabs, shellArg } from "./shared.js";
import type { Block } from "./values.js";
import {
  type BlockFlags,
  type WriteOutcome,
  type WritePlan,
  type WriteTarget,
  blockFlags,
  errorHeader,
  errorHelp,
  headerHint,
  inputModeLine,
  loadBlock,
  outcomeBlocks,
  refuseEmptyBlock,
  spreadsheetBlock,
  writePlan,
} from "./write.js";
import { parsedLine } from "./compare.js";

/**
 * `sheets create` (specs/commands/sheets-write.md § create): a spreadsheet
 * born in a folder through Drive, its tabs named, and an optional value block
 * written into the first tab at A1 through `update`'s path.
 */

const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";

export const CREATE_HELP = `usage: gws-axi sheets create --title <title> [<file> | - | --content <values>] [--tab <title>...] [--parent <folderId>] [flags]
args[1]:
  <file> | -           Optional value block for the first tab, written at A1: a
                       local CSV file (.tsv → tab-separated), or - for stdin
flags[9]:
  --title <title>      REQUIRED. The spreadsheet's name
  --content <values>   The value block inline (CSV, or JSON with --json)
  --tab <title>        Name the tabs, repeatable and in order: the first renames
                       Sheet1, the rest are added after it
  --parent <folderId>  Create it inside this Drive folder (default: My Drive)
  --json               The block is a JSON 2-D array of rows: strings, numbers and
                       booleans are typed; null leaves a cell empty
  --tsv                Tab-separated instead of comma-separated (implied by .tsv)
  --raw                Store strings verbatim (RAW). Default parses them as typed
                       (USER_ENTERED): =formulas, dates, numbers, currencies
  --header             The block's first row is a header: freeze row 1, which
                       \`sheets read\` promotes to column names
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi sheets create --title "Q4 Tracker" --account you@example.com
  gws-axi sheets create --title "Q4 Tracker" costs.csv --tab Costs --tab Notes --header --parent 1Fold... --account you@example.com
output:
  action: created, the spreadsheet{id,title,tab,gid,web_view_link}, the seed's
  range and read-back (formulas[], written[], errors[]) when a block was given,
  and the sheets[N]{gid,title,index,rows,cols} listing.
notes:
  NOT idempotent: Drive allows duplicate names, so re-running makes another
  spreadsheet. \`drive upload x.csv --convert\` is the other way in from CSV — it
  hands the file to Google's importer; this command writes the values itself and
  returns the tab's gid and read-back.
`;

export const CREATE_FLAGS: FlagSpec = {
  value: ["--title", "--content", "--tab", "--parent"],
  boolean: ["--json", "--tsv", "--raw", "--header"],
};

const USAGE =
  "gws-axi sheets create --title <title> [<file> | - | --content <values>] [--tab <title>...] [--parent <folderId>]";

export interface CreateFlags extends BlockFlags {
  title: string;
  tabs: string[];
  parent?: string;
  header: boolean;
}

/** Refuse a repeated title in a list of new tabs, before any call. */
export function checkDistinctTitles(titles: string[]): void {
  const seen = new Set<string>();
  for (const t of titles) {
    if (seen.has(t)) {
      throw new AxiError(
        `--tab '${t}' is given twice — tab titles are unique`,
        "VALIDATION_ERROR",
        ["Give each tab title once", "Nothing was created"],
      );
    }
    seen.add(t);
  }
}

export function parseCreateFlags(args: string[]): CreateFlags {
  const parsed = parseArgs(args, CREATE_FLAGS, "sheets create");
  const { stdin, rest } = takeStdin(parsed.positionals);
  if (rest.length > 1) {
    throw new AxiError(`Unexpected argument: ${rest[1]}`, "VALIDATION_ERROR", [`Usage: ${USAGE}`]);
  }
  const title = parsed.values["--title"];
  if (!title) {
    throw new AxiError("--title is required", "VALIDATION_ERROR", [`Usage: ${USAGE}`]);
  }
  const flags: CreateFlags = {
    ...blockFlags(parsed, rest, stdin),
    title,
    tabs: (parsed.lists["--tab"] ?? []).map((t) => t.trim()),
    parent: parsed.values["--parent"],
    header: parsed.booleans.has("--header"),
  };
  if (flags.tabs.some((t) => t === "")) {
    throw new AxiError("--tab needs a title", "VALIDATION_ERROR", [`Usage: ${USAGE}`]);
  }
  checkDistinctTitles(flags.tabs);
  checkOneSource(flags, { optional: true, what: "values", usage: USAGE });
  const hasSource = !!flags.localPath || flags.stdin || flags.content !== undefined;
  if (flags.header && !hasSource) {
    throw new AxiError(
      "--header names a block's first row, and no block was given",
      "VALIDATION_ERROR",
      ["Pass the header row as the block: --content 'Name,Status' --header"],
    );
  }
  return flags;
}

/** Seed a fresh tab at A1 through update's path. */
export async function seedTab(
  target: WriteTarget,
  rows: Block,
  opts: { raw: boolean; header: boolean },
): Promise<{ plan: WritePlan; outcome: WriteOutcome }> {
  const plan: WritePlan = { kind: "block", row0: 0, col0: 0, rows };
  const outcome = await writePlan(target, plan, { ...opts, fresh: true });
  return { plan, outcome };
}

/** The summary and body of a seed write, for create / add-tab responses. */
export function seedBlocks(
  outcome: WriteOutcome | undefined,
  raw: boolean,
): { head: Record<string, unknown>; summary: Record<string, unknown>; blocks: string[] } {
  if (!outcome) return { head: {}, summary: {}, blocks: [] };
  const summary: Record<string, unknown> = { range: outcome.range };
  if (outcome.shape) summary.shape = `${outcome.shape.rows}x${outcome.shape.cols}`;
  summary.cells = outcome.cells;
  if (outcome.grid) summary.grid = outcome.grid;
  if (outcome.header) summary.header = outcome.header;
  summary.input = raw ? "raw" : "user-entered";
  const body = outcomeBlocks(outcome.report, outcome.errors);
  if (body.writtenTotal) summary.written_total = body.writtenTotal;
  return { head: errorHeader(outcome.errors, outcome.errorScan), summary, blocks: body.blocks };
}

/** help[] lines a seed write contributes. */
export function seedHelp(
  outcome: WriteOutcome | undefined,
  plan: WritePlan | undefined,
  ctx: { spreadsheetId: string; tab: TabInfo; account: string; raw: boolean; header: boolean },
  hintCommand: string,
): string[] {
  if (!outcome || !plan) return [];
  const lines = errorHelp(outcome.errors, outcome.formulas, {
    spreadsheetId: ctx.spreadsheetId,
    tabTitle: ctx.tab.title,
    account: ctx.account,
    writtenCells: outcome.writtenCells,
  });
  lines.push(
    inputModeLine(
      ctx.raw,
      plan.kind === "block" &&
        plan.rows.some((r) => r.some((v) => typeof v === "string" && v.startsWith("="))),
    ),
  );
  if (outcome.report.parsed) lines.push(parsedLine(outcome.report.parsed));
  const hint = headerHint(plan, ctx.header, hintCommand);
  if (hint) lines.push(hint);
  return lines;
}

function incomplete(id: string, step: string, err: unknown): AxiError {
  const cause = err instanceof AxiError ? `${err.code}: ${err.message}` : String(err);
  return new AxiError(
    `The spreadsheet ${id} was created, but ${step} failed — ${cause}`,
    "WRITE_INCOMPLETE",
    [
      ...(err instanceof AxiError ? err.suggestions : []),
      `The file exists and is yours: \`gws-axi sheets read ${id}\` shows what was applied`,
      `Run \`gws-axi drive trash ${id}\` to discard it`,
    ],
  );
}

export async function sheetsCreateCommand(account: string, args: string[]): Promise<string> {
  const flags = parseCreateFlags(args);
  // Decode the block before creating anything, so a malformed one creates nothing.
  const block = await loadBlock(flags, { allowObjects: false });
  const rows = block?.kind === "grid" ? block.rows : undefined;
  if (rows) refuseEmptyBlock(rows);

  const drive = await driveClient(account);
  let id: string;
  try {
    const res = await drive.files.create({
      requestBody: {
        name: flags.title,
        mimeType: SPREADSHEET_MIME,
        ...(flags.parent ? { parents: [flags.parent] } : {}),
      },
      fields: "id,name,webViewLink",
      supportsAllDrives: true,
    });
    id = res.data.id as string;
  } catch (err) {
    const translated = translateGoogleError(err, { account, operation: "drive.files.create" });
    if (translated.code === "NOT_FOUND" && flags.parent) {
      throw new AxiError(
        `Folder '${flags.parent}' not found (or ${account} can't add to it)`,
        "FILE_NOT_FOUND",
        [`Run \`gws-axi drive get ${flags.parent}\` to check the folder`, "Nothing was created"],
      );
    }
    throw translated;
  }

  const api = await sheetsClient(account);
  let meta: SpreadsheetMeta;
  let seed: { plan: WritePlan; outcome: WriteOutcome } | undefined;
  try {
    meta = await fetchMeta(api, account, id);
    if (flags.tabs.length > 0) {
      const first = meta.tabs[0];
      await api.spreadsheets.batchUpdate({
        spreadsheetId: id,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId: first.gid, title: flags.tabs[0] },
                fields: "title",
              },
            },
            ...flags.tabs.slice(1).map((title, i) => ({
              addSheet: { properties: { title, index: i + 1 } },
            })),
          ],
        },
      });
      meta = await fetchMeta(api, account, id);
    }
  } catch (err) {
    throw incomplete(id, "naming its tabs", err);
  }
  const firstTab = meta.tabs[0];
  try {
    if (rows) {
      seed = await seedTab({ api, account, meta, tab: firstTab }, rows, {
        raw: flags.raw,
        header: flags.header,
      });
      meta = await fetchMeta(api, account, id);
    }
  } catch (err) {
    throw incomplete(id, "writing the values", err);
  }

  const tab = meta.tabs[0] ?? firstTab;
  const s = seedBlocks(seed?.outcome, flags.raw);
  const tabArg = shellArg(tab.title);
  const help = [
    ...seedHelp(
      seed?.outcome,
      seed?.plan,
      { spreadsheetId: id, tab, account, raw: flags.raw, header: flags.header },
      `gws-axi sheets update ${id} --tab ${tabArg} --range A1 <source> --header --account ${account}`,
    ),
    rows
      ? `Run \`gws-axi sheets read ${id} --tab ${tabArg}\` to read the tab`
      : `Run \`gws-axi sheets update ${id} --tab ${tabArg} --range A1 <file> --account ${account}\` to write values`,
    `Run \`gws-axi sheets add-tab ${id} --title <title> --account ${account}\` to add a tab`,
    `Run \`gws-axi drive share ${id} --with <email> --account ${account}\` to share it`,
    `Re-running creates another spreadsheet (Drive allows duplicate names) — keep this id: ${id}`,
  ];
  const summary = s.summary;
  return joinBlocks(
    renderObject({ account, action: "created", ...s.head }),
    renderObject({ spreadsheet: spreadsheetBlock(meta, tab) }),
    Object.keys(summary).length ? renderObject(summary) : "",
    ...s.blocks,
    renderTabs(meta.tabs),
    renderHelp(help),
  );
}
