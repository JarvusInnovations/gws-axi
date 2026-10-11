---
status: done
depends: [docs-table-fit, docs-table-spans]
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-read.md
pr: 128
---

# Plan: `fit` survives a read → edit → write

## Scope

`docs read` writes `fit` back for a fixed-width column whose width is still what `fit` makes
it for its current content. The other columns of that table read back relative to each
other. Seen on 2026-10-11 in an owner's Doc's cover tab: two tables both had a 61pt label
column, which is exactly `13% 87%` of 468pt and no column's `fit` width. A table written with
`fit` (60pt, from "Timeline") had been read back as `13% 87%`, rewritten that way, and the
hint copied to a second table whose "Generated" label needs 70pt, so the label wrapped.

**Out of scope:** storing the intent anywhere in the Doc, since there is nowhere to put it.
Re-fitting on read is a measurement, and a false match is harmless.

## Implements

- `specs/behaviors/markdown-to-doc.md` § Fitted columns, "Reading `fit` back"; the
  round-trip bullet; the `fit` construct row.
- `specs/commands/docs-read.md`: the width-hint rule.

## Approach

1. `md-to-doc.ts`: extract the per-column measurement from `columnWidths` into an exported
   `fitWidth(block, column, bodyFontPt)`. The writer and the reader then share one
   measurement, and `columnWidths` calls it.
2. `markdown.ts`:
   - `renderBodyAsMarkdown` takes an optional `bodyFontPt`, defaulting to 11.
   - `renderTable` builds the table's own Markdown as it does now, parses it with
     `parseMarkdown` into a `TableBlock` (exactly the cells a re-write would measure), and
     compares each fixed column with `fitWidth` (±1pt).
   - `colsHint` emits:
     - `fit` for matching columns;
     - `1` each for equal other columns, or whole percentages of their sum otherwise;
     - nothing for an all-equal table with no fit.
3. `read.ts`: pass the tab's `NORMAL_TEXT` `fontSize` (or the Doc's, for a tab-less read).

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit:
  - a 2-column table at `fit` width + rest → `fit 1`;
  - two fit columns of equal width → `fit fit`;
  - fit + two unequal → `fit 30% 70%`;
  - a column 2pt off → percentages;
  - a bold header row, a list item and a 12pt body font are measured as the writer does;
  - `fitWidth` matches `columnWidths` for every `fit` column.
- [x] Round trip: Markdown with `<!-- cols: fit 1 -->` → requests → simulated Doc (widths
      from `columnWidths`) → `docs read` → the same hint.
- [x] Live (scratch Doc, <chris@jarv.us>):
  - write a `fit 1` table, then read it back: the hint is `fit 1`;
  - append a longer label and re-write the read output: the column widens to fit it;
  - resize a column by hand (`updateTableColumnProperties` from the probe), then read: a
    percentage.

## Risks / unknowns

- **Re-parsing in the reader** costs one `parseMarkdown` per fixed-width table. These tables
  are small, so it is cheap, and it guarantees the same cells the writer would measure.
- **The body font size** has to reach the reader. When it is missing, 11pt (Docs' default)
  is assumed, and the worst case is a percentage where `fit` was meant, which is today's
  behaviour.

## Notes

- Live, 2026-10-11, scratch Doc `1KlHltpeRGOwx8CMrhzoA5fDxb0IT7o-VauN64BoNTWw`
  (<chris@jarv.us>), trashed:
  - `fit 1` written (57pt, from "Timeline") read back as `fit 1`;
  - with a `**Generated**` row added to the read output and written back, the column became
    70pt, exactly the width the reported wrapping label needed;
  - resized to 90pt by hand, it read back as `18% 82%`.
- The reporting Doc itself was left to its generator, as the owner asked. Its next pass, with
  `fit` in the hint, gets 70pt.
- The test simulator has to give a cell's list paragraphs their bullets. Without them the
  reader renders no `- ` marker and the re-parse measures no indent. A failing test caught
  this, and the reader was right.

## Follow-ups

- None. Storing the intent would need a place in the Doc, which does not exist.
