---
status: done
depends: [docs-table-cells]
specs:
  - specs/commands/docs-edit-cell.md
issues: [108]
pr: 117
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

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit: flag parsing; row resolution (label, `**label**`, `#n`, ambiguous, missing);
      the request sequence for an edit (delete range, clear bullets, fill).
- [x] Live (scratch Doc, <chris@jarv.us>): edit the value cell of a bold-labelled row on a
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

- A delete spanning several cell paragraphs (the three-item Inputs cell) went through in one
  `deleteContentRange`; the per-paragraph fallback was not needed.
- The `cols` widths (117/351) survived every edit, which is the point of the command.
- `--text ""` had to be validated through `node dist/bin/gws-axi.js` — the `bun run dev`
  empty-argument drop recorded in CLAUDE.md.
- Stacked on `docs-table-cols` (PR #116) → `docs-table-cells` (#115): `parseCell` comes from
  #115 and the phase-2 refactor overlaps #116's width requests. Stacked PRs get no CI run
  (`ci.yml` triggers on PRs to `main`/`develop` only) until GitHub retargets them after the
  base merges.
- Third copy of the `documents.get` error translation and tab choice (with `find`,
  `replace-text`): the shared-helper follow-up from `plans/docs-replace-text.md` now has
  three callers.
- Scratch Doc `1tXa2754OcQx0Z4piI0-ASllkgh8bKBZ5HcK4MW5dVWQ` (<chris@jarv.us>), trashed.

## Follow-ups

- Tracked as: one `readDocumentForEdit(api, account, id)` + `chooseTab(doc, requested,
  usage)` helper for `find`, `replace-text`, `edit-cell` (and `write`'s `readState`).
- Tracked as: `--col` by column header label, once a table with more than two columns needs
  it.
