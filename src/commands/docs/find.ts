import { AxiError } from "axi-sdk-js";
import type { docs_v1 } from "googleapis";
import { docsClient, translateGoogleError } from "../../google/client.js";
import {
  field,
  joinBlocks,
  renderHelp,
  renderListResponse,
  renderObject,
} from "../../output/index.js";

export const FIND_HELP = `usage: gws-axi docs find <documentId> --query <text> [flags]
args[1]:
  <documentId>         The Google Doc ID (from the URL after /d/)
flags[4]:
  --query <text>       Text to search for (case-insensitive; required)
  --tab <id>           Tab to search within (default: first tab)
  --limit <n>          Max matches to return (default: 50)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi docs find 1BxAbc... --query "sprint goal"
  gws-axi docs find 1BxAbc... --query foo --tab t.1 --limit 10
output:
  A \`matches[N]{ref,paragraph,start,end,context}\` table. The \`ref\`
  column holds compact \`@N\` handles that future mutation subcommands
  (insert-text, delete-range) will accept as shorthand for the matched
  range. \`start\` and \`end\` are raw Docs API character offsets.
notes:
  Search is restricted to one tab per call — v1 does not fan out across
  sibling tabs. Use \`gws-axi docs read <id>\` (no --tab) to see the tabs
  list and pick one.
`;

const DEFAULT_LIMIT = 50;
const CONTEXT_RADIUS = 40;

interface ParsedFlags {
  documentId: string;
  query: string;
  tab: string | undefined;
  limit: number;
}

interface RawMatch {
  paragraph: number;
  start: number;
  end: number;
  paragraphText: string;
  offsetInParagraph: number;
}

function parseFlags(args: string[]): ParsedFlags {
  let documentId: string | undefined;
  let query: string | undefined;
  let tab: string | undefined;
  let limit = DEFAULT_LIMIT;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--query":
        query = next;
        i++;
        break;
      case "--tab":
        tab = next;
        i++;
        break;
      case "--limit":
        limit = Math.max(1, Math.min(500, parseInt(next, 10) || DEFAULT_LIMIT));
        i++;
        break;
      default:
        if (!arg.startsWith("--") && documentId === undefined) {
          documentId = arg;
        }
    }
  }
  if (!documentId) {
    throw new AxiError(
      "Missing documentId argument",
      "VALIDATION_ERROR",
      ["Usage: gws-axi docs find <documentId> --query <text>"],
    );
  }
  if (!query) {
    throw new AxiError(
      "Missing --query flag",
      "VALIDATION_ERROR",
      ["Usage: gws-axi docs find <documentId> --query <text>"],
    );
  }
  return { documentId, query, tab, limit };
}

function flatTabIndex(doc: docs_v1.Schema$Document): Map<string, docs_v1.Schema$Tab> {
  const out = new Map<string, docs_v1.Schema$Tab>();
  const walk = (tabs: docs_v1.Schema$Tab[] | undefined): void => {
    if (!tabs) return;
    for (const t of tabs) {
      const id = t.tabProperties?.tabId;
      if (id) out.set(id, t);
      if (t.childTabs?.length) walk(t.childTabs);
    }
  };
  walk(doc.tabs);
  return out;
}

// Walk the body and, for each paragraph, collect the concatenated text plus
// the global start index of each contributing text run so we can resolve
// match offsets back to Docs API character positions (used by mutations).
function findMatches(
  body: docs_v1.Schema$Body | undefined,
  query: string,
  limit: number,
): RawMatch[] {
  if (!body?.content) return [];
  const needle = query.toLowerCase();
  const matches: RawMatch[] = [];
  let paragraphIndex = 0;

  for (const el of body.content) {
    if (!el.paragraph) continue;
    const para = el.paragraph;

    let paraText = "";
    const runOffsets: Array<{ paraOffset: number; docOffset: number }> = [];
    for (const pe of para.elements ?? []) {
      if (!pe.textRun) continue;
      const content = pe.textRun.content ?? "";
      const docStart = pe.startIndex ?? 0;
      runOffsets.push({ paraOffset: paraText.length, docOffset: docStart });
      paraText += content;
    }

    let scanFrom = 0;
    while (scanFrom < paraText.length && matches.length < limit) {
      const hit = paraText.toLowerCase().indexOf(needle, scanFrom);
      if (hit === -1) break;
      // Translate the paragraph-local offset back to a document offset by
      // finding the run this hit falls inside.
      let docStart = 0;
      for (let i = runOffsets.length - 1; i >= 0; i--) {
        if (runOffsets[i].paraOffset <= hit) {
          docStart = runOffsets[i].docOffset + (hit - runOffsets[i].paraOffset);
          break;
        }
      }
      matches.push({
        paragraph: paragraphIndex,
        start: docStart,
        end: docStart + needle.length,
        paragraphText: paraText,
        offsetInParagraph: hit,
      });
      scanFrom = hit + needle.length;
    }

    paragraphIndex += 1;
    if (matches.length >= limit) break;
  }

  return matches;
}

