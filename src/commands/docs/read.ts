import { AxiError } from "axi-sdk-js";
import type { docs_v1 } from "googleapis";
import { docsClient, translateGoogleError } from "../../google/client.js";
import {
  field,
  joinBlocks,
  renderHelp,
  renderList,
  renderObject,
  type FieldDef,
} from "../../output/index.js";
import { renderBodyAsMarkdown } from "./markdown.js";

export const READ_HELP = `usage: gws-axi docs read <documentId> [flags]
args[1]:
  <documentId>         The Google Doc ID (from the URL after /d/)
flags[3]:
  --tab <id>           Tab ID to render (omit for single-tab docs; required for multi-tab)
  --full               Don't truncate the rendered markdown (default cap: 8000 chars)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi docs read 1BxAbc...
  gws-axi docs read 1BxAbc... --tab t.0
  gws-axi docs read 1BxAbc... --tab t.1.0 --full
output:
  A \`document{id,title,tab,revision_id}\` header, a \`tabs[N]{id,title,index,parent,active}\`
  listing (always shown, with ✓ on the active tab if any), and — when a tab is
  rendered — a \`content\` block of GitHub-flavored markdown. Multi-tab docs without
  --tab return only the tabs listing so the agent can pick one.
`;

const DEFAULT_TRUNCATE_CHARS = 8000;

interface ParsedFlags {
  documentId: string;
  tab: string | undefined;
  full: boolean;
}

interface FlatTab {
  id: string;
  title: string;
  index: number;
  parent: string;
  tab: docs_v1.Schema$Tab;
}

function parseFlags(args: string[]): ParsedFlags {
  let documentId: string | undefined;
  let tab: string | undefined;
  let full = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--tab":
        tab = next;
        i++;
        break;
      case "--full":
        full = true;
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
      [
        "Usage: gws-axi docs read <documentId>",
        "The documentId is the portion of the URL after /d/ and before /edit",
      ],
    );
  }
  return { documentId, tab, full };
}

function flattenTabs(
  tabs: docs_v1.Schema$Tab[] | undefined,
  parent = "",
  out: FlatTab[] = [],
): FlatTab[] {
  if (!tabs) return out;
  for (const tab of tabs) {
    const props = tab.tabProperties ?? {};
    out.push({
      id: props.tabId ?? "",
      title: props.title ?? "",
      index: props.index ?? out.length,
      parent,
      tab,
    });
    if (tab.childTabs?.length) {
      flattenTabs(tab.childTabs, props.tabId ?? "", out);
    }
  }
  return out;
}

function tabSchema(activeId: string): FieldDef[] {
  return [
    field("id"),
    field("title"),
    field("index"),
    field("parent"),
    {
      name: "active",
      extract: (item) => (item.id === activeId ? "✓" : ""),
    },
  ];
}

export async function docsReadCommand(
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
    throw translated;
  }

  const flat = flattenTabs(doc.tabs);

  // Choose which tab (if any) to render content for.
  //   - --tab specified: must resolve exactly; error otherwise
  //   - not specified + single tab: render it
  //   - not specified + multiple tabs: disambiguation mode (no content)
  //   - no tabs at all: fall back to document.body (defensive — API with
  //     includeTabsContent should always return at least one tab)
  let activeTab: FlatTab | undefined;
  let contentBody: docs_v1.Schema$Body | undefined;
  let contentLists: Record<string, docs_v1.Schema$List> | undefined;

  if (flags.tab) {
    activeTab = flat.find((t) => t.id === flags.tab);
    if (!activeTab) {
      throw new AxiError(
        `Tab '${flags.tab}' not found in document '${flags.documentId}'`,
        "TAB_NOT_FOUND",
        [
          `Available tabs: ${flat.map((t) => t.id).join(", ") || "(none)"}`,
          `Run \`gws-axi docs read ${flags.documentId}\` (no --tab) to see the full tabs list`,
        ],
      );
    }
    contentBody = activeTab.tab.documentTab?.body ?? undefined;
    contentLists = activeTab.tab.documentTab?.lists ?? undefined;
  } else if (flat.length === 1) {
    activeTab = flat[0];
    contentBody = activeTab.tab.documentTab?.body ?? undefined;
    contentLists = activeTab.tab.documentTab?.lists ?? undefined;
  } else if (flat.length === 0) {
    contentBody = doc.body ?? undefined;
    contentLists = doc.lists ?? undefined;
  }
  // (multi-tab, no --tab) → activeTab stays undefined, contentBody undefined

  const blocks: string[] = [];

  const header: Record<string, unknown> = {
    id: doc.documentId ?? flags.documentId,
    title: doc.title ?? "",
  };
  if (activeTab) header.tab = activeTab.id;
  else if (flat.length > 1) header.tab_count = flat.length;
  if (doc.revisionId) header.revision_id = doc.revisionId;
  blocks.push(renderObject({ document: header }));

  if (flat.length > 0) {
    blocks.push(
      renderList(
        "tabs",
        flat.map((t) => ({
          id: t.id,
          title: t.title,
          index: t.index,
          parent: t.parent,
        })),
        tabSchema(activeTab?.id ?? ""),
      ),
    );
  }

  const suggestions: string[] = [];

  if (contentBody) {
    const rendered = renderBodyAsMarkdown(contentBody, contentLists);
    const total = rendered.markdown.length;
    const cap = flags.full ? Number.POSITIVE_INFINITY : DEFAULT_TRUNCATE_CHARS;
    const truncated = total > cap;
    const content = truncated
      ? `${rendered.markdown.slice(0, cap)}…`
      : rendered.markdown;

    blocks.push(renderObject({ content }));
    if (truncated) {
      blocks.push(
        renderObject({
          content_truncated: true,
          content_total_chars: total,
        }),
      );
      suggestions.push(
        `Run \`gws-axi docs read ${flags.documentId}${activeTab ? ` --tab ${activeTab.id}` : ""} --full\` to see the complete document`,
      );
    }
    if (rendered.image_count > 0) {
      suggestions.push(
        `${rendered.image_count} image${rendered.image_count === 1 ? "" : "s"} rendered as \`[image]\` placeholders — use Drive to view them inline`,
      );
    }
    suggestions.push(
      `Run \`gws-axi docs find ${flags.documentId}${activeTab ? ` --tab ${activeTab.id}` : ""} --query <text>\` to locate text within`,
    );
    suggestions.push(
      `Run \`gws-axi docs comments ${flags.documentId}\` to see review comments`,
    );
  } else if (flat.length > 1) {
    // Multi-tab, no --tab — steer the agent to pick one.
    suggestions.push(
      `This document has ${flat.length} tabs. Run \`gws-axi docs read ${flags.documentId} --tab <id>\` to read one (the id column above).`,
    );
  }

  if (suggestions.length > 0) blocks.push(renderHelp(suggestions));

  return joinBlocks(renderObject({ account }), ...blocks);
}
