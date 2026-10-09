---
status: done
depends: [docs-table-cells]
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-read.md
issues: [107]
pr: 116
---

# Plan: Column-width hints for tables

## Scope

# 107: `<!-- cols: 1 3 -->` / `<!-- cols: 25% 75% -->` before a table sets fixed column widths
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

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit: parser — weights, percentages, blank line between hint and table, wrong count,
      hint without a table, hint at end; phase 2 — width requests at the table start with
      the computed points; reader — fixed unequal widths → hint, evenly distributed → none,
      fixed equal → none.
- [x] Live (scratch Doc, <chris@jarv.us>): a `1 3` table lands at 117/351pt and reads back as
      `<!-- cols: 25% 75% -->`; a re-write of that read-back keeps the widths; a table with
      no hint reads back with no line.

## Risks / unknowns

- **Tables narrower than the content width** (indented, or inside a cell): widths are
  computed from the tab's content width regardless. Nested tables are not written by the
  converter; indented ones aren't either. Acceptable.

## Notes

- Stacked on `docs-table-cells` (PR #115): it needs the cell model and the rewritten
  `renderTable`. First cut was branched from `develop` by mistake and rebased onto the cells
  branch; PR #116's base is `feat/docs-table-cells` until #115 merges.
- A wrong-count hint was refused with **no tab added** — the `--new-tab` pre-add dry run
  from #104 catches converter-level refusals exactly as intended.
- The content width comes from the tab's own `documentStyle`, so a Doc with custom margins
  gets widths that fill its own page, not the default's.
- Scratch Doc `12ScFDaMayFwXm_GNVK9fO2eXWYLVtGXfKDRY6UdAOaY` (<chris@jarv.us>), trashed.

## Follow-ups

- Tracked as: a single-cell first row merged across the columns (`mergeTableCells`) — the
  "titled table" pattern from #107, not asked for on its own yet.
- Tracked as: hints are read from the whole-table column properties; a table whose widths a
  human adjusted by hand reads back with a hint too, which a re-write then preserves — the
  intended behavior, worth knowing.
