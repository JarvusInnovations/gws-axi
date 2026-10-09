import { AxiError } from "axi-sdk-js";
import type { docs_v1 } from "googleapis";
import { marked, type Token, type Tokens } from "marked";

/**
 * Markdown → Docs API requests, for one tab.
 *
 * The converter behind `docs create`, `docs write`, and `docs append`
 * (specs/behaviors/markdown-to-doc.md). It parses Markdown with `marked`,
 * flattens the result into paragraphs with per-run styles, and emits one
 * `insertText` of the whole body followed by style requests over index ranges
 * computed from that same text — so every rule here is testable without Docs.
 *
 * Two kinds of request move indices after they run: `createParagraphBullets`
 * removes the leading tabs that set nesting, and `insertInlineImage`,
 * `createFootnote`, and `insertTable` each add content. They are emitted last,
 * in descending index order, so each one only shifts text that no later
 * request addresses.
 *
 * Tables and footnotes need a second pass once Docs has assigned cell and
 * footnote ids; `phase2Requests` builds it from a re-read of the tab.
 */

type Request = docs_v1.Schema$Request;

export const MONO_FONT = "Roboto Mono";
/** The indents Google's own importer gives a blockquote — its exporter turns exactly these back into `>`. */
export const QUOTE_INDENT_PT = 30;
/** Docs allows nesting levels 0–8. */
export const MAX_NESTING = 8;

export interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  link?: string;
}

export interface Run {
  text: string;
  style: InlineStyle;
}

/** Inline content: runs plus the zero-width things anchored at offsets into their joined text. */
export interface Inline {
  runs: Run[];
  images: Array<{ offset: number; uri: string }>;
  footnotes: Array<{ offset: number; content: Inline }>;
}

export type ListKind = "bullet" | "number" | "checkbox";

export interface ParagraphBlock {
  kind: "paragraph";
  inline: Inline;
  /** `HEADING_1`…`HEADING_6`; omitted for body text. */
  heading?: string;
  quote?: boolean;
  code?: boolean;
  /** An empty paragraph with a bottom border, standing in for `---`. */
  rule?: boolean;
  list?: { key: number; kind: ListKind; level: number };
}

/** One paragraph inside a table cell: a line, or a flat list item. */
export interface CellParagraph {
  inline: Inline;
  list?: ListKind;
}

/** A cell holds one or more paragraphs; plain lines separated by `<br>` share one. */
export interface TableCell {
  paragraphs: CellParagraph[];
}

export interface TableBlock {
  kind: "table";
  /** rows[0] is the header row. */
  rows: TableCell[][];
}

export type Block = ParagraphBlock | TableBlock;

export interface Lossy {
  construct: string;
  count: number;
  handling: string;
}

const BULLET_PRESET: Record<ListKind, string> = {
  bullet: "BULLET_DISC_CIRCLE_SQUARE",
  number: "NUMBERED_DECIMAL_NESTED",
  checkbox: "BULLET_CHECKBOX",
};

const HANDLING: Record<string, string> = {
  checked_task: "written unchecked",
  code_language: "dropped",
  image_alt: "dropped",
  inline_html: "written as text",
  html_block: "written as text",
  nested_list_kind: "uses the outer list's kind",
  list_depth: `flattened to level ${MAX_NESTING}`,
  table_cell_block: "written as text",
  table_cell_nested_list: "flattened to one level",
};

// ---------------------------------------------------------------------------
// Parsing: Markdown → blocks

class LossyLedger {
  private counts = new Map<string, number>();
  add(construct: string, n = 1): void {
    if (n <= 0) return;
    this.counts.set(construct, (this.counts.get(construct) ?? 0) + n);
  }
  list(): Lossy[] {
    return [...this.counts].map(([construct, count]) => ({
      construct,
      count,
      handling: HANDLING[construct] ?? "written as text",
    }));
  }
}

// Footnotes are not in marked's core grammar. Definitions are lifted out of
// the source and each `[^label]` reference becomes a private-use character,
// which survives lexing inside ordinary text and is turned back into a
// footnote anchor when runs are built.
const FOOTNOTE_BASE = 0xe000;
const FOOTNOTE_CHAR = /[-]/;

