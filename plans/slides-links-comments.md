---
status: in-progress
depends: []
specs:
  - specs/commands/slides-read.md
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

- [ ] `bun run lint && format:check && typecheck && build` all pass.
- [ ] `bun run test` green incl. new `slides/text.test.ts`.
- [ ] External link in a slide → `[text](url)` in `page`/`summarize` output;
      `links_resolved: N` in the header.
- [ ] Internal slide link → `[text](slide:<id>)`.
- [ ] Adjacent same-link runs coalesce; trailing newline stays outside `[...]`.
- [ ] `slides comments <id>` returns Drive comments labeled `presentation:` /
      `PRESENTATION_NOT_FOUND`; `docs comments` unchanged.
- [ ] `slides --help` lists `comments`; `slides comments --help` documents it.

## Risks / unknowns

- **Link spanning multiple runs** — Slides may split a single visual link across
  runs on style changes; coalescing by identical target handles the common case.
  Distinct-but-adjacent links render as separate markdown links (correct).
- **Whitespace/newlines in run content** — link runs often include trailing
  `\n`; the whitespace-outside-brackets rule keeps markdown valid. Covered by a
  unit test.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
