import type { docs_v1 } from "googleapis";

// Modeled on the converter in google-docs-mcp (src/server.ts:119-272).
// We walk the StructuralElement tree and emit Markdown; images become
// `[image: alt]` placeholders. Unknown elements fall through to their
// textual content so the output is never lossy-silent.
//
// This is the inverse of md-to-doc.ts (specs/behaviors/markdown-to-doc.md):
// Markdown written by `docs write` must read back as the same Markdown, so
// the two share their encodings — monospace runs for code, 30pt indents for a
// quote, a vertical tab for a hard break, a bottom border for a rule.

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
  footnotes?: Record<string, docs_v1.Schema$Footnote> | null,
): RenderedMarkdown {
  const ctx: RenderCtx = {
    lists: lists ?? {},
    imageCount: 0,
    footnotes: footnotes ?? {},
    cited: [],
  };
  if (!body?.content) {
    return { markdown: "", image_count: 0 };
  }
  const parts: string[] = [];
  // Consecutive code-line paragraphs form one fenced block.
  let codeLines: string[] | undefined;
  const closeCode = () => {
    if (codeLines) parts.push(`\`\`\`\n${codeLines.join("\n")}\n\`\`\`\n\n`);
    codeLines = undefined;
  };
  let inList = false;
  let listId = "";
  for (const [i, element] of body.content.entries()) {
    // Every body opens with a section break; it is structure, not content.
    if (i === 0 && element.sectionBreak) continue;
    if (element.paragraph && isCodeLine(element.paragraph)) {
      (codeLines ??= []).push(codeLineText(element.paragraph));
      continue;
    }
    closeCode();
    // List items are single lines; whatever follows a list needs a blank line first.
    const isItem = !!element.paragraph?.bullet;
    const itemList = element.paragraph?.bullet?.listId ?? "";
    // …and so does a different list starting right after this one.
    if (inList && (!isItem || itemList !== listId)) parts.push("\n");
    inList = isItem;
    listId = itemList;
    parts.push(renderStructuralElement(element, ctx));
  }
  closeCode();
  // Footnote definitions, numbered in citation order.
  for (const [n, id] of ctx.cited.entries()) {
    const text = (ctx.footnotes[id]?.content ?? [])
      .map((el) => renderStructuralElement(el, ctx))
      .join("")
      .trim();
    parts.push(`\n[^${n + 1}]: ${text}\n`);
  }
  return {
    markdown: parts
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    image_count: ctx.imageCount,
  };
}

interface RenderCtx {
  lists: ListsMap;
  imageCount: number;
  footnotes: Record<string, docs_v1.Schema$Footnote>;
  /** Footnote ids in order of first citation. */
  cited: string[];
}

const MONO = /mono|consolas|courier|code/i;

function isMono(run: TextRun | undefined): boolean {
  return MONO.test(run?.textStyle?.weightedFontFamily?.fontFamily ?? "");
}

/**
 * A code line: a body paragraph whose every run with visible text is
 * monospace. The writer styles whole lines this way; so does Google's importer.
 */
function isCodeLine(para: Paragraph): boolean {
  if (para.bullet || headingLevelFor(para.paragraphStyle?.namedStyleType ?? "") > 0) return false;
  const runs = (para.elements ?? []).map((e) => e.textRun).filter((r): r is TextRun => !!r);
  const visible = runs.filter((r) => (r.content ?? "").trim().length > 0);
  return visible.length > 0 && visible.every(isMono);
}

function codeLineText(para: Paragraph): string {
  return (para.elements ?? [])
    .map((e) => e.textRun?.content ?? "")
    .join("")
    .replace(/\n$/, "");
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
  const inline = (para.elements ?? []).map((pe) => renderParagraphElement(pe, ctx)).join("");
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

  const ps = para.paragraphStyle;
  if (!text.trim()) {
    // An empty paragraph ruled underneath is the writer's horizontal rule.
    if ((ps?.borderBottom?.width?.magnitude ?? 0) > 0) return "\n---\n\n";
    return "\n";
  }
  // Indented at both edges, not a list item: a blockquote (the shape
  // Google's importer and md-to-doc both produce).
  if ((ps?.indentStart?.magnitude ?? 0) > 0 && (ps?.indentEnd?.magnitude ?? 0) > 0) {
    return `${text
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}\n\n`;
  }
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
    const id = pe.footnoteReference.footnoteId ?? "";
    let n = ctx.cited.indexOf(id);
    if (n < 0) n = ctx.cited.push(id) - 1;
    return `[^${n + 1}]`;
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
  // Docs stores a hard line break as a vertical tab.
  text = text.split("\u000b").join("  \n");

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
  // A header row is bold by construction (GFM renders it so); emitting the
  // markers would double it on the way back in.
  const headerText = (cell: docs_v1.Schema$TableCell): string =>
    cellText(cell).replace(/^\*\*(.+)\*\*$/, "$1");

  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i].tableCells ?? []).map(i === 0 ? headerText : cellText);
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
  // A checkbox list has no glyph symbol and an unspecified glyph type (the
  // API exposes no checked state, so every item reads as open).
  if (levelProps && levelProps.glyphType === "GLYPH_TYPE_UNSPECIFIED" && !levelProps.glyphSymbol) {
    return "- [ ]";
  }
  return "-";
}
