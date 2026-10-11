---
status: in-progress
depends: [docs-table-fit, docs-table-spans]
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-read.md
---

# Plan: `fit` survives a read → edit → write

## Scope

`docs read` writes `fit` back for a fixed-width column whose width is still what `fit` makes
it for its current content. The other columns of that table read back relative to each
other. Seen on 2026-10-11 in the Field Guide's cover tab: two tables both had a 61pt label
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

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Unit:
  - a 2-column table at `fit` width + rest → `fit 1`;
  - two fit columns of equal width → `fit fit`;
  - fit + two unequal → `fit 30% 70%`;
  - a column 2pt off → percentages;
  - a bold header row, a list item and a 12pt body font are measured as the writer does;
  - `fitWidth` matches `columnWidths` for every `fit` column.
- [ ] Round trip: Markdown with `<!-- cols: fit 1 -->` → requests → simulated Doc (widths
      from `columnWidths`) → `docs read` → the same hint.
- [ ] Live (scratch Doc, <chris@jarv.us>):
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

(populated at closeout)

## Follow-ups

(populated at closeout)
