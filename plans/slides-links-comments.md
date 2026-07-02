---
status: done
depends: []
specs:
  - specs/commands/slides-read.md
pr: 38
---

# Plan: Slides — inline-markdown links + comments

## Scope

Give the Slides read surface the same treatment Sheets got: resolve embedded
hyperlinks inline as markdown, and add a `slides comments` alias. Also backfills
the previously-unspecced Slides read surface with `specs/commands/slides-read.md`.

**In scope:**

- Link-aware text extraction in `src/commands/slides/text.ts` (`extractShapeText`
  - `extractTableText` read `textRun.style.link`), coalescing adjacent same-link
  runs; `SlideContent.link_count`.
- `slides summarize` / `slides page` surface `links_resolved` + help line.
- `slides comments <id>` — alias of the parameterized `docsCommentsCommand`
  (`resource: "presentation"`, `notFoundCode: "PRESENTATION_NOT_FOUND"`).
- Spec + README + status-index updates.

**Out of scope:** Slides writes (`create`/`update`, still stubbed); image/chart
content extraction (still counted only); a dedicated `slides find`.

## Implements

- `specs/commands/slides-read.md` — the content-extraction contract (esp. the
  inline-markdown link rules) and the `slides comments` alias.

## Approach

1. **`text.ts`** — factor a pure `runsToMarkdown(runs)` + `linkHref(link)`:
   - `linkHref`: `url` → the url; `pageObjectId` → `slide:<id>`; else undefined
     (relativeLink/slideIndex are navigation).
   - `runsToMarkdown`: coalesce contiguous same-target runs, wrap the core text
     as `[core](href)` with surrounding whitespace kept outside the brackets,
     count links.
   - `extractShapeText` / `extractTableText` return `{ text, links }`; callers in
     `extractSlideContent` accumulate into `content.link_count` (title, body,
     grouped shapes, table cells, speaker notes).
2. **`summarize.ts` / `page.ts`** — add `links_resolved` to the header when
   `> 0` and a help line; markdown links flow through automatically since the
   extracted text now carries them.
3. **`slides.ts`** — import `docsCommentsCommand`; add a `comments` read
   subcommand wrapping it with the presentation resource label + not-found code;
   add a `COMMENTS_HELP`; list it in `SLIDES_HELP`.
4. **Tests** (`src/commands/slides/text.test.ts`) — `linkHref` cases,
   `runsToMarkdown` (plain, external url, pageObjectId, coalescing, whitespace
   outside brackets, empty core), and an `extractSlideContent` smoke test that a
   linked run round-trips into `body` + `link_count`.
5. **Docs** — README Slides row/section, `.claude/CLAUDE.md` status.

## Validation

- [x] `bun run lint && format:check && typecheck && build` all pass.
- [x] `bun run test` green (177) incl. new `slides/text.test.ts` (10).
- [x] External link in a slide → `[text](url)` in `page`/`summarize` output;
      `links_resolved: N` in the header. (TIDES deck: summarize `links_resolved:
      9`, page slide 21 `links_resolved: 1`.)
- [x] Internal slide link → `[text](slide:<id>)` (unit test).
- [x] Adjacent same-link runs coalesce; trailing newline stays outside `[...]`
      (unit tests).
- [x] `slides comments <id>` returns Drive comments labeled `presentation:` /
      `PRESENTATION_NOT_FOUND`; `docs comments` unchanged.
- [x] `slides --help` lists `comments`; `slides comments --help` documents it.

## Risks / unknowns

- **Link spanning multiple runs** — Slides may split a single visual link across
  runs on style changes; coalescing by identical target handles the common case.
  Distinct-but-adjacent links render as separate markdown links (correct).
- **Whitespace/newlines in run content** — link runs often include trailing
  `\n`; the whitespace-outside-brackets rule keeps markdown valid. Covered by a
  unit test.

## Notes

- **Same pattern as Sheets (#36), no new fetch.** `presentations.get` already
  returns `textRun.style.link` — the extractor just had to read it; no fields
  mask or extra call. Comments reuse the parameterized `docsCommentsCommand`
  (single source of truth: docs/sheets/slides all share it).
- **Links inline, not a separate block.** Slides text is already rendered as
  markdown, so a link belongs in the flowing text (`[text](url)`) rather than a
  detached list — matches the Sheets choice for portability.
- **Whitespace-outside-brackets matters.** Slides link runs commonly carry a
  trailing `\n`; wrapping naively (`[text\n](url)`) breaks markdown, so
  `runsToMarkdown` moves leading/trailing whitespace outside the `[...]`.
- **Backfilled spec.** Slides had no spec; `slides-read.md` now documents the
  shared extraction contract for get/page/summarize + the comments alias.

## Follow-ups

- **Slides writes** — `create` / `update` (still `NOT_IMPLEMENTED` stubs).
- **Image/chart content** — currently counted only; OCR/alt-text extraction or a
  visual export path is a separate effort.
- **`slides find`** — cross-slide text search (analog of `docs find`).
