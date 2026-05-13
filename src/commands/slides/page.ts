import { AxiError } from "axi-sdk-js";
import type { slides_v1 } from "googleapis";
import { slidesClient, translateGoogleError } from "../../google/client.js";
import {
  joinBlocks,
  renderHelp,
  renderObject,
} from "../../output/index.js";
import { extractSlideContent, isSlidePage } from "./text.js";

export const PAGE_HELP = `usage: gws-axi slides page <presentation-id> <page-id> [flags]
args[2]:
  <presentation-id>    The Slides presentation ID
  <page-id>            The slide's objectId (page_id from \`slides get\`)
flags[1]:
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi slides page 1AbC... gd87cbcb3a4_0_42
output:
  A \`slide{index,page_id,title,image_count,table_count,has_video}\`
  header and \`body\` + (when present) \`speaker_notes\` blocks. The
  body is a single text block joining every shape's/table's visible
  text on the slide in document order.
notes:
  For the full deck use \`slides summarize\`. \`page\` is for one-slide
  reads when the agent already knows which slide it wants (e.g., from
  prior context or a slide-by-slide walk).
`;

interface ParsedFlags {
  presentationId: string;
  pageId: string;
}

function parseFlags(args: string[]): ParsedFlags {
  const positional: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith("--")) positional.push(arg);
  }
  if (positional.length < 2) {
    throw new AxiError(
      "Missing required arguments",
      "VALIDATION_ERROR",
      [
        "Usage: gws-axi slides page <presentation-id> <page-id>",
        "Get the page-id from `gws-axi slides get <presentation-id>` output",
      ],
    );
  }
  return { presentationId: positional[0], pageId: positional[1] };
}

export async function slidesPageCommand(
  account: string,
  args: string[],
): Promise<string> {
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

  const slidePages = (presentation.slides ?? []).filter(isSlidePage);
  const targetIndex = slidePages.findIndex((s) => s.objectId === flags.pageId);
  if (targetIndex === -1) {
    throw new AxiError(
      `Slide '${flags.pageId}' not found in presentation '${flags.presentationId}'`,
      "PAGE_NOT_FOUND",
      [
        `List slides with \`gws-axi slides get ${flags.presentationId}\``,
        `Use a page_id from the slides table`,
      ],
    );
  }

  const content = extractSlideContent(slidePages[targetIndex], targetIndex);

  const blocks: string[] = [];
  blocks.push(renderObject({ account }));
  blocks.push(
    renderObject({
      slide: {
        presentation_id: flags.presentationId,
        index: content.index + 1,
        page_id: content.page_id,
        title: content.title,
        ...(content.image_count > 0 ? { image_count: content.image_count } : {}),
        ...(content.table_count > 0 ? { table_count: content.table_count } : {}),
        ...(content.has_video ? { has_video: true } : {}),
      },
    }),
  );
  if (content.body.length > 0) {
    blocks.push(renderObject({ body: content.body.join("\n\n") }));
  }
  if (content.speaker_notes) {
    blocks.push(renderObject({ speaker_notes: content.speaker_notes }));
  }

  const suggestions: string[] = [];
  if (content.image_count > 0 || content.has_video) {
    suggestions.push(
      `This slide has visual content (${content.image_count > 0 ? `${content.image_count} image${content.image_count === 1 ? "" : "s"}` : ""}${content.image_count > 0 && content.has_video ? ", " : ""}${content.has_video ? "a video" : ""}) — only text content is rendered here`,
    );
  }
  if (targetIndex < slidePages.length - 1) {
    const next = slidePages[targetIndex + 1];
    suggestions.push(
      `Next slide: \`gws-axi slides page ${flags.presentationId} ${next.objectId}\` (slide ${targetIndex + 2}/${slidePages.length})`,
    );
  }
  suggestions.push(
    `Full deck: \`gws-axi slides summarize ${flags.presentationId}\``,
  );
  blocks.push(renderHelp(suggestions));
  return joinBlocks(...blocks);
}