function buildContext(paragraphText: string, offset: number, queryLength: number): string {
  const before = paragraphText.slice(Math.max(0, offset - CONTEXT_RADIUS), offset);
  const hit = paragraphText.slice(offset, offset + queryLength);
  const after = paragraphText.slice(
    offset + queryLength,
    Math.min(paragraphText.length, offset + queryLength + CONTEXT_RADIUS),
  );
  const leading = offset > CONTEXT_RADIUS ? "…" : "";
  const trailing =
    offset + queryLength + CONTEXT_RADIUS < paragraphText.length ? "…" : "";
  return `${leading}${before}${hit}${after}${trailing}`.replace(/\s+/g, " ").trim();
}

export async function docsFindCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  const api = await docsClient(account);

  let doc: docs_v1.Schema$Document;
  try {
    const res = await api.documents.get({
      documentId: flags.documentId,
      includeTabsContent: true,
    });
    doc = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "docs.documents.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `Document '${flags.documentId}' not found (or ${account} doesn't have access)`,
        "DOCUMENT_NOT_FOUND",
        [
          `Verify the document ID is correct (the portion of the URL after /d/)`,
          `Confirm ${account} has at least view access to the document`,
        ],
      );
    }
    if (translated.code === "OPERATION_NOT_SUPPORTED") {
      throw new AxiError(
        `'${flags.documentId}' is not a native Google Doc — the Docs API can't search it directly`,
        "NON_NATIVE_DOCUMENT",
        [
          `Run \`gws-axi docs download ${flags.documentId}\` to fetch the raw file and grep it locally`,
          `Or open in Drive, use File → Save as Google Docs to convert, then retry`,
        ],
      );
    }
    throw translated;
  }

  const tabs = flatTabIndex(doc);
  let targetTabId: string;
  let body: docs_v1.Schema$Body | undefined;

  if (flags.tab) {
    const found = tabs.get(flags.tab);
    if (!found) {
      throw new AxiError(
        `Tab '${flags.tab}' not found in document '${flags.documentId}'`,
        "TAB_NOT_FOUND",
        [
          `Available tabs: ${[...tabs.keys()].join(", ") || "(none)"}`,
          `Run \`gws-axi docs read ${flags.documentId}\` to see the full tabs list`,
        ],
      );
    }
    targetTabId = flags.tab;
    body = found.documentTab?.body ?? undefined;
  } else if (tabs.size > 0) {
    const first = [...tabs.values()][0];
    targetTabId = first.tabProperties?.tabId ?? "";
    body = first.documentTab?.body ?? undefined;
  } else {
    targetTabId = "";
    body = doc.body ?? undefined;
  }

  const raw = findMatches(body, flags.query, flags.limit);
  const items = raw.map((m, i) => ({
    ref: `@${i + 1}`,
    paragraph: m.paragraph,
    start: m.start,
    end: m.end,
    context: buildContext(m.paragraphText, m.offsetInParagraph, flags.query.length),
  }));

  const schema = [
    field("ref"),
    field("paragraph"),
    field("start"),
    field("end"),
    field("context"),
  ];

  const docHeader: Record<string, unknown> = { id: flags.documentId };
  if (targetTabId) docHeader.tab = targetTabId;

  const suggestions: string[] = [];
  if (items.length > 0 && items.length >= flags.limit) {
    suggestions.push(
      `Hit --limit ${flags.limit} — increase it to see more matches`,
    );
  }
  if (items.length > 0 && tabs.size > 1) {
    suggestions.push(
      `Search is scoped to one tab (${targetTabId}) — use --tab <id> to search a different tab`,
    );
  }

  const listBlock = renderListResponse({
    header: docHeader,
    name: "matches",
    items,
    schema,
    emptyMessage:
      tabs.size > 1
        ? `no matches for "${flags.query}" in tab ${targetTabId} (try --tab <id> for other tabs)`
        : `no matches for "${flags.query}" in this document`,
  });

  return joinBlocks(
    renderObject({ account }),
    listBlock,
    renderHelp(suggestions),
  );
}
