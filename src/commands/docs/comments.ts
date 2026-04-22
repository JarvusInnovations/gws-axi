import { AxiError } from "axi-sdk-js";
import type { drive_v3 } from "googleapis";
import { driveClient, translateGoogleError } from "../../google/client.js";
import {
  field,
  joinBlocks,
  renderHelp,
  renderList,
  renderObject,
  type FieldDef,
} from "../../output/index.js";

export const COMMENTS_HELP = `usage: gws-axi docs comments <documentId> [flags]
args[1]:
  <documentId>         The Google Doc ID (from the URL after /d/)
flags[4]:
  --include-resolved   Also show comments that have been resolved
  --full               Don't truncate comment/reply bodies (default cap: 500 chars)
  --limit <n>          Max comments to return (default: 50)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi docs comments 1BxAbc...
  gws-axi docs comments 1BxAbc... --include-resolved --full
output:
  A \`comments[N]{id,author,created,resolved,quoted_content,body,reply_count}\`
  list and (when any comment has replies) a sibling \`replies[N]{comment,author,created,body}\`
  table keyed by parent comment id. Bodies and quoted_content are truncated
  at 500 chars unless --full is passed.
notes:
  \`quoted_content\` is the exact text in the doc that the comment is anchored
  to — important for agents to know what the comment is *about*. Comments
  without an anchor (overall-document comments) will have an empty value.
`;

const DEFAULT_LIMIT = 50;
const BODY_TRUNCATE = 500;

interface ParsedFlags {
  documentId: string;
  includeResolved: boolean;
  full: boolean;
  limit: number;
}

function parseFlags(args: string[]): ParsedFlags {
  let documentId: string | undefined;
  let includeResolved = false;
  let full = false;
  let limit = DEFAULT_LIMIT;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--include-resolved":
        includeResolved = true;
        break;
      case "--full":
        full = true;
        break;
      case "--limit":
        limit = Math.max(1, Math.min(100, parseInt(next, 10) || DEFAULT_LIMIT));
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
      ["Usage: gws-axi docs comments <documentId>"],
    );
  }
  return { documentId, includeResolved, full, limit };
}

function truncate(value: string | undefined, max: number): string {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function commentSchema(truncateAt: number): FieldDef[] {
  return [
    field("id"),
    field("author"),
    field("created"),
    field("resolved"),
    {
      name: "quoted_content",
      extract: (item) => truncate(item.quoted_content as string | undefined, truncateAt),
    },
    {
      name: "body",
      extract: (item) => truncate(item.body as string | undefined, truncateAt),
    },
    field("reply_count"),
  ];
}

function replySchema(truncateAt: number): FieldDef[] {
  return [
    field("comment"),
    field("author"),
    field("created"),
    {
      name: "body",
      extract: (item) => truncate(item.body as string | undefined, truncateAt),
    },
  ];
}

export async function docsCommentsCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  const api = await driveClient(account);

  let data: drive_v3.Schema$CommentList;
  try {
    const res = await api.comments.list({
      fileId: flags.documentId,
      includeDeleted: false,
      pageSize: Math.min(100, flags.limit),
      // Request every field we surface. Drive requires explicit `fields`
      // projection on comments.list — the default response omits replies.
      fields:
        "comments(id,content,quotedFileContent,author(displayName,emailAddress),createdTime,modifiedTime,resolved,anchor,replies(id,content,author(displayName,emailAddress),createdTime))",
    });
    data = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "drive.comments.list",
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

  const raw = data.comments ?? [];
  const filtered = flags.includeResolved
    ? raw
    : raw.filter((c) => !c.resolved);

  const truncateAt = flags.full ? Number.POSITIVE_INFINITY : BODY_TRUNCATE;

  const commentRows = filtered.map((c) => ({
    id: c.id ?? "",
    author: c.author?.displayName ?? c.author?.emailAddress ?? "",
    created: c.createdTime ?? "",
    resolved: c.resolved ?? false,
    quoted_content: c.quotedFileContent?.value ?? "",
    body: c.content ?? "",
    reply_count: c.replies?.length ?? 0,
  }));

  const replyRows = filtered.flatMap((c) =>
    (c.replies ?? []).map((r) => ({
      comment: c.id ?? "",
      author: r.author?.displayName ?? r.author?.emailAddress ?? "",
      created: r.createdTime ?? "",
      body: r.content ?? "",
    })),
  );

  const blocks: string[] = [];
  blocks.push(renderObject({ account, document: flags.documentId }));

  if (commentRows.length === 0) {
    blocks.push(renderObject({ comments: [] }));
    blocks.push(
      renderObject({
        message: flags.includeResolved
          ? "no comments on this document"
          : "no open comments (pass --include-resolved to include resolved)",
      }),
    );
  } else {
    blocks.push(renderList("comments", commentRows, commentSchema(truncateAt)));
    if (replyRows.length > 0) {
      blocks.push(renderList("replies", replyRows, replySchema(truncateAt)));
    }
  }

  const suggestions: string[] = [];
  const resolvedHidden = raw.length - filtered.length;
  if (!flags.includeResolved && resolvedHidden > 0) {
    suggestions.push(
      `${resolvedHidden} resolved comment${resolvedHidden === 1 ? "" : "s"} hidden — add --include-resolved to see them`,
    );
  }
  if (commentRows.length > 0 && !flags.full) {
    const someTruncated = commentRows.some(
      (r) =>
        (typeof r.body === "string" && r.body.length > BODY_TRUNCATE) ||
        (typeof r.quoted_content === "string" && r.quoted_content.length > BODY_TRUNCATE),
    );
    if (someTruncated) {
      suggestions.push(`Add --full to see complete bodies / quoted content`);
    }
  }

  if (suggestions.length > 0) blocks.push(renderHelp(suggestions));

  return joinBlocks(...blocks);
}
