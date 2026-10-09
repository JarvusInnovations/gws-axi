import { AxiError } from "axi-sdk-js";
import type { docs_v1 } from "googleapis";
import { docsClient, translateGoogleError } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { type FlagSpec, parseArgs } from "../../util/flags.js";
import { type RawMatch, buildContext, collectMatches } from "./find.js";
import { type TabInfo, describeTabs, flattenTabInfos, renderTabListing } from "./tabs.js";
import { batch } from "./write.js";

/**
 * `docs replace-text` (specs/commands/docs-replace-text.md): the Docs API's
 * replaceAllText scoped to one tab, behind a local count that refuses an
 * ambiguous replacement. Formatting is untouched — the replacement takes the
 * style of what it replaces.
 */

export const REPLACE_TEXT_HELP = `usage: gws-axi docs replace-text <documentId> --find <text> --replace <text> [--tab <id>] [--all] [--ignore-case] [flags]
args[1]:
  <documentId>         The Doc to edit
flags[6]:
  --find <text>        REQUIRED. The literal text to replace (no patterns)
  --replace <text>     REQUIRED. The replacement; "" deletes the matched text
  --tab <id>           The tab to edit (id as \`docs tabs\` lists it). Omit on a
                       single-tab Doc; required on a multi-tab Doc.
  --all                Replace every occurrence. Without it, 2+ matches are refused
  --ignore-case        Match regardless of case (default: exact case)
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi docs replace-text 1BxAbc... --find "Generating" --replace "Refining" --tab t.k3j2 --account you@example.com
  gws-axi docs replace-text 1BxAbc... --find "v2" --replace "v3" --all --account you@example.com
  gws-axi docs replace-text 1BxAbc... --find " (draft)" --replace "" --account you@example.com
notes:
  Changes only the matched text, in one tab, keeping every style around it
  (bold stays bold, a link stays a link) — the formatting-safe alternative to
  rewriting the tab with \`docs write\`. Matches are counted first: none is
  action: no_match, more than one is MULTIPLE_MATCHES unless --all. The
  response lists each occurrence as it read before the change. Refused if the
  Doc changed since it was read.
`;

export const REPLACE_TEXT_FLAGS: FlagSpec = {
  value: ["--find", "--replace", "--tab"],
  boolean: ["--all", "--ignore-case"],
};

export interface ReplaceFlags {
  documentId: string;
  find: string;
  replace: string;
  tab?: string;
  all: boolean;
  ignoreCase: boolean;
}

const USAGE = "gws-axi docs replace-text <documentId> --find <text> --replace <text> [--tab <id>]";

export function parseReplaceFlags(args: string[]): ReplaceFlags {
  const parsed = parseArgs(args, REPLACE_TEXT_FLAGS, "docs replace-text");
  const documentId = parsed.positionals[0];
  if (!documentId) {
    throw new AxiError("Missing documentId argument", "VALIDATION_ERROR", [
      `Usage: ${USAGE}`,
      "The documentId is the portion of the URL after /d/ and before /edit",
    ]);
  }
  if (parsed.positionals.length > 1) {
    throw new AxiError(`Unexpected argument: ${parsed.positionals[1]}`, "VALIDATION_ERROR", [
      `Usage: ${USAGE}`,
    ]);
  }
  const find = parsed.values["--find"];
  const replace = parsed.values["--replace"];
  if (find === undefined || replace === undefined) {
    throw new AxiError(
      `Missing ${find === undefined ? "--find" : "--replace"}`,
      "VALIDATION_ERROR",
      [`Usage: ${USAGE}`, 'Pass --replace "" to delete the matched text'],
    );
  }
  if (!find) {
    throw new AxiError("--find can't be empty", "VALIDATION_ERROR", [
      "Pass the literal text to replace",
    ]);
  }
  return {
    documentId,
    find,
    replace,
    tab: parsed.values["--tab"],
    all: parsed.booleans.has("--all"),
    ignoreCase: parsed.booleans.has("--ignore-case"),
  };
}

// ---------------------------------------------------------------------------

interface Target {
  tab: TabInfo;
  /** Every segment of the tab: body, headers, footers, footnotes. */
  segments: docs_v1.Schema$StructuralElement[][];
}

async function fetchDocument(
  api: docs_v1.Docs,
  account: string,
  documentId: string,
): Promise<docs_v1.Schema$Document> {
  try {
    const res = await api.documents.get({ documentId, includeTabsContent: true });
    return res.data;
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
        `'${documentId}' is not a native Google Doc — the Docs API can't edit it`,
        "NON_NATIVE_DOCUMENT",
        ["Open it in Drive and use File → Save as Google Docs, then edit the new Doc"],
      );
    }
    throw translated;
  }
}

