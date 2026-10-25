import { AxiError } from "axi-sdk-js";
import { sheetsClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { type FlagSpec, parseArgs } from "../../util/flags.js";
import { checkOneSource, takeStdin } from "../../util/source.js";
import { seedBlocks, seedHelp, seedTab } from "./create.js";
import {
  type SpreadsheetMeta,
  type TabInfo,
  fetchMeta,
  findTab,
  renderTabs,
  shellArg,
  duplicateTitle,
  tabNotFound,
  translateWriteError,
} from "./shared.js";
import {
  type BlockFlags,
  type WriteOutcome,
  type WritePlan,
  blockFlags,
  loadBlock,
  refuseEmptyBlock,
  revisionsLine,
  spreadsheetBlock,
} from "./write.js";

/**
 * `sheets add-tab` (specs/commands/sheets-write.md § add-tab): one new tab,
 * placed where the flags say, optionally seeded at A1. Idempotent by title; a
 * seed that fails deletes the tab again, so a failed call leaves nothing.
 */

export const ADD_TAB_HELP = `usage: gws-axi sheets add-tab <spreadsheetId> --title <title> [<file> | - | --content <values>] [--first | --last | --before <tab> | --after <tab>] [flags]
args[2]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
  <file> | -           Optional value block for the new tab, written at A1: a
                       local CSV file (.tsv → tab-separated), or - for stdin
flags[11]:
  --title <title>      REQUIRED. The new tab's title
  --content <values>   The value block inline (CSV, or JSON with --json)
  --first              Put it first
  --last               Put it last (the default)
  --before <tab>       Put it before this tab (title or gid)
  --after <tab>        Put it after this tab (title or gid)
  --json               The block is a JSON 2-D array of rows: strings, numbers and
                       booleans are typed; null leaves a cell empty
  --tsv                Tab-separated instead of comma-separated (implied by .tsv)
  --raw                Store strings verbatim (RAW). Default parses them as typed
                       (USER_ENTERED): =formulas, dates, numbers, currencies
  --header             The block's first row is a header: freeze row 1, which
                       \`sheets read\` promotes to column names
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi sheets add-tab 1AbC... --title Notes --account you@example.com
  gws-axi sheets add-tab 1AbC... --title Q4 q4.csv --after Q3 --header --account you@example.com
output:
  action: added (or exists), the spreadsheet{id,title,tab,gid,web_view_link},
  the seed's read-back when a block was given, and the sheets[N] listing.
notes:
  Idempotent by title: a tab with that title already there is action: exists,
  and neither placement nor values are applied to it. A value write that fails
  deletes the new tab again.
`;

export const ADD_TAB_FLAGS: FlagSpec = {
  value: ["--title", "--content", "--before", "--after"],
  boolean: ["--first", "--last", "--json", "--tsv", "--raw", "--header"],
};

const USAGE =
  "gws-axi sheets add-tab <spreadsheetId> --title <title> [<file> | - | --content <values>] [--first | --last | --before <tab> | --after <tab>]";

export type TabPlacement =
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "before"; anchor: string }
  | { kind: "after"; anchor: string };

export interface AddTabFlags extends BlockFlags {
  spreadsheetId: string;
  title: string;
  placement: TabPlacement;
  header: boolean;
}

export function parseAddTabFlags(args: string[]): AddTabFlags {
  const parsed = parseArgs(args, ADD_TAB_FLAGS, "sheets add-tab");
  const { stdin, rest } = takeStdin(parsed.positionals);
  const spreadsheetId = rest.shift();
  if (!spreadsheetId) {
    throw new AxiError("Missing spreadsheetId argument", "VALIDATION_ERROR", [`Usage: ${USAGE}`]);
  }
  if (rest.length > 1) {
    throw new AxiError(`Unexpected argument: ${rest[1]}`, "VALIDATION_ERROR", [`Usage: ${USAGE}`]);
  }
  const title = parsed.values["--title"]?.trim();
  if (!title) throw new AxiError("--title is required", "VALIDATION_ERROR", [`Usage: ${USAGE}`]);

  const given = [
    parsed.booleans.has("--first") && "--first",
    parsed.booleans.has("--last") && "--last",
    parsed.values["--before"] !== undefined && "--before",
    parsed.values["--after"] !== undefined && "--after",
  ].filter((f): f is string => !!f);
  if (given.length > 1) {
    throw new AxiError(`${given.join(" and ")} are mutually exclusive`, "VALIDATION_ERROR", [
      "Pick one position: --first, --last, --before <tab>, or --after <tab>",
    ]);
  }
  let placement: TabPlacement = { kind: "last" };
  if (parsed.booleans.has("--first")) placement = { kind: "first" };
  else if (parsed.values["--before"] !== undefined)
    placement = { kind: "before", anchor: parsed.values["--before"] };
  else if (parsed.values["--after"] !== undefined)
    placement = { kind: "after", anchor: parsed.values["--after"] };

  const flags: AddTabFlags = {
    ...blockFlags(parsed, rest, stdin),
    spreadsheetId,
    title,
    placement,
    header: parsed.booleans.has("--header"),
  };
  checkOneSource(flags, { optional: true, what: "values", usage: USAGE });
  if (flags.header && !flags.localPath && !flags.stdin && flags.content === undefined) {
    throw new AxiError(
      "--header names a block's first row, and no block was given",
      "VALIDATION_ERROR",
      ["Pass the header row as the block: --content 'Name,Status' --header"],
    );
  }
  return flags;
}

