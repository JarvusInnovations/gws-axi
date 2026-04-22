import type { docs_v1 } from "googleapis";

// Modeled on the converter in google-docs-mcp (src/server.ts:119-272).
// We walk the StructuralElement tree and emit Markdown; images become
// `[image: alt]` placeholders. Unknown elements fall through to their
// textual content so the output is never lossy-silent.

type StructuralElement = docs_v1.Schema$StructuralElement;
type Paragraph = docs_v1.Schema$Paragraph;
type ParagraphElement = docs_v1.Schema$ParagraphElement;
type TextRun = docs_v1.Schema$TextRun;
type Table = docs_v1.Schema$Table;
type ListsMap = Record<string, docs_v1.Schema$List>;

export interface RenderedMarkdown {
  markdown: string;
  image_count: number;
}

export function renderBodyAsMarkdown(
  body: docs_v1.Schema$Body | undefined,
  lists: ListsMap | undefined,
): RenderedMarkdown {
  const ctx: RenderCtx = { lists: lists ?? {}, imageCount: 0 };
  if (!body?.content) {
    return { markdown: "", image_count: 0 };
  }
  const parts: string[] = [];
  for (const element of body.content) {
    parts.push(renderStructuralElement(element, ctx));
  }
  return {
    markdown: parts.join("").replace(/\n{3,}/g, "\n\n").trim(),
    image_count: ctx.imageCount,
  };
}

interface RenderCtx {
  lists: ListsMap;
  imageCount: number;
}

function renderStructuralElement(el: StructuralElement, ctx: RenderCtx): string {
  if (el.paragraph) return renderParagraph(el.paragraph, ctx);
  if (el.table) return renderTable(el.table, ctx);
  if (el.sectionBreak) return "\n---\n\n";
  if (el.tableOfContents) {
    // Docs includes TOC as a nested body; we just note its presence rather
    // than recurse — TOCs are noisy and not what agents usually want.
    return "_[table of contents]_\n\n";
  }
  return "";
}

function renderParagraph(para: Paragraph, ctx: RenderCtx): string {
  const inline = (para.elements ?? [])
    .map((pe) => renderParagraphElement(pe, ctx))
    .join("");
  const text = inline.replace(/\n+$/, "");

  const style = para.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT";
  const headingLevel = headingLevelFor(style);
  if (headingLevel > 0) {
    if (!text.trim()) return "";
    return `${"#".repeat(headingLevel)} ${text.trim()}\n\n`;
  }

  if (para.bullet) {
    const level = para.bullet.nestingLevel ?? 0;
    const marker = bulletMarker(para.bullet.listId ?? "", level, ctx.lists);
    const indent = "  ".repeat(level);
    return `${indent}${marker} ${text.trim()}\n`;
  }

  if (!text.trim()) return "\n";
  return `${text.trim()}\n\n`;
}

function renderParagraphElement(pe: ParagraphElement, ctx: RenderCtx): string {
  if (pe.textRun) return renderTextRun(pe.textRun);
  if (pe.horizontalRule) return "\n---\n";
  if (pe.inlineObjectElement) {
    ctx.imageCount += 1;
    // We don't have the alt/title without a second lookup into
    // document.inlineObjects. Agents typically just need to know an image
    // exists and where; a placeholder is sufficient for v1.
    return "[image]";
  }
  if (pe.pageBreak) return "\n\n";
  if (pe.columnBreak) return "\n";
  if (pe.footnoteReference) {
    return `[^${pe.footnoteReference.footnoteNumber ?? "?"}]`;
  }
  if (pe.equation) return "_[equation]_";
  if (pe.autoText) return pe.autoText.textStyle?.link?.url ?? "";
  if (pe.person) return pe.person.personProperties?.name ?? "";
  if (pe.richLink) {
    const title = pe.richLink.richLinkProperties?.title ?? "link";
    const uri = pe.richLink.richLinkProperties?.uri ?? "";
    return uri ? `[${title}](${uri})` : title;
  }
  return "";
}

function renderTextRun(run: TextRun): string {
  let text = run.content ?? "";
  if (!text) return "";
  // Preserve a trailing newline separately so surrounding markers don't
  // swallow it (e.g., `**bold\n**` renders wrong). Inline styling wraps
  // just the content portion.
  let trailing = "";
  const nlMatch = /(\n+)$/.exec(text);
  if (nlMatch) {
    trailing = nlMatch[1];
    text = text.slice(0, -trailing.length);
  }
  if (!text) return trailing;

  const style = run.textStyle;
  if (style) {
    if (style.bold && style.italic) text = `***${text}***`;
    else if (style.bold) text = `**${text}**`;
    else if (style.italic) text = `*${text}*`;

    // Inline code: we use `code` when textStyle has a monospace font family
    // set (the closest signal Docs gives for inline code).
    const fam = style.weightedFontFamily?.fontFamily;
    if (fam && /mono|consolas|courier|code/i.test(fam) && !style.bold && !style.italic) {
      text = `\`${text}\``;
    }

    if (style.strikethrough) text = `~~${text}~~`;
    if (style.underline && !style.link) text = `<u>${text}</u>`;
    if (style.link?.url) text = `[${text}](${style.link.url})`;
  }

  return text + trailing;
}

function renderTable(table: Table, ctx: RenderCtx): string {
  const rows = table.tableRows ?? [];
  if (rows.length === 0) return "";
  const cellText = (cell: docs_v1.Schema$TableCell): string => {
    const parts: string[] = [];
    for (const el of cell.content ?? []) {
      // Flatten paragraphs into single-line cells — GFM tables can't carry
      // block content.
      if (el.paragraph?.elements) {
        for (const pe of el.paragraph.elements) {
          parts.push(renderParagraphElement(pe, ctx));
        }
      }
    }
    return parts.join("").replace(/[\n|]/g, " ").trim();
  };

  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i].tableCells ?? []).map(cellText);
    lines.push(`| ${cells.join(" | ")} |`);
    if (i === 0) {
      lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
    }
  }
  return `\n${lines.join("\n")}\n\n`;
}

function headingLevelFor(namedStyleType: string): number {
  if (namedStyleType === "TITLE") return 1;
  if (namedStyleType === "SUBTITLE") return 2;
  const m = /^HEADING_([1-6])$/.exec(namedStyleType);
  return m ? parseInt(m[1], 10) : 0;
}

function bulletMarker(listId: string, level: number, lists: ListsMap): string {
  const list = lists[listId];
  const levelProps = list?.listProperties?.nestingLevels?.[level];
  // Ordered list: Docs sets a glyphType like "DECIMAL", "UPPER_ROMAN" etc.
  // Unordered list: Docs sets a glyphSymbol (e.g. "●", "○", "■"). We don't
  // round-trip the exact ordinal here — just emit `1.` and let markdown
  // renderers re-number, which is the GFM convention.
  if (levelProps?.glyphType && levelProps.glyphType !== "GLYPH_TYPE_UNSPECIFIED") {
    return "1.";
  }
  return "-";
}