function chooseTarget(
  doc: docs_v1.Schema$Document,
  requested: string | undefined,
  account: string,
): Target {
  const infos = flattenTabInfos(doc.tabs ?? undefined);
  const byId = new Map<string, docs_v1.Schema$Tab>();
  const walk = (tabs: docs_v1.Schema$Tab[] | undefined) => {
    for (const t of tabs ?? []) {
      byId.set(t.tabProperties?.tabId ?? "", t);
      walk(t.childTabs ?? undefined);
    }
  };
  walk(doc.tabs ?? undefined);

  let tab: TabInfo | undefined;
  if (requested) {
    tab = infos.find((t) => t.id === requested);
    if (!tab) {
      throw new AxiError(
        `Tab '${requested}' not found in document '${doc.documentId}'`,
        "TAB_NOT_FOUND",
        [
          `Available tabs: ${describeTabs(infos)}`,
          `Run \`gws-axi docs tabs ${doc.documentId}\` to see the tabs list`,
        ],
      );
    }
  } else if (infos.length === 1) {
    tab = infos[0];
  } else {
    throw new AxiError(
      `Document '${doc.documentId}' has ${infos.length} tabs — pass --tab <id> to choose one`,
      "TAB_REQUIRED",
      [
        renderTabListing(infos),
        `Run \`gws-axi docs replace-text ${doc.documentId} --find <text> --replace <text> --tab <id> --account ${account}\` with one of the ids above`,
        "Nothing was written",
      ],
    );
  }
  const dt = byId.get(tab.id)?.documentTab ?? {};
  const segments: docs_v1.Schema$StructuralElement[][] = [dt.body?.content ?? []];
  for (const group of [dt.headers, dt.footers, dt.footnotes]) {
    for (const seg of Object.values(group ?? {})) segments.push(seg.content ?? []);
  }
  return { tab, segments };
}

function matchRows(matches: RawMatch[], findLength: number): Array<Record<string, unknown>> {
  return matches.map((m) => ({
    paragraph: m.paragraph,
    context: buildContext(m.paragraphText, m.offsetInParagraph, findLength),
  }));
}

const MATCH_SCHEMA = [field("paragraph"), field("context")];

export async function docsReplaceTextCommand(account: string, args: string[]): Promise<string> {
  const flags = parseReplaceFlags(args);
  const api = await docsClient(account);
  const doc = await fetchDocument(api, account, flags.documentId);
  const documentId = doc.documentId ?? flags.documentId;
  const revisionBefore = doc.revisionId ?? "";
  const { tab, segments } = chooseTarget(doc, flags.tab, account);

  const matches = segments.flatMap((seg) =>
    collectMatches(seg, flags.find, { matchCase: !flags.ignoreCase }),
  );
  const document = {
    id: documentId,
    title: doc.title ?? "",
    tab: tab.id,
    tab_title: tab.title,
  };
  const scope = `${JSON.stringify(flags.find)} (${flags.ignoreCase ? "ignoring case" : "case-sensitive"}) in tab ${tab.id}`;

  if (matches.length === 0) {
    return joinBlocks(
      renderObject({ account, action: "no_match" }),
      renderObject({ document: { ...document, revision_id: revisionBefore }, occurrences: 0 }),
      renderObject({ searched: scope }),
      renderHelp([
        `Run \`gws-axi docs find ${documentId} --query ${JSON.stringify(flags.find)} --tab ${tab.id}\` to look for near-misses (case-insensitive)`,
        ...(flags.ignoreCase ? [] : ["Pass --ignore-case to match regardless of case"]),
      ]),
    );
  }
  if (matches.length > 1 && !flags.all) {
    throw new AxiError(
      `${JSON.stringify(flags.find)} occurs ${matches.length} times in tab ${tab.id} — nothing was written`,
      "MULTIPLE_MATCHES",
      [
        renderList("matches", matchRows(matches, flags.find.length), MATCH_SCHEMA),
        `Run the same command with --all to replace all ${matches.length}`,
        "Or make --find longer (include the words around the one you mean) so it matches once",
      ],
    );
  }

  const reply = await batch(
    api,
    account,
    documentId,
    [
      {
        replaceAllText: {
          containsText: { text: flags.find, matchCase: !flags.ignoreCase },
          replaceText: flags.replace,
          tabsCriteria: { tabIds: [tab.id] },
        },
      },
    ],
    revisionBefore,
  );
  const changed = reply.replies?.[0]?.replaceAllText?.occurrencesChanged ?? matches.length;
  const revisionAfter = reply.writeControl?.requiredRevisionId ?? revisionBefore;

  const blocks: string[] = [
    renderObject({ account, action: "replaced" }),
    renderObject({ document: { ...document, revision_id: revisionAfter }, occurrences: changed }),
  ];
  if (changed !== matches.length) {
    blocks.push(
      renderObject({
        occurrences_note: `${matches.length} counted before the write, ${changed} reported replaced`,
      }),
    );
  }
  blocks.push(renderList("matches", matchRows(matches, flags.find.length), MATCH_SCHEMA));
  const help = [
    `Verify: \`gws-axi docs read ${documentId} --tab ${tab.id}\``,
    `Compare with the version before: \`gws-axi docs diff ${documentId} ${revisionBefore}\``,
  ];
  if (flags.replace) {
    help.push(
      `Undo (if ${JSON.stringify(flags.replace)} did not already occur in the tab): \`gws-axi docs replace-text ${documentId} --find ${JSON.stringify(flags.replace)} --replace ${JSON.stringify(flags.find)} --tab ${tab.id} --all --account ${account}\``,
    );
  }
  blocks.push(renderHelp(help));
  return joinBlocks(...blocks);
}
