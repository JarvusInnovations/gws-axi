# Command: slides (read surface)

## Summary

The Slides read commands turn a Google Slides presentation into agent-consumable text. `slides get` lists the deck's slides (metadata only); `slides page` renders one slide; `slides summarize` renders the whole deck as GitHub-flavored markdown. All three share one content-extraction contract (this spec's core), so a fix to link handling or notes extraction lands everywhere at once.

`slides comments` surfaces the presentation's review comments — file-agnostic Drive comments, the same mechanism as `docs comments` / `sheets comments`.

## Invocation

- `gws-axi slides get <presentationId> [flags]` — deck metadata + `slides[N]{index,page_id,title}`.
- `gws-axi slides page <presentationId> <pageId> [flags]` — one slide's content.
- `gws-axi slides summarize <presentationId> [flags]` — whole deck as markdown (`--full`, `--out <path>`).
- `gws-axi slides comments <presentationId> [--include-resolved] [flags]`.

## Data Requirements

- Slides `presentations.get` — the full presentation (pages, page elements, text runs **with `textRun.style.link`**, tables, notes pages). Links and notes are already in the default response; the extractor just has to read them. Covered by the `presentations` scope.
- `slides comments` uses Drive `comments.list` (the shared `docsCommentsCommand` handler), covered by the existing `drive` scope; no new scope.

## Content extraction contract (`src/commands/slides/text.ts`)

`extractSlideContent(slide, index)` → `SlideContent{index,page_id,title,body[],speaker_notes,image_count,table_count,has_video,link_count}`.

- **Title** — first `TITLE`/`CENTERED_TITLE` placeholder's text; other shapes' text becomes `body[]` in document order. One level of `elementGroup` nesting is recursed.
- **Tables** — rendered as pipe-delimited rows (`| a | b |`); best-effort, disclosed in help (Slides tables are layout-heavy). Counted in `table_count`.
- **Speaker notes** — from the notes page's `speakerNotesObjectId` shape.
- **Images / videos / charts** — no inline content; counted (`image_count`, `has_video`) so agents can tell visual-heavy decks from text-heavy ones.

### Embedded links (inline markdown)

Hyperlinks on text runs are resolved and rendered **inline as markdown**, not dropped ([principles.md#surface-completeness-limits](../principles.md#surface-completeness-limits) — the linked target is content, not decoration):

- `textRun.style.link.url` (external) → `[text](url)`.
- `textRun.style.link.pageObjectId` (link to another slide) → `[text](slide:<pageObjectId>)`.
- `relativeLink` (NEXT_SLIDE, …) and `slideIndex` are navigation, not resources — left as plain text.
- Adjacent runs sharing the same link target are **coalesced** into one markdown link, and surrounding whitespace is kept outside the `[...]` so link text stays clean across run/style boundaries.

`link_count` sums resolved links across the slide's shapes, tables, and notes. When any were resolved, the command surfaces `links_resolved: <n>` (in the `presentation{}`/`slide{}` header) plus a help line.

## Display Rules

- **`get`** — `presentation{id,title,slide_count,revision_id}` + `slides[N]{index,page_id,title}`. Light metadata only.
- **`page`** — `slide{index,page_id,title,image_count?,table_count?,has_video?,links_resolved?}` + `body` + (when present) `speaker_notes`. Body joins every shape's/table's text in document order (with links inline).
- **`summarize`** — `presentation{id,title,slide_count,links_resolved?}` then a `content` markdown block (`## N. Title` per slide, body + `**Speaker notes:**` + `_visuals: …_`) or a `saved` path with `--out`. Truncated at 8000 chars unless `--full`/`--out` (same pattern as `docs read`).
- **`comments`** — `comments[N]{id,author,created,resolved,quoted_content,body,reply_count}` + `replies[N]{…}`. Empty → canonical scalar. Header labels the resource `presentation`.

## Errors

- Not found / no access → `PRESENTATION_NOT_FOUND` with access-check suggestions (`comments` reuses this code via the handler's `notFoundCode`).
- `slides page` unknown `pageId` → `PAGE_NOT_FOUND` listing how to get page ids from `slides get`.

## help[] suggestions

- Cross-links between the three read commands (`get` → `summarize`/`page`; `page` → next slide + full deck; `summarize` → single-slide `page`).
- Image/table/video count notes (text-only rendering; PDF-export escape hatch for visuals).
- When links were resolved → an `N link(s) resolved inline as markdown` line.
- Review comments funnel → `slides comments <id>`.

## Principles

**Inherited:**

- [surface-completeness-limits](../principles.md#surface-completeness-limits) — embedded links are surfaced (as markdown) rather than silently dropped; images/tables/video are counted and disclosed as not-inlined.
- [minimal-default-schemas](../principles.md#minimal-default-schemas) — `get` is metadata-only; `summarize` truncates at 8000 chars with `--full`/`--out` escape hatches.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — the three read commands cross-reference each other and funnel to `comments` with real ids.
- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — `presentations.get` and `comments.list` are pure reads.
- [single-source-of-truth-helpers](../principles.md#single-source-of-truth-helpers) — comments route through the shared `docsCommentsCommand` (parameterized), not a fork.
