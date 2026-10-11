---
status: planned
depends: [docs-table-fit, docs-edit-cell]
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-read.md
  - specs/commands/docs-edit-cell.md
---

# Plan: Merged table cells — column and row spans

## Scope

Tables written through `docs create` / `write` / `append` can merge cells. The syntax is
`marked-extended-tables`' dialect: `| wide |||` for a column span, `| ^|` for a row span,
and several header rows above the delimiter. `docs read` writes merged cells back in the
same syntax, and `docs edit-cell` addresses tables that contain merges. The reader also
escapes a literal `|` in a cell as `\|`, which absorbs the open "`|` escaping in reader
cells" follow-up: once `||` means a span, an unescaped pipe is no longer just lossy, it
reads back as a different table.

**Out of scope:**

- spans in `gmail draft`'s Markdown (it renders HTML through marked, so it could adopt the
  same tokenizer later);
- merging or splitting cells in an existing table;
- delimiter-row widths, which are refused in favour of the `cols` hint.

## Implements

- `specs/behaviors/markdown-to-doc.md`:
  - the three construct rows and § Merged cells;
  - the `fit` bullet for spanning cells;
  - the round-trip bullet;
  - the three upstream rows dated 2026-10-11;
  - the local principle "Borrow a published dialect before inventing one".
- `specs/commands/docs-read.md`: the merged-cell rendering rule.
- `specs/commands/docs-edit-cell.md`: grid columns, `CELL_MERGED`, `cell.span`.

## Approach

1. **Tokenizer, vendored, not a dependency.** `marked-extended-tables@2.0.1` declares
   `peerDependencies: marked >=3 <16`; we are on 18. Its lexer works under 18 (checked in a
   scratch install with `--legacy-peer-deps`), but a consumer's `npm install -g gws-axi`
   would hit the peer conflict. Its last release was 2025-03. So the tokenizer (about 120
   lines, MIT) is ported to `src/commands/docs/span-table.ts`, keeping the copyright notice,
   with these changes:
   - TypeScript;
   - empty rows kept (every source row is a Doc row);
   - `\^` as a literal caret;
   - an unmatched `^` reported, not left as text;
   - delimiter-row widths reported;
   - no HTML renderer, since only the lexer is used.

   It is registered on a private `new Marked()` instance in `md-to-doc.ts`, so
   `gmail/compose.ts`'s global `marked` is untouched. Unit tests port the extension's own
   spec cases that apply.
2. **Parser** (`md-to-doc.ts`):
   - `case "spanTable"` replaces `case "table"`.
   - `TableBlock` gains `headerRows: number`, and each cell gains `rowSpan`/`colSpan`.
     Covered positions are `null` in a grid-shaped `rows`, so phase 1's `rows × columns` and
     the `cols` count are unchanged.
   - Validation errors carry the row and column.
3. **Phase 2** (`phase2Requests`):
   - per table, the `mergeTableCells` requests are emitted before that table's cell fills;
     they move no index (observed for empty cells);
   - head and standalone cells are filled, covered cells skipped;
   - every header row is bold;
   - `pinTableHeaderRows` gets `headerRows`.

   `columnWidths`: `fit` skips cells with `colSpan > 1`.
4. **Reader** (`markdown.ts` `renderTable`):
   - build a covered-cell map from the heads' `rowSpan`/`columnSpan`;
   - emit the head followed by its pipes, and `^` plus pipes for covered rows;
   - the header count comes from the leading `tableRowStyle.tableHeader` rows, at least 1,
     extended over any header row span;
   - in `renderCell`, `|` becomes `\|` instead of a space, and a trailing `^` becomes `\^`.

   `renderCellMarkdown` is shared, so `edit-cell`'s `before` follows.
5. **edit-cell** (`edit-cell.ts`): a covered map from the same head spans (shared helper in
   `markdown.ts` or a small `table-grid.ts`), `CELL_MERGED`, and `cell.span`.
6. **Help and docs**: `docs write --help` `markdown:` block gains the two span forms and
   multi-row headers; README table section; CLAUDE.md status bullet.

## Validation

- [ ] `bun run build`, `lint`, `format:check`, `test` pass. The existing table tests pass
      unchanged, because the vendored tokenizer must read every plain GFM table the way
      marked's did.
- [ ] Unit, tokenizer:
  - colspan;
  - rowspan, including continuing text joined with a space;
  - rowspan of a colspanned cell (`^||`);
  - two header rows;
  - `\|` and `\^` literal;
  - each refusal: overflowing row, `^` in the first body row, `^` under a mismatched cell,
    delimiter widths;
  - a short row padded.
- [ ] Unit, converter: phase 2 emits merges before fills, skips covered cells, bolds and
      pins N header rows; `fit` ignores a spanning cell; a `cols` hint counts grid columns.
- [ ] Unit, reader: heads, covered `^`, header-row count from `tableHeader`, a header row
      span extending the header, and escapes. Round trip: Markdown → requests →
      simulated document → Markdown is identity for a table with both span kinds.
- [ ] Unit, edit-cell: `CELL_MERGED` names the head; `--col` counts grid columns; `span`
      shown on a head.
- [ ] Live (scratch Doc, <chris@jarv.us>):
  - a table with a full-width caption row, a two-row row span and two header rows is
    written in **one** fill batch (merges and fills together, which the probe did in two);
  - `docs read` returns the source Markdown;
  - `edit-cell` on a head and on a covered cell;
  - a `docs write` round trip of the read output leaves the table identical.

## Risks / unknowns

- **Merges and fills in one batch.** The probe merged, then filled in a second batch. In one
  batch the fills are computed from pre-merge indices. That is safe only if merging empty
  cells moves nothing, which the probe showed, but it is unconfirmed within a single batch.
  The fallback is a third request, merges between the insert and the fill, which costs one
  more round trip but changes nothing else.
- **A header row span into the body.** It can't be written in this syntax, because a body
  `^` cannot continue a header cell. The reader avoids it by growing the header, which
  makes the rows below bold on a re-write. It is rare, and the spec states it.
- **Tokenizer drift.** We stop tracking upstream fixes to the extension. It has had no
  release since 2025-03, and the port is small and fully tested.

## Notes

- Probe Doc `191SjBev7TyEI96msr4UN69D-LmB3O-Gl7W1rN21iYZw` (<chris@jarv.us>): merges
  observed on filled and on empty cells. To be trashed at closeout.

## Follow-ups

(populated at closeout)