function liftFootnotes(markdown: string): { source: string; definitions: string[] } {
  const definitions: string[] = [];
  const labels = new Map<string, number>();
  const lines = markdown.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[\^([^\]]+)\]:\s?(.*)$/.exec(lines[i]);
    if (!m) {
      kept.push(lines[i]);
      continue;
    }
    let body = m[2];
    // Indented continuation lines belong to the definition.
    while (i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1])) {
      body += ` ${lines[++i].trim()}`;
    }
    labels.set(m[1], definitions.length);
    definitions.push(body.trim());
  }
  const source = kept
    .join("\n")
    .replace(/\[\^([^\]]+)\]/g, (whole, label: string) =>
      labels.has(label) ? String.fromCharCode(FOOTNOTE_BASE + labels.get(label)!) : whole,
    );
  return { source, definitions };
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function checkImageUri(uri: string): void {
  if (!/^https?:\/\//i.test(uri)) {
    throw new AxiError(
      `Image source is not an http(s) URL: ${uri.length > 60 ? `${uri.slice(0, 60)}…` : uri}`,
      "IMAGE_NOT_FETCHABLE",
      [
        "Docs fetches images itself, so each one needs a public http(s) URL",
        "Upload local images to Drive or a web host first, then reference the URL",
      ],
    );
  }
}

interface ParseCtx {
  lossy: LossyLedger;
  definitions: string[];
}

function inlineLength(inline: Inline): number {
  return inline.runs.reduce((n, r) => n + r.text.length, 0);
}

function pushText(inline: Inline, text: string, style: InlineStyle, ctx: ParseCtx): void {
  // A soft line break inside a paragraph is a space; hard breaks arrive as `br` tokens.
  // Then split out footnote anchors (private-use characters) so they never land in the text.
  let rest = text.replace(/\n/g, " ");
  for (;;) {
    const m = FOOTNOTE_CHAR.exec(rest);
    if (!m) break;
    if (m.index > 0) inline.runs.push({ text: rest.slice(0, m.index), style });
    const index = m[0].charCodeAt(0) - FOOTNOTE_BASE;
    const definition = ctx.definitions[index];
    if (definition !== undefined) {
      const content = parseInline(marked.Lexer.lexInline(definition, { gfm: true }), ctx);
      const last = content.runs[content.runs.length - 1];
      if (last) last.text = last.text.replace(/\s+$/, "");
      inline.footnotes.push({ offset: inlineLength(inline), content });
    }
    rest = rest.slice(m.index + 1);
  }
  if (rest) inline.runs.push({ text: rest, style });
}

function parseInline(
  tokens: Token[],
  ctx: ParseCtx,
  style: InlineStyle = {},
  out?: Inline,
): Inline {
  const inline: Inline = out ?? { runs: [], images: [], footnotes: [] };
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens?.length) parseInline(t.tokens, ctx, style, inline);
        else pushText(inline, t.escaped ? unescapeHtml(t.text) : t.text, style, ctx);
        break;
      }
      case "escape":
        pushText(inline, (token as Tokens.Escape).text, style, ctx);
        break;
      case "strong":
        parseInline((token as Tokens.Strong).tokens, ctx, { ...style, bold: true }, inline);
        break;
      case "em":
        parseInline((token as Tokens.Em).tokens, ctx, { ...style, italic: true }, inline);
        break;
      case "del":
        parseInline((token as Tokens.Del).tokens, ctx, { ...style, strikethrough: true }, inline);
        break;
      case "codespan":
        pushText(
          inline,
          unescapeHtml((token as Tokens.Codespan).text),
          { ...style, code: true },
          ctx,
        );
        break;
      case "link": {
        const l = token as Tokens.Link;
        parseInline(l.tokens, ctx, { ...style, link: l.href }, inline);
        break;
      }
      case "image": {
        const img = token as Tokens.Image;
        checkImageUri(img.href);
        inline.images.push({ offset: inlineLength(inline), uri: img.href });
        if (img.text) ctx.lossy.add("image_alt");
        break;
      }
      case "br":
        pushText(inline, "\u000b", style, ctx);
        break;
      case "checkbox":
        // The task marker; the list item carries `task`/`checked`.
        break;
      case "html": {
        const raw = (token as Tokens.Tag).text;
        // The one tag with a Doc equivalent — `docs read` emits it for underline.
        if (/^<u>$/i.test(raw)) style = { ...style, underline: true };
        else if (/^<\/u>$/i.test(raw)) style = { ...style, underline: false };
        else {
          ctx.lossy.add("inline_html");
          pushText(inline, raw, style, ctx);
        }
        break;
      }
      default:
        pushText(inline, (token as Tokens.Generic).raw ?? "", style, ctx);
    }
  }
  return inline;
}

