---
status: in-progress
depends: [docs-table-cells]
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-read.md
issues: [107]
---

# Plan: Column-width hints for tables

## Scope

#107: `<!-- cols: 1 3 -->` / `<!-- cols: 25% 75% -->` before a table sets fixed column widths
in those proportions of the tab's content width; `docs read` emits the hint back as
percentages when a table's columns are fixed and unequal.

**Out of scope:** the delimiter-dash-count syntax (fragile under formatters and invisible
to a human editing the Markdown — the pragma is explicit and survives both); merging a
single-cell caption row across columns (a separate feature, `mergeTableCells`); row heights.

## Implements

- `specs/behaviors/markdown-to-doc.md` — the construct row, the fidelity rule, the upstream
  row.
- `specs/commands/docs-read.md` § Content — the hint on read.

## Approach

1. **Parse** (`md-to-doc.ts` `parseBlocks`): an `html` block token matching
   `<!-- cols: … -->` is held as a pending hint; the next token must be a `table` (ignoring
   `space`), which takes it as `cols: number[]` (fractions summing to 1, from weights or
   percentages). A hint with the wrong count, not followed by a table, or left over at the
   end is a `VALIDATION_ERROR` naming the line.
2. **Phase 2**: `Phase2Input.contentWidthPt` (from the tab's `documentStyle`, default 468);
   for each table with `cols`, one `updateTableColumnProperties` per column at
   `tableStarts[t]`, `FIXED_WIDTH`, `width = round(contentWidth × fraction)`. Index-free, so
   emitted after the cell fills.
3. **State** (`write.ts`): the with-bodies mask gains
   `documentTab(documentStyle(pageSize,marginLeft,marginRight))`; `TabTarget.contentWidthPt`.
4. **Reader** (`markdown.ts` `renderTable`): when every column is `FIXED_WIDTH` and the widths
   differ, prefix `<!-- cols: a% b% -->` with integer percentages of their sum, the last
   adjusted so they total 100.

## Validation

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Unit: parser — weights, percentages, blank line between hint and table, wrong count,
      hint without a table, hint at end; phase 2 — width requests at the table start with
      the computed points; reader — fixed unequal widths → hint, evenly distributed → none,
      fixed equal → none.
- [ ] Live (scratch Doc, chris@jarv.us): a `1 3` table lands at 117/351pt and reads back as
      `<!-- cols: 25% 75% -->`; a re-write of that read-back keeps the widths; a table with
      no hint reads back with no line.

## Risks / unknowns

- **Tables narrower than the content width** (indented, or inside a cell): widths are
  computed from the tab's content width regardless. Nested tables are not written by the
  converter; indented ones aren't either. Acceptable.

## Notes

(At closeout.)

## Follow-ups

(At closeout.)
