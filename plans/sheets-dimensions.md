---
status: planned
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

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Unit: the dimension parser on every accepted and refused form; the `shifted` sentence
      for insert and delete; delete-all refusal; start-past-allocation refusal.
- [ ] Every "To verify live" row Observed (or amended) with a date.
- [ ] Live: `insert-rows 3:5` on a formatted table — rows 3–5 empty with the table's
      formatting, old row 3 at 6, a `SUM(B2:B9)` below now reads `B2:B12`, `inherit: from
      row 2`; `--no-inherit` leaves them unformatted; `insert-rows 1` reports `inherit: from
      row N (was row 1)` (amended: upstream has no un-inherited insert — see the spec's
      `inheritFromBefore: false` row).
- [ ] Live: `delete-rows 3:5` reports the removed cells in `cells[]` with old row numbers,
      the `shifted` sentence, and a `#REF!` in a formula that read a deleted cell, with a fix
      line; `errors_fixed` when re-inserting and re-filling.
- [ ] Live: `insert-cols B:C` / `delete-cols B` the same way; a protected range is
      `PROTECTED_RANGE`.
- [ ] Live: deleting inside frozen rows reports the new `frozen_rows`.

## Risks / unknowns

- **Formula shifting** is Sheets' own; the spec only promises to report errors, not to
  predict shifts. Keep it that way.
- **Delete undo** is "insert + update": the help line spells it out; no combined undo verb.

## Notes

(At closeout.)

## Follow-ups

(At closeout.)