/** `<br>`, `<br/>`, `<br />` — GFM's de facto line break inside a cell. */
const CELL_BREAK = /<br\s*\/?>/i;
/** A list marker opening a cell line: `- `, `* `, `1. `, `1) `, with an optional task box. */
const CELL_ITEM = /^(\s*)(?:([-*])|(\d+)[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;

/**
 * A cell's Markdown: lines split on `<br>`; a line that opens with a list
 * marker is its own paragraph with a bullet, consecutive plain lines share
 * one paragraph joined by hard breaks. Nesting can't be written inside a
 * cell (specs/behaviors/markdown-to-doc.md § Upstream), so an indented
 * marker is flattened and disclosed.
 */
function parseCell(raw: string, ctx: ParseCtx): TableCell {
  const lexLine = (text: string): Inline => {
    const inline = parseInline(marked.Lexer.lexInline(text.trim(), { gfm: true }), ctx);
    if (inline.images.length || inline.footnotes.length) ctx.lossy.add("table_cell_block");
    return { runs: inline.runs, images: [], footnotes: [] };
  };
  const paragraphs: CellParagraph[] = [];
  let pending: Inline | undefined;
  for (const line of raw.split(CELL_BREAK)) {
    const m = CELL_ITEM.exec(line);
    if (m) {
      if (pending) paragraphs.push({ inline: pending });
      pending = undefined;
      if (m[1].length >= 2) ctx.lossy.add("table_cell_nested_list");
      const box = m[4];
      const list: ListKind =
        box !== undefined ? "checkbox" : m[3] !== undefined ? "number" : "bullet";
      if (box !== undefined && box.toLowerCase() === "x") ctx.lossy.add("checked_task");
      paragraphs.push({ inline: lexLine(m[5]), list });
      continue;
    }
    const inline = lexLine(line);
    if (pending) {
      pending.runs.push({ text: "\u000b", style: {} }, ...inline.runs);
    } else {
      pending = inline;
    }
  }
  if (pending) paragraphs.push({ inline: pending });
  if (paragraphs.length === 0) paragraphs.push({ inline: textInline("") });
  return { paragraphs };
}

function plainParagraph(inline: Inline, extra: Partial<ParagraphBlock> = {}): ParagraphBlock {
  return { kind: "paragraph", inline, ...extra };
}

function textInline(text: string): Inline {
  return { runs: text ? [{ text, style: {} }] : [], images: [], footnotes: [] };
}

interface BlockCtx {
  quote: boolean;
  list?: { key: number; kind: ListKind; level: number };
}

function parseBlocks(
  tokens: Token[],
  ctx: ParseCtx,
  bctx: BlockCtx,
  out: Block[],
  listKey: { next: number },
): void {
  for (const token of tokens) {
    switch (token.type) {
      case "space":
      case "def":
      case "checkbox": // the task marker; the list item carries `task`/`checked`
        break;
      case "heading": {
        const h = token as Tokens.Heading;
        out.push(
          plainParagraph(parseInline(h.tokens, ctx), {
            heading: `HEADING_${Math.min(h.depth, 6)}`,
            quote: bctx.quote || undefined,
            list: bctx.list,
          }),
        );
        break;
      }
      case "paragraph":
      case "text": {
        const p = token as Tokens.Paragraph | Tokens.Text;
        const inline = p.tokens?.length
          ? parseInline(p.tokens, ctx)
          : textInline((p as Tokens.Text).escaped ? unescapeHtml(p.text) : p.text);
        out.push(plainParagraph(inline, { quote: bctx.quote || undefined, list: bctx.list }));
        break;
      }
      case "code": {
        const c = token as Tokens.Code;
        if (c.lang) ctx.lossy.add("code_language");
        const text = c.escaped ? unescapeHtml(c.text) : c.text;
        for (const line of text.split("\n")) {
          out.push(
            plainParagraph(textInline(line), {
              code: true,
              quote: bctx.quote || undefined,
              list: bctx.list,
            }),
          );
        }
        break;
      }
      case "blockquote":
        parseBlocks(
          (token as Tokens.Blockquote).tokens,
          ctx,
          { ...bctx, quote: true },
          out,
          listKey,
        );
        break;
      case "list": {
        const list = token as Tokens.List;
        const ownKind: ListKind = list.items.some((i) => i.task)
          ? "checkbox"
          : list.ordered
            ? "number"
            : "bullet";
        let kind = ownKind;
        let key: number;
        let level: number;
        if (bctx.list) {
          key = bctx.list.key;
          kind = bctx.list.kind;
          if (ownKind !== kind) ctx.lossy.add("nested_list_kind");
          level = bctx.list.level + 1;
          if (level > MAX_NESTING) {
            ctx.lossy.add("list_depth");
            level = MAX_NESTING;
          }
        } else {
          key = listKey.next++;
          level = 0;
        }
        for (const item of list.items) {
          if (item.task && item.checked) ctx.lossy.add("checked_task");
          parseBlocks(item.tokens, ctx, { ...bctx, list: { key, kind, level } }, out, listKey);
        }
        break;
      }
      case "hr":
        out.push(plainParagraph(textInline(""), { rule: true, list: bctx.list }));
        break;
      case "table": {
        const t = token as Tokens.Table;
        const cell = (c: Tokens.TableCell): TableCell => parseCell(c.text, ctx);
        out.push({ kind: "table", rows: [t.header.map(cell), ...t.rows.map((r) => r.map(cell))] });
        break;
      }
      case "html": {
        ctx.lossy.add("html_block");
        for (const line of (token as Tokens.HTML).text.replace(/\n$/, "").split("\n")) {
          out.push(
            plainParagraph(textInline(line), { quote: bctx.quote || undefined, list: bctx.list }),
          );
        }
        break;
      }
      default: {
        const g = token as Tokens.Generic;
        if (g.tokens?.length) parseBlocks(g.tokens, ctx, bctx, out, listKey);
        else if (g.raw)
          out.push(plainParagraph(textInline(g.raw.replace(/\n$/, "")), { list: bctx.list }));
      }
    }
  }
}

export interface Parsed {
  blocks: Block[];
  lossy: Lossy[];
}

/** Markdown → blocks. Throws `IMAGE_NOT_FETCHABLE` before anything is written. */
export function parseMarkdown(markdown: string): Parsed {
  const { source, definitions } = liftFootnotes(markdown.replace(/\r\n?/g, "\n"));
  const ctx: ParseCtx = { lossy: new LossyLedger(), definitions };
  const tokens = marked.lexer(source, { gfm: true });
  const blocks: Block[] = [];
  parseBlocks(tokens, ctx, { quote: false }, blocks, { next: 0 });
  return { blocks, lossy: ctx.lossy.list() };
}

// ---------------------------------------------------------------------------
// Emission: blocks → requests

export interface Placement {
  tabId: string;
  /**
   * Index the first inserted character lands on. For an empty tab this is 1;
   * for an append it is the body's end index, because the text is inserted
   * before the final newline with its own leading newline.
   */
  base: number;
  /** True when the body is empty and the text is inserted at index 1. */
  emptyTab: boolean;
  /** Remove the space above the first paragraph (it opens the tab). */
  atTop: boolean;
  /**
   * Space, in points, to put above the paragraph that follows a table — the
   * tab's NORMAL_TEXT space-below, so the gap matches the rest of the body.
   * A Docs table has no bottom margin of its own.
   */
  tableGapPt?: number;
}

/** Docs' default NORMAL_TEXT space-below, used when the tab's named style isn't known. */
export const DEFAULT_TABLE_GAP_PT = 10;

export interface Phase1 {
  requests: Request[];
  /** Characters inserted (the body text, not counting the leading newline of an append). */
  chars: number;
  blocks: number;
  /** Request indices of each `createFootnote`, in document order, for mapping replies. */
  footnoteRequestIndices: number[];
  /** Tables in document order, for phase 2. */
  tables: TableBlock[];
  footnotes: Inline[];
}

interface PlacedParagraph {
  block: ParagraphBlock;
  start: number;
  /** Text length excluding the newline (tabs for nesting included). */
  length: number;
  prefix: number;
  /** A table is inserted directly above this paragraph. */
  followsTable: boolean;
}

function textStyleRequest(range: docs_v1.Schema$Range, style: InlineStyle): Request | undefined {
  const textStyle: docs_v1.Schema$TextStyle = {};
  const fields: string[] = [];
  if (style.bold) {
    textStyle.bold = true;
    fields.push("bold");
  }
  if (style.italic) {
    textStyle.italic = true;
    fields.push("italic");
  }
  if (style.strikethrough) {
    textStyle.strikethrough = true;
    fields.push("strikethrough");
  }
  if (style.underline) {
    textStyle.underline = true;
    fields.push("underline");
  }
  if (style.code) {
    textStyle.weightedFontFamily = { fontFamily: MONO_FONT };
    fields.push("weightedFontFamily");
  }
  if (style.link) {
    textStyle.link = { url: style.link };
    fields.push("link");
  }
  if (fields.length === 0) return undefined;
  return { updateTextStyle: { range, textStyle, fields: fields.join(",") } };
}

/** Style requests for runs laid out from `start`, in the segment `segment` (undefined = body). */
function runStyleRequests(
  inline: Inline,
  start: number,
  tabId: string,
  segmentId: string | undefined,
  force: InlineStyle = {},
): Request[] {
  const out: Request[] = [];
  let at = start;
  for (const run of inline.runs) {
    const req = textStyleRequest(
      { startIndex: at, endIndex: at + run.text.length, tabId, segmentId },
      { ...run.style, ...force },
    );
    if (req && run.text.length > 0) out.push(req);
    at += run.text.length;
  }
  return out;
}

const RESET_TEXT_FIELDS =
  "bold,italic,strikethrough,underline,link,weightedFontFamily,foregroundColor,backgroundColor,fontSize,baselineOffset,smallCaps";
const RESET_PARAGRAPH_FIELDS =
  "namedStyleType,indentStart,indentFirstLine,indentEnd,borderBottom,borderTop,borderLeft,borderRight,spaceAbove,spaceBelow,alignment";

/**
 * Phase 1: the body text and every style that can be addressed from the text
 * alone. Pure — the result is a function of the blocks and the placement.
 */
export function phase1Requests(input: Block[], placement: Placement): Phase1 {
  let blocks = input;
  const { tabId, base } = placement;
  const paragraphs: PlacedParagraph[] = [];
  const tables: Array<{ block: TableBlock; at: number | "end" }> = [];
  const pieces: string[] = [];
  let cursor = base;

  // A table is inserted before the paragraph that follows it; give a final one a paragraph to precede.
  if (blocks.length && blocks[blocks.length - 1].kind === "table") {
    blocks = [...blocks, { kind: "paragraph", inline: { runs: [], images: [], footnotes: [] } }];
  }
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind === "table") {
      const next = blocks.slice(i + 1).find((b) => b.kind === "paragraph");
      tables.push({ block, at: next ? -1 : "end" }); // -1: resolved once the next paragraph is placed
      continue;
    }
    const prefix = block.list ? block.list.level : 0;
    const text = "\t".repeat(prefix) + block.inline.runs.map((r) => r.text).join("");
    const followsTable = tables.some((t) => t.at === -1);
    for (const t of tables) if (t.at === -1) t.at = cursor;
    paragraphs.push({ block, start: cursor, length: text.length, prefix, followsTable });
    pieces.push(text);
    cursor += text.length + 1;
  }
  for (const t of tables) if (t.at === -1) t.at = "end";

  const body = pieces.join("\n");
  const requests: Request[] = [];
  if (paragraphs.length === 0 && tables.length === 0) {
    return { requests, chars: 0, blocks: 0, footnoteRequestIndices: [], tables: [], footnotes: [] };
  }

  // 1. The text, in one piece. An empty body on an empty tab (a table-only
  // write) inserts nothing — the API refuses empty text, and the tab's own
  // empty paragraph is the one the table splits.
  if (paragraphs.length > 0) {
    if (body.length > 0 || !placement.emptyTab) {
      requests.push({
        insertText: {
          location: { index: placement.emptyTab ? base : base - 1, tabId },
          text: placement.emptyTab ? body : `\n${body}`,
        },
      });
    }
    // 2. Inserted text inherits the style of what it was inserted next to; start clean.
    const whole = { startIndex: base, endIndex: cursor, tabId };
    requests.push({
      updateParagraphStyle: {
        range: whole,
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: RESET_PARAGRAPH_FIELDS,
      },
    });
    requests.push({ updateTextStyle: { range: whole, textStyle: {}, fields: RESET_TEXT_FIELDS } });
    requests.push({ deleteParagraphBullets: { range: whole } });
  }

  // 3. Paragraph styles.
  for (const [i, p] of paragraphs.entries()) {
    const range = { startIndex: p.start, endIndex: p.start + Math.max(p.length, 1), tabId };
    const style: docs_v1.Schema$ParagraphStyle = {};
    const fields: string[] = [];
    if (p.block.heading) {
      style.namedStyleType = p.block.heading;
      fields.push("namedStyleType");
    }
    if (p.block.quote) {
      const pt = { magnitude: QUOTE_INDENT_PT, unit: "PT" };
      style.indentStart = pt;
      style.indentFirstLine = pt;
      style.indentEnd = pt;
      fields.push("indentStart", "indentFirstLine", "indentEnd");
    }
    if (p.block.rule) {
      style.borderBottom = {
        width: { magnitude: 1, unit: "PT" },
        dashStyle: "SOLID",
        padding: { magnitude: 0, unit: "PT" },
        color: { color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
      };
      fields.push("borderBottom");
    }
    // The paragraph under a table gets the body's normal gap (a table has no
    // bottom margin); a heading already carries its own. The top-of-tab rule
    // doesn't apply to it — the table opens the tab, not this paragraph.
    if (p.followsTable) {
      if (!p.block.heading) {
        style.spaceAbove = { magnitude: placement.tableGapPt ?? DEFAULT_TABLE_GAP_PT, unit: "PT" };
        fields.push("spaceAbove");
      }
    } else if (i === 0 && placement.atTop) {
      style.spaceAbove = { magnitude: 0, unit: "PT" };
      fields.push("spaceAbove");
    }
    if (fields.length) {
      requests.push({
        updateParagraphStyle: { range, paragraphStyle: style, fields: fields.join(",") },
      });
    }
    // 4. Code lines: the whole paragraph, newline included, in the monospace font.
    if (p.block.code) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: p.start, endIndex: p.start + p.length + 1, tabId },
          textStyle: { weightedFontFamily: { fontFamily: MONO_FONT } },
          fields: "weightedFontFamily",
        },
      });
    }
    // 5. Inline styles.
    requests.push(...runStyleRequests(p.block.inline, p.start + p.prefix, tabId, undefined));
  }

  // 6. Everything that shifts indices, in descending order.
  interface Shift {
    at: number;
    order: number;
    request: Request;
    /** Requests to run right after `request`, addressing only indices it just created. */
    after?: Request[];
    footnote?: Inline;
  }
  const shifts: Shift[] = [];
  let order = 0;
  const footnotes: Inline[] = [];
  for (const p of paragraphs) {
    for (const img of p.block.inline.images) {
      shifts.push({
        at: p.start + p.prefix + img.offset,
        order: order++,
        request: {
          insertInlineImage: {
            location: { index: p.start + p.prefix + img.offset, tabId },
            uri: img.uri,
          },
        },
      });
    }
    for (const fn of p.block.inline.footnotes) {
      shifts.push({
        at: p.start + p.prefix + fn.offset,
        order: order++,
        request: { createFootnote: { location: { index: p.start + p.prefix + fn.offset, tabId } } },
        footnote: fn.content,
      });
      footnotes.push(fn.content);
    }
  }
  for (const t of tables) {
    const rows = t.block.rows.length;
    const columns = Math.max(1, ...t.block.rows.map((r) => r.length));
    const at = t.at === "end" ? cursor - 1 : t.at;
    shifts.push({
      at,
      order: order++,
      request: { insertTable: { rows, columns, location: { index: at, tabId } } },
      // The insert makes a new empty paragraph at `at` that inherits the style
      // (and any bullet) of the paragraph it split off. Reset it, then remove
      // it by deleting the newline that ends the paragraph before it — the
      // stray's own range can't be deleted, but the merge can, and the merged
      // paragraph keeps the preceding one's style. At the very top of a body
      // there is nothing before it to merge into, so it is shrunk instead.
      after: [
        {
          updateParagraphStyle: {
            range: { startIndex: at, endIndex: at + 1, tabId },
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            fields: RESET_PARAGRAPH_FIELDS,
          },
        },
        { deleteParagraphBullets: { range: { startIndex: at, endIndex: at + 1, tabId } } },
        ...(at > 1 ? [strayDelete(at, tabId)] : strayShrink(at, tabId)),
      ],
    });
  }
  // Bullets: one request per run of consecutive paragraphs sharing a list.
  let run: { key: number; kind: ListKind; start: number; end: number } | undefined;
  const flush = () => {
    if (!run) return;
    shifts.push({
      at: run.start,
      order: order++,
      request: {
        createParagraphBullets: {
          range: { startIndex: run.start, endIndex: run.end, tabId },
          bulletPreset: BULLET_PRESET[run.kind],
        },
      },
    });
    run = undefined;
  };
  for (const p of paragraphs) {
    if (p.block.list && run && run.key === p.block.list.key) {
      run.end = p.start + p.length + 1;
    } else {
      flush();
      if (p.block.list) {
        run = {
          key: p.block.list.key,
          kind: p.block.list.kind,
          start: p.start,
          end: p.start + p.length + 1,
        };
      }
    }
  }
  flush();
  // Descending by position; among equal positions, later in the document first,
  // so two tables aimed at the same spot keep their order.
  shifts.sort((a, b) => b.at - a.at || b.order - a.order);

  const footnoteRequestIndices: number[] = [];
  const footnoteOrder = new Map<Inline, number>();
  footnotes.forEach((f, i) => footnoteOrder.set(f, i));
  const indexed: Array<{ i: number; fn: Inline }> = [];
  for (const s of shifts) {
    if (s.footnote) indexed.push({ i: requests.length, fn: s.footnote });
    requests.push(s.request, ...(s.after ?? []));
  }
  indexed.sort((a, b) => footnoteOrder.get(a.fn)! - footnoteOrder.get(b.fn)!);
  for (const x of indexed) footnoteRequestIndices.push(x.i);

  return {
    requests,
    chars: body.length,
    blocks: paragraphs.length + tables.length,
    footnoteRequestIndices,
    tables: tables.map((t) => t.block),
    footnotes,
  };
}

