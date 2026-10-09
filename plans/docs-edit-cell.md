---
status: in-progress
depends: [docs-table-cells]
specs:
  - specs/commands/docs-edit-cell.md
issues: [108]
---

# Plan: docs edit-cell — replace one table cell by row label

## Scope

The second half of #108: `docs edit-cell <id> --row <label|#n> --text <markdown> [--tab]
[--table n] [--col n]`, replacing one cell's content with converter-grade cell Markdown and
nothing else.

**Out of scope:** row/column structure changes, merging, column-label addressing.

## Implements

- `specs/commands/docs-edit-cell.md`.

## Approach

1. **Converter** (`md-to-doc.ts`): export `parseCellMarkdown(text)` (a `ParseCtx` around
   `parseCell`) and lift the phase-2 per-cell fill into `cellFillRequests(cell, at, tabId,
   force)` so `edit-cell` writes a cell exactly as a new table's cell is written.
2. **Reader** (`markdown.ts`): lift `renderTable`'s cell renderer into an exported
   `renderCellMarkdown(cell, lists)` for `cell.before` and the undo line.
3. **`src/commands/docs/edit-cell.ts`**: `parseArgs`; `documents.get`; tab choice as
   `docs write`; locate table → row → cell; plain-text compare for `unchanged`; one batch:
   `deleteContentRange` (cell start to its end − 1), `deleteParagraphBullets` on the
   remaining paragraph, then `cellFillRequests`; `batch()` from `write.ts`.
4. Dispatcher: the stub becomes real; `instead[]` for the positional stubs names it.
5. README, CLAUDE.md.

## Validation

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Unit: flag parsing; row resolution (label, `**label**`, `#n`, ambiguous, missing);
      the request sequence for an edit (delete range, clear bullets, fill).
- [ ] Live (scratch Doc, chris@jarv.us): edit the value cell of a bold-labelled row on a
      table with a `cols` hint — widths and other cells untouched, the new text carries only
      its own styles; a multi-line `--text` with items lands as bullets; `--text ""` empties;
      a second identical run is `unchanged`; the undo line restores the previous Markdown;
      `ROW_NOT_FOUND`, `ROW_AMBIGUOUS` (+ `#n`), `TABLE_NOT_FOUND`, `--col` out of range.

## Risks / unknowns

- **Deleting a cell's whole content** — the cell must keep one paragraph; deleting up to
  `endIndex − 1` leaves the final newline. If the API refuses a delete that spans cell
  paragraphs, fall back to one delete per paragraph in descending order.
- **Bullets left on the kept paragraph** — `deleteParagraphBullets` on it before the fill.

## Notes

(At closeout.)

## Follow-ups

(At closeout.)
