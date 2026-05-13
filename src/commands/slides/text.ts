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
}

/**
 * Extract the visible text content of a slide: best-effort title (from
 * a TITLE / CENTERED_TITLE placeholder), the body text from every other
 * shape and table in document order, and the speaker notes from the
 * slide's associated notes page.
 *
 * Images / videos / charts get no inline content — we just count them
 * so agents can tell visual-heavy decks apart from text-heavy ones.
 */
export function extractSlideContent(
  slide: slides_v1.Schema$Page,
  index: number,
): SlideContent {
  const content: SlideContent = {
    index,
    page_id: slide.objectId ?? "",
    title: "",
    body: [],
    speaker_notes: "",
    image_count: 0,
    table_count: 0,
    has_video: false,
  };

  for (const el of slide.pageElements ?? []) {
    if (el.shape) {
      const placeholderType = el.shape.placeholder?.type ?? "";
      const text = extractShapeText(el.shape).trim();
      if (!text) continue;
      if (
        !content.title &&
        (placeholderType === "TITLE" || placeholderType === "CENTERED_TITLE")
      ) {
        content.title = text;
      } else {
        content.body.push(text);
      }
    } else if (el.table) {
      content.table_count += 1;
      const tableText = extractTableText(el.table).trim();
      if (tableText) content.body.push(tableText);
    } else if (el.image) {
      content.image_count += 1;
    } else if (el.video) {
      content.has_video = true;
    } else if (el.elementGroup) {
      // Nested group — recurse one level to pick up text inside groups.
      for (const inner of el.elementGroup.children ?? []) {
        if (inner.shape) {
          const text = extractShapeText(inner.shape).trim();
          if (text) content.body.push(text);
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
        content.speaker_notes = extractShapeText(el.shape).trim();
        break;
      }
    }
  }

  return content;
}

function extractShapeText(shape: slides_v1.Schema$Shape): string {
  if (!shape.text?.textElements) return "";
  const parts: string[] = [];
  for (const el of shape.text.textElements) {
    if (el.textRun?.content) parts.push(el.textRun.content);
    else if (el.autoText) parts.push(el.autoText.content ?? "");
  }
  return parts.join("");
}

function extractTableText(table: slides_v1.Schema$Table): string {
  const rows: string[] = [];
  for (const row of table.tableRows ?? []) {
    const cells: string[] = [];
    for (const cell of row.tableCells ?? []) {
      const cellText: string[] = [];
      for (const el of cell.text?.textElements ?? []) {
        if (el.textRun?.content) cellText.push(el.textRun.content);
      }
      cells.push(cellText.join("").replace(/[\n|]/g, " ").trim());
    }
    rows.push(`| ${cells.join(" | ")} |`);
  }
  return rows.join("\n");
}

export function isSlidePage(p: slides_v1.Schema$Page): boolean {
  return (p.pageType ?? "SLIDE") === "SLIDE";
}
