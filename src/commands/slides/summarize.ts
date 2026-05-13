import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { slides_v1 } from "googleapis";
import { slidesClient, translateGoogleError } from "../../google/client.js";
import {
  joinBlocks,
  renderHelp,
  renderObject,
} from "../../output/index.js";
import { resolveOutputPath } from "../../util/paths.js";
import {
  extractSlideContent,
  isSlidePage,
  type SlideContent,
} from "./text.js";

export const SUMMARIZE_HELP = `usage: gws-axi slides summarize <presentation-id> [flags]
args[1]:
  <presentation-id>    The Slides presentation ID
flags[3]:
  --full               Bypass the 8000-char truncation threshold and emit
                       the complete deck inline.
  --out <path>         Write the full deck markdown to a file instead of
                       embedding it inline (implies --full).
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi slides summarize 1AbC...
  gws-axi slides summarize 1AbC... --full
  gws-axi slides summarize 1AbC... --out ./deck.md
output:
  A \`presentation{id,title,slide_count}\` header, then either a
  \`content\` block of GitHub-flavored markdown (one \`## N. Title\`
  section per slide with body + speaker notes) — or a \`saved\` path
  when --out is set. Same truncation pattern as \`docs read\`: default
  8000-char cap with --full / --out as escape hatches.
`;

const DEFAULT_TRUNCATE_CHARS = 8000;

interface ParsedFlags {
  presentationId: string;
  full: boolean;
  out: string | undefined;
}

function parseFlags(args: string[]): ParsedFlags {
  let presentationId: string | undefined;
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
        if (!arg.startsWith("--") && presentationId === undefined) {
          presentationId = arg;
        }
    }
  }
  if (!presentationId) {
    throw new AxiError(
      "Missing presentationId argument",
      "VALIDATION_ERROR",
      ["Usage: gws-axi slides summarize <presentation-id>"],
    );
  }
  if (out) full = true;
  return { presentationId, full, out };
}

function renderDeckAsMarkdown(
  presentation: slides_v1.Schema$Presentation,
  slides: SlideContent[],
): string {
  const lines: string[] = [];
  lines.push(`# ${presentation.title || "(untitled deck)"}`, "");
  lines.push(`${slides.length} slides`, "");
  lines.push("---", "");
  for (const s of slides) {
    const heading = s.title ? `${s.index + 1}. ${s.title}` : `Slide ${s.index + 1}`;
    lines.push(`## ${heading}`, "");
    if (s.body.length > 0) {
      lines.push(s.body.join("\n\n"), "");
    }
    if (s.speaker_notes) {
      lines.push("**Speaker notes:**", "", s.speaker_notes, "");
    }
    if (s.image_count > 0 || s.table_count > 0 || s.has_video) {
      const visuals: string[] = [];
      if (s.image_count > 0)
        visuals.push(`${s.image_count} image${s.image_count === 1 ? "" : "s"}`);
      if (s.table_count > 0)
        visuals.push(`${s.table_count} table${s.table_count === 1 ? "" : "s"}`);
      if (s.has_video) visuals.push("video");
      lines.push(`_visuals: ${visuals.join(", ")}_`, "");
    }
    lines.push("---", "");
  }
  return lines.join("\n");
}

export async function slidesSummarizeCommand(
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
  const slides = slidePages.map((s, i) => extractSlideContent(s, i));
  const markdown = renderDeckAsMarkdown(presentation, slides);
  const total = markdown.length;

  const blocks: string[] = [];
  blocks.push(renderObject({ account }));
  blocks.push(
    renderObject({
      presentation: {
        id: presentation.presentationId ?? flags.presentationId,
        title: presentation.title ?? "",
        slide_count: slides.length,
      },
    }),
  );

  if (flags.out) {
    const defaultName = `${presentation.title || presentation.presentationId || "deck"}.md`;
    const outPath = await resolveOutputPath(flags.out, defaultName);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, markdown);
    blocks.push(
      renderObject({
        saved: outPath,
        content_total_chars: total,
      }),
    );
  } else {
    const cap = flags.full ? Number.POSITIVE_INFINITY : DEFAULT_TRUNCATE_CHARS;
    const truncated = total > cap;
    const content = truncated ? `${markdown.slice(0, cap)}…` : markdown;
    blocks.push(renderObject({ content }));
    if (truncated) {
      blocks.push(
        renderObject({
          content_truncated: true,
          content_total_chars: total,
        }),
      );
    }
  }

  const suggestions: string[] = [];
  const totalImages = slides.reduce((a, s) => a + s.image_count, 0);
  const totalTables = slides.reduce((a, s) => a + s.table_count, 0);
  if (totalImages > 0) {
    suggestions.push(
      `${totalImages} image${totalImages === 1 ? "" : "s"} across the deck — text-only summary; use \`docs download ${flags.presentationId} --as application/pdf\` to fetch a visual version`,
    );
  }
  if (totalTables > 0) {
    suggestions.push(
      `${totalTables} table${totalTables === 1 ? "" : "s"} rendered as pipe-delimited rows (best-effort — Slides tables are layout-heavy)`,
    );
  }
  if (!flags.out && total > DEFAULT_TRUNCATE_CHARS && !flags.full) {
    suggestions.push(
      `Run \`gws-axi slides summarize ${flags.presentationId} --out <path>\` to save the complete deck, or --full to expand inline`,
    );
  }
  suggestions.push(
    `Single-slide read: \`gws-axi slides page ${flags.presentationId} <page-id>\` (page IDs in \`slides get\`)`,
  );

  blocks.push(renderHelp(suggestions));
  return joinBlocks(...blocks);
}
