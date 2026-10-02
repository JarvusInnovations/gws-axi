---
status: done
depends: []
specs:
  - specs/commands/slides-read.md
  - specs/commands/slides-skip.md
issues: [64]
pr: 94
---

# Plan: Slides skipped flag — read and write

## Scope

#64: surface `isSkipped` on every Slides read, and add `slides skip` / `slides unskip`.

## Implements

- `specs/commands/slides-read.md` — skipped slides bullet and schemas.
- `specs/commands/slides-skip.md`.

## Approach

`extractSlideContent` reads `slideProperties.isSkipped`; `get`/`page`/`summarize` render it.
`src/commands/slides/skip.ts`: one read, plan the changes, one `batchUpdate` of
`updateSlideProperties`.

## Validation

- [x] Unit: arg parsing; only changed slides are written; unknown ids; `isSkipped` extraction.
- [x] Live (scratch deck "gws-axi skip probe (safe to delete)"): skip two slides; repeat with one
      new → `changed: 1 of 2`; `get` shows `✓` and `skipped_count`; `summarize` marks headings;
      `page` shows `skipped: true`; `unskip` all; unknown id → `PAGE_NOT_FOUND`.
- [x] build, lint, test.

## Risks / unknowns

None.

## Notes

- The scratch deck was created through the Slides API and filed with the new `drive move`.

## Follow-ups

None.