function strayDelete(at: number, tabId: string): Request {
  return { deleteContentRange: { range: { startIndex: at - 1, endIndex: at, tabId } } };
}

/** Zero spacing and a 1pt newline: the unavoidable paragraph above a tab-opening table takes no room. */
function strayShrink(at: number, tabId: string): Request[] {
  const range = { startIndex: at, endIndex: at + 1, tabId };
  return [
    {
      updateParagraphStyle: {
        range,
        paragraphStyle: {
          spaceAbove: { magnitude: 0, unit: "PT" },
          spaceBelow: { magnitude: 0, unit: "PT" },
          lineSpacing: 100,
        },
        fields: "spaceAbove,spaceBelow,lineSpacing",
      },
    },
    {
      updateTextStyle: {
        range,
        textStyle: { fontSize: { magnitude: 1, unit: "PT" } },
        fields: "fontSize",
      },
    },
  ];
}

/** Phase 2 input: where Docs put the tables (cell paragraph starts, row-major) and the footnote ids. */
export interface Phase2Input {
  tabId: string;
  /** For each table in document order: for each row, the start index of each cell's first paragraph. */
  tableCells: number[][][];
  /** Table start indices, matching `tableCells`. */
  tableStarts: number[];
  footnoteIds: string[];
}

/** Phase 2: fill tables and footnotes. Descending index order inside each segment. */
export function phase2Requests(phase1: Phase1, input: Phase2Input): Request[] {
  const { tabId } = input;
  const requests: Request[] = [];
  // Tables, last first; cells, last first — so earlier cells keep their indices.
  for (let t = phase1.tables.length - 1; t >= 0; t--) {
    const block = phase1.tables[t];
    const cells = input.tableCells[t];
    if (!cells) continue;
    for (let r = block.rows.length - 1; r >= 0; r--) {
      for (let c = block.rows[r].length - 1; c >= 0; c--) {
        const at = cells[r]?.[c];
        if (at === undefined) continue;
        const { paragraphs } = block.rows[r][c];
        const texts = paragraphs.map((p) => p.inline.runs.map((x) => x.text).join(""));
        // Cell paragraphs are lines of one insert; the cell's own newline ends the last.
        const text = texts.join("\n");
        // A new cell's paragraph inherits the style of the paragraph the table
        // split off (a heading, bold runs) — reset it before styling the text.
        const cell = { startIndex: at, endIndex: at + Math.max(text.length, 1), tabId };
        if (text) requests.push({ insertText: { location: { index: at, tabId }, text } });
        requests.push({
          updateParagraphStyle: {
            range: cell,
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            fields: "namedStyleType,indentStart,indentFirstLine,indentEnd,borderBottom",
          },
        });
        if (!text) continue;
        requests.push({
          updateTextStyle: { range: cell, textStyle: {}, fields: RESET_TEXT_FIELDS },
        });
        // Styles per paragraph at its offset, then one bullets request per run
        // of same-kind items. Level 0 only, so nothing shifts.
        const lists: Array<{ kind: ListKind; start: number; end: number }> = [];
        let offset = at;
        for (const [i, p] of paragraphs.entries()) {
          requests.push(
            ...runStyleRequests(p.inline, offset, tabId, undefined, r === 0 ? { bold: true } : {}),
          );
          const end = offset + texts[i].length + 1;
          const last = lists[lists.length - 1];
          if (p.list && last && last.kind === p.list && last.end === offset) last.end = end;
          else if (p.list) lists.push({ kind: p.list, start: offset, end });
          offset = end;
        }
        for (const l of lists) {
          requests.push({
            createParagraphBullets: {
              range: { startIndex: l.start, endIndex: l.end, tabId },
              bulletPreset: BULLET_PRESET[l.kind],
            },
          });
        }
      }
    }
    if (block.rows.length > 1 && input.tableStarts[t] !== undefined) {
      requests.push({
        pinTableHeaderRows: {
          tableStartLocation: { index: input.tableStarts[t], tabId },
          pinnedHeaderRowsCount: 1,
        },
      });
    }
  }
  for (const [i, content] of phase1.footnotes.entries()) {
    const segmentId = input.footnoteIds[i];
    if (!segmentId) continue;
    const text = content.runs.map((x) => x.text).join("");
    if (!text) continue;
    requests.push({ insertText: { location: { index: 0, segmentId, tabId }, text } });
    requests.push(...runStyleRequests(content, 0, tabId, segmentId));
  }
  return requests;
}

/** Cell paragraph starts and table starts for every table in `content` that begins at or after `from`. */
export function locateTables(
  content: docs_v1.Schema$StructuralElement[],
  from: number,
): { tableCells: number[][][]; tableStarts: number[] } {
  const tableCells: number[][][] = [];
  const tableStarts: number[] = [];
  for (const el of content) {
    if (!el.table || (el.startIndex ?? 0) < from) continue;
    tableStarts.push(el.startIndex ?? 0);
    tableCells.push(
      (el.table.tableRows ?? []).map((row) =>
        (row.tableCells ?? []).map((cell) => cell.content?.[0]?.startIndex ?? 0),
      ),
    );
  }
  return { tableCells, tableStarts };
}
