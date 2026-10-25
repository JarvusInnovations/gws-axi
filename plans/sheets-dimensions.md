---
status: done
pr: 143
depends: []
specs:
  - specs/commands/sheets-dimensions.md
---

# Plan: Sheets row and column insertion / deletion in place

## Scope

`sheets insert-rows`, `insert-cols`, `delete-rows`, `delete-cols`: the dimension-range
parser, `insertDimension` with inherit-by-default, `deleteDimension` with the deleted cells
as the undo record, the `shifted:` sentence, and the tab-wide formula-error diff reused from
the value writes.

**Out of scope:** move / resize / hide dimensions, grouping, insert-with-content.

## Implements

- `specs/commands/sheets-dimensions.md` — the whole group.

## Approach

1. **Probe first** every "To verify live" row: `inheritFromBefore` at index 0, formula
   shifting on insert, `#REF!` on delete, delete-all refusal, frozen-row interplay, a
   protected range against a dimension request. Record; amend the spec first if contradicted.
2. **Parser** (`shared.ts`, beside `parseA1`): `parseDimensionRange(text, "rows"|"cols")` →
   `{start0, end0}` from `3:5` / `3` / `B:D` / `B`, tab-qualified or not; refuses the other
   kind with the two forms named.
3. **Shared runner** (`src/commands/sheets/dimensions.ts`): resolve tab (reuse
   `tabFromFlags`), bounds checks, pre-scan, the request, post-scan, `diffErrors` /
   `fixLines` from `shared.ts`, the `shifted` sentence builder (pure, unit-tested in
   old-row terms), the delete's pre-read of the range through `fetchGrid` + the read's
   `buildGrid` for the `cells[N]{row,…}` block (cap 50, `cells_total`).
4. Four thin commands over the runner; `FlagSpec`s; help text with the undo pairing in each.
5. Dispatcher entries, README § Sheets, CLAUDE.md status.

**Concurrency note:** `sheets-tabs` and `sheets-note` land in the same wave and also touch
`src/commands/sheets.ts`, `shared.ts`, README § Sheets and CLAUDE.md. Keep additions
grouped so conflicts are keep-both.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit: the dimension parser on every accepted and refused form; the `shifted` sentence
      for insert and delete; delete-all refusal; start-past-allocation refusal.
- [x] Every "To verify live" row Observed (or amended) with a date.
- [x] Live: `insert-rows 3:5` on a formatted table — rows 3–5 empty with the table's
      formatting, old row 3 at 6, a `SUM(B2:B9)` below now reads `B2:B12`, `inherit: from
      row 2`; `--no-inherit` leaves them unformatted; `insert-rows 1` reports `inherit: from
      row N (was row 1)` (amended: upstream has no un-inherited insert — see the spec's
      `inheritFromBefore: false` row).
- [x] Live: `delete-rows 3:5` reports the removed cells in `cells[]` with old row numbers,
      the `shifted` sentence, and a `#REF!` in a formula that read a deleted cell, with a fix
      line; `errors_fixed` when re-inserting and re-filling.
- [x] Live: `insert-cols B:C` / `delete-cols B` the same way; a protected range is
      `PROTECTED_RANGE`.
- [x] Live: deleting inside frozen rows reports the new `frozen_rows`.

## Risks / unknowns

- **Formula shifting** is Sheets' own; the spec only promises to report errors, not to
  predict shifts. Keep it that way.
- **Delete undo** is "insert + update": the help line spells it out; no combined undo verb.

## Notes

- **Probes changed the spec in four places**, each in its own `docs(specs):` commit:
  `inheritFromBefore: false` copies from the row *after* (formats and height), so
  `--no-inherit` clears formats in the same batch and an insert at row 1 inherits from below;
  a delete rewrites a broken reference to `=#REF!`, so the pre-scan carries formulas and the
  fix line names the formula as it was; a delete running past the grid is silently clipped
  upstream, so it is refused locally; an insert inside the frozen area grows the freeze, so
  `frozen_*` is reported on inserts too. The capped-rows count is `cells_total_rows` (the
  read's name), not the `cells_total` the Approach mentions.
- **Error diff across a shift**: pre-call errors are re-keyed to post-call addresses
  (`shiftErrors`) before `diffErrors`; an error cell the delete removed is in `cells[]`,
  neither fixed nor reported. Over the 200k-cell bound the scan is skipped
  (`error_scan: not run`), since there is no written range to fall back to.
- **Live evidence** used other spans than the boxes name: the delete box ran `delete-rows
  9:10` (two removed rows with old numbers, two `#REF!`s with pre-delete formulas, then
  re-insert + `update --range` + restoring the two formulas reported `errors_fixed: 2`); the
  columns box ran `delete-cols E` (10 `#REF!`s) and `delete-cols H` (fix line naming the
  formula's old cell). `errors_fixed` on a dimension call itself was also seen (a delete that
  cleared a `#DIV/0!`). The protected-range box ran as an editor without rights to the range
  (a row delete and a column insert, both `PROTECTED_RANGE`).
- `--no-inherit` clears cell formats only; row height / column width still come from the
  neighbor (no un-inherited insert upstream), disclosed in help.
- The 10,000,000-cell insert limit was not exercised (generic translation).
- **Review round** (spec amended first, then code): the deleted-cells block is anchored at
  the range's first row (row 1 for columns) with empty rows kept, so it pastes back at the
  anchor as-is — the first version dropped empty rows and would restore one row high; its
  fetch is bounded (50-row window + a display-only `values.get` count, skipped past 200k
  cells as `cells: not counted`); a `#REF!` fix line shows the formula before and after and
  its runnable `--cell` carries the current formula, whose surviving references are already
  shifted. Two more live probes (2026-10-25): deleting every **non-frozen** row/column is a
  400 ("not possible to delete all non-frozen rows") → refused locally; an insert inside a
  data-validation or conditional-format range extends it even under `--no-inherit` →
  disclosed. Live after the fixes: `delete-rows 3:5` with an empty row 3 rendered rows 3–4
  anchored at 3; a delete breaking `=B4+B17` reported `it is now =#REF!+B15` with that as the
  runnable fix; `2:995` under a 1-row freeze refused; `Big!1:8000` (208,000 cells) reported
  `cells: not counted` with the 50-row window.

## Follow-ups

None.