/**
 * The `index` addSheet takes: `--first` → 0, `--last` → the sheet count,
 * `--before X` → X's index, `--after X` → X's index + 1.
 */
export function placementIndex(meta: SpreadsheetMeta, placement: TabPlacement): number {
  switch (placement.kind) {
    case "first":
      return 0;
    case "last":
      return meta.tabs.length + meta.otherTitles.length;
    case "before":
    case "after": {
      const anchor = findTab(meta.tabs, placement.anchor);
      if (!anchor) throw tabNotFound(meta, placement.anchor, `--${placement.kind} tab`);
      return placement.kind === "before" ? anchor.index : anchor.index + 1;
    }
  }
}

export async function sheetsAddTabCommand(account: string, args: string[]): Promise<string> {
  const flags = parseAddTabFlags(args);
  const block = await loadBlock(flags, { allowObjects: false });
  const rows = block?.kind === "grid" ? block.rows : undefined;
  if (rows) refuseEmptyBlock(rows);

  const api = await sheetsClient(account);
  let meta = await fetchMeta(api, account, flags.spreadsheetId);
  const id = meta.id;

  // Titles are unique case-insensitively, across every sheet (observed).
  const same = (t: string) => t.toLowerCase() === flags.title.toLowerCase();
  const chart = meta.otherTitles.find(same);
  if (chart !== undefined) {
    throw new AxiError(
      `'${chart}' is a chart sheet, and tab titles are unique (ignoring case) — there is no grid to write into`,
      "VALIDATION_ERROR",
      ["Pick another --title", "Nothing was added"],
    );
  }
  const existing = meta.tabs.find((t) => same(t.title));
  if (existing) {
    const tabArg = shellArg(existing.title);
    return joinBlocks(
      renderObject({ account, action: "exists" }),
      renderObject({ spreadsheet: spreadsheetBlock(meta, existing) }),
      renderTabs(meta.tabs),
      renderHelp([
        `A tab titled '${existing.title}' already exists (gid ${existing.gid}); placement flags and the value block were NOT applied`,
        `Run \`gws-axi sheets update ${id} --tab ${tabArg} --range A1 <file> --account ${account}\` to write into it`,
      ]),
    );
  }

  const index = placementIndex(meta, flags.placement);
  let gid: number;
  try {
    const res = await api.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: { requests: [{ addSheet: { properties: { title: flags.title, index } } }] },
    });
    gid = res.data.replies?.[0]?.addSheet?.properties?.sheetId as number;
  } catch (err) {
    throw (
      duplicateTitle(err, flags.title) ??
      translateWriteError(err, {
        account,
        operation: "sheets.spreadsheets.batchUpdate(addSheet)",
        spreadsheetId: id,
        range: flags.title,
      })
    );
  }

  let seed: { plan: WritePlan; outcome: WriteOutcome } | undefined;
  if (rows) {
    try {
      // Inside the try: a failure anywhere after addSheet must roll the tab back.
      meta = await fetchMeta(api, account, id);
      const tab = meta.tabs.find((t) => t.gid === gid) as TabInfo;
      seed = await seedTab({ api, account, meta, tab }, rows, {
        raw: flags.raw,
        header: flags.header,
      });
    } catch (err) {
      throw await rollBack(
        async () => {
          await api.spreadsheets.batchUpdate({
            spreadsheetId: id,
            requestBody: { requests: [{ deleteSheet: { sheetId: gid } }] },
          });
        },
        { spreadsheetId: id, gid, title: flags.title, account },
        err,
      );
    }
  }

  meta = await fetchMeta(api, account, id);
  const tab = meta.tabs.find((t) => t.gid === gid) ?? meta.tabs[meta.tabs.length - 1];
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
    revisionsLine(id),
  ];
  return joinBlocks(
    renderObject({ account, action: "added", ...s.head }),
    renderObject({ spreadsheet: spreadsheetBlock(meta, tab) }),
    Object.keys(s.summary).length ? renderObject(s.summary) : "",
    ...s.blocks,
    renderTabs(meta.tabs),
    renderHelp(help),
  );
}

/**
 * Delete the tab a failed seed left, then report the seed's failure. A tab
 * that cannot be deleted is WRITE_INCOMPLETE, naming it.
 */
export async function rollBack(
  deleteTab: () => Promise<void>,
  tab: { spreadsheetId: string; gid: number; title: string; account: string },
  cause: unknown,
): Promise<AxiError> {
  const { spreadsheetId, gid, title } = tab;
  const why =
    cause instanceof AxiError
      ? cause
      : translateGoogleError(cause, { account: tab.account, operation: "sheets seed write" });
  try {
    await deleteTab();
  } catch {
    return new AxiError(
      `The tab '${title}' (gid ${gid}) was added, but writing its values failed (${why.code}: ${why.message}) and the tab could not be deleted again`,
      "WRITE_INCOMPLETE",
      [
        ...why.suggestions,
        `Remove the empty tab '${title}' (gid ${gid}) by hand in the editor, or write into it with \`gws-axi sheets update ${spreadsheetId} --tab ${shellArg(title)} --range A1 …\``,
      ],
    );
  }
  return new AxiError(
    `${why.message} — the new tab '${title}' was deleted again; the spreadsheet is as it was`,
    why.code,
    why.suggestions,
  );
}
