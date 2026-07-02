import type { slides_v1 } from "googleapis";

export interface SlideContent {
  index: number;
  page_id: string;
  title: string;
  body: string[];
  speaker_notes: string;
  image_count: number;
  table_count: number;
  has_video: boolean;
  /** Number of embedded links resolved inline as markdown across this slide. */
  link_count: number;
}

/**
 * Resolve a Slides text-run link to a markdown href.
 * - `url` (external) → the url verbatim.
 * - `pageObjectId` (link to another slide) → `slide:<id>`.
 * - `relativeLink` (NEXT_SLIDE, …) / `slideIndex` are navigation, not
 *   resources → undefined (rendered as plain text).
 */
export function linkHref(link: slides_v1.Schema$Link | undefined | null): string | undefined {
  if (!link) return undefined;
  if (link.url) return link.url;
  if (link.pageObjectId) return `slide:${link.pageObjectId}`;
  return undefined;
}

export interface TextRunLike {
  content: string;
  link?: string;
}

/**
 * Join text runs into a single string, wrapping linked runs as markdown
 * `[text](href)`. Contiguous runs sharing the same href are coalesced into one
 * link, and surrounding whitespace (e.g. a trailing `\n` on the run) is kept
 * *outside* the brackets so the link text stays clean across run boundaries.
 */
export function runsToMarkdown(runs: TextRunLike[]): { text: string; links: number } {
  let text = "";
  let links = 0;
  let i = 0;
  while (i < runs.length) {
    const href = runs[i].link;
    if (!href) {
      text += runs[i].content;
      i++;
      continue;
    }
    // Coalesce contiguous runs pointing at the same href.
    let chunk = "";
    while (i < runs.length && runs[i].link === href) {
      chunk += runs[i].content;
      i++;
    }
    const m = chunk.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const lead = m?.[1] ?? "";
    const core = m?.[2] ?? chunk;
    const trail = m?.[3] ?? "";
    if (core) {
      text += `${lead}[${core}](${href})${trail}`;
      links++;
    } else {
      text += chunk;
    }
  }
  return { text, links };
}

/**
 * Extract the visible text content of a slide: best-effort title (from
 * a TITLE / CENTERED_TITLE placeholder), the body text from every other
 * shape and table in document order, and the speaker notes from the
 * slide's associated notes page. Embedded links resolve inline as markdown.
 *
 * Images / videos / charts get no inline content — we just count them
 * so agents can tell visual-heavy decks apart from text-heavy ones.
 */
export function extractSlideContent(slide: slides_v1.Schema$Page, index: number): SlideContent {
  const content: SlideContent = {
    index,
    page_id: slide.objectId ?? "",
    title: "",
    body: [],
    speaker_notes: "",
    image_count: 0,
    table_count: 0,
    has_video: false,
    link_count: 0,
  };

  for (const el of slide.pageElements ?? []) {
    if (el.shape) {
      const placeholderType = el.shape.placeholder?.type ?? "";
      const { text: raw, links } = extractShapeText(el.shape);
      const text = raw.trim();
      if (!text) continue;
      content.link_count += links;
      if (!content.title && (placeholderType === "TITLE" || placeholderType === "CENTERED_TITLE")) {
        content.title = text;
      } else {
        content.body.push(text);
      }
    } else if (el.table) {
      content.table_count += 1;
      const { text: tableText, links } = extractTableText(el.table);
      content.link_count += links;
      if (tableText.trim()) content.body.push(tableText.trim());
    } else if (el.image) {
      content.image_count += 1;
    } else if (el.video) {
      content.has_video = true;
    } else if (el.elementGroup) {
      // Nested group — recurse one level to pick up text inside groups.
      for (const inner of el.elementGroup.children ?? []) {
        if (inner.shape) {
          const { text: raw, links } = extractShapeText(inner.shape);
          const text = raw.trim();
          if (text) {
            content.link_count += links;
            content.body.push(text);
          }
        }
      }
    }
  }

  // Speaker notes live on the notes page; the speakerNotesObjectId
  // identifies which shape on it holds the notes text.
  const notes = slide.slideProperties?.notesPage;
  const notesObjectId = notes?.notesProperties?.speakerNotesObjectId;
  if (notes && notesObjectId) {
    for (const el of notes.pageElements ?? []) {
      if (el.objectId === notesObjectId && el.shape) {
        const { text, links } = extractShapeText(el.shape);
        content.speaker_notes = text.trim();
        content.link_count += links;
        break;
      }
    }
  }

  return content;
}

function extractShapeText(shape: slides_v1.Schema$Shape): { text: string; links: number } {
  if (!shape.text?.textElements) return { text: "", links: 0 };
  const runs: TextRunLike[] = [];
  for (const el of shape.text.textElements) {
    if (el.textRun?.content != null) {
      runs.push({ content: el.textRun.content, link: linkHref(el.textRun.style?.link) });
    } else if (el.autoText) {
      runs.push({ content: el.autoText.content ?? "" });
    }
  }
  return runsToMarkdown(runs);
}

function extractTableText(table: slides_v1.Schema$Table): { text: string; links: number } {
  const rows: string[] = [];
  let links = 0;
  for (const row of table.tableRows ?? []) {
    const cells: string[] = [];
    for (const cell of row.tableCells ?? []) {
      const runs: TextRunLike[] = [];
      for (const el of cell.text?.textElements ?? []) {
        if (el.textRun?.content != null) {
          runs.push({ content: el.textRun.content, link: linkHref(el.textRun.style?.link) });
        }
      }
      const { text, links: cellLinks } = runsToMarkdown(runs);
      links += cellLinks;
      cells.push(text.replace(/[\n|]/g, " ").trim());
    }
    rows.push(`| ${cells.join(" | ")} |`);
  }
  return { text: rows.join("\n"), links };
}

export function isSlidePage(p: slides_v1.Schema$Page): boolean {
  return (p.pageType ?? "SLIDE") === "SLIDE";
}
