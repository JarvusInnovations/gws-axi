import { AxiError } from "axi-sdk-js";
import type { slides_v1 } from "googleapis";
import { slidesClient, translateGoogleError } from "../../google/client.js";
import {
  field,
  joinBlocks,
  renderHelp,
  renderList,
  renderObject,
  type FieldDef,
} from "../../output/index.js";
import { extractSlideContent, isSlidePage } from "./text.js";

export const GET_HELP = `usage: gws-axi slides get <presentation-id> [flags]
args[1]:
  <presentation-id>    The Slides presentation ID (from the URL after /d/)
flags[1]:
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi slides get 1AbC...
output:
  A \`presentation{id,title,slide_count,revision_id}\` header and a
  \`slides[N]{index,page_id,title}\` table — one row per slide. Use this
  to pick a target page_id for \`slides page <pres-id> <page-id>\`, or
  go straight to \`slides summarize <pres-id>\` for the full content.
notes:
  This is light metadata only — no slide bodies or speaker notes.
  For the full deck contents, use \`slides summarize\`.
`;

interface ParsedFlags {
  presentationId: string;
}

function parseFlags(args: string[]): ParsedFlags {
  let presentationId: string | undefined;
  for (const arg of args) {
    if (!arg.startsWith("--") && presentationId === undefined) {
      presentationId = arg;
    }
  }
  if (!presentationId) {
    throw new AxiError("Missing presentationId argument", "VALIDATION_ERROR", [
      "Usage: gws-axi slides get <presentation-id>",
    ]);
  }
  return { presentationId };
}

function slideRowSchema(): FieldDef[] {
  return [field("index"), field("page_id"), field("title")];
}

export async function slidesGetCommand(account: string, args: string[]): Promise<string> {
  const flags = parseFlags(args);
  const api = await slidesClient(account);

  let presentation: slides_v1.Schema$Presentation;
  try {
    const res = await api.presentations.get({
      presentationId: flags.presentationId,
    });
    presentation = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "slides.presentations.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `Presentation '${flags.presentationId}' not found (or ${account} doesn't have access)`,
        "PRESENTATION_NOT_FOUND",
        [
          `Verify the presentation ID is correct (the portion of the URL after /d/)`,
          `Confirm ${account} has at least view access`,
        ],
      );
    }
    throw translated;
  }

  const slides = (presentation.slides ?? []).filter(isSlidePage);
  const rows = slides.map((s, i) => {
    const content = extractSlideContent(s, i);
    return {
      index: i + 1,
      page_id: content.page_id,
      title: content.title,
    };
  });

  const blocks: string[] = [];
  blocks.push(renderObject({ account }));
  blocks.push(
    renderObject({
      presentation: {
        id: presentation.presentationId ?? flags.presentationId,
        title: presentation.title ?? "",
        slide_count: slides.length,
        ...(presentation.revisionId ? { revision_id: presentation.revisionId } : {}),
      },
    }),
  );

  if (rows.length === 0) {
    blocks.push(renderObject({ slides: "no slides in this presentation" }));
  } else {
    blocks.push(renderList("slides", rows, slideRowSchema()));
  }

  const suggestions: string[] = [];
  if (rows.length > 0) {
    suggestions.push(
      `Run \`gws-axi slides summarize ${flags.presentationId}\` to render the full deck as markdown (titles, body text, speaker notes)`,
    );
    suggestions.push(
      `Run \`gws-axi slides page ${flags.presentationId} <page-id>\` for just one slide (use any page_id from the slides table)`,
    );
  }
  if (suggestions.length > 0) blocks.push(renderHelp(suggestions));

  return joinBlocks(...blocks);
}
