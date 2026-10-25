---
status: planned
depends: []
specs:
  - specs/commands/sheets-write.md
---

# Plan: Header-keyed update (sheets update --key)

## Scope

`sheets update --json --key <header>`: JSON objects keyed by the header row edit **existing**
rows found by a label column, through the `--cell` write path (one `values.batchUpdate`,
pre-read, `unchanged`, read-back, error diff). `ROW_NOT_FOUND` / `ROW_AMBIGUOUS` before any
write; `--append-missing` appends the unmatched objects through the keyed `append` path.
The `rows[N]{key,row,cells}` match report.

**Out of scope:** matching on more than one key column; fuzzy or case-insensitive label
matching; `--key` on `append` (append has no rows to match).

## Implements

- `specs/commands/sheets-write.md` — § Header-keyed rows (the `update --key` half), § Output
  (`rows[]`), § Errors (`ROW_NOT_FOUND`, `ROW_AMBIGUOUS`, the new `VALIDATION_ERROR` cases).

## Approach

1. **Flags** (`write.ts` `parseUpdateFlags`): `--key` (value), `--append-missing` (boolean);
   `--key` requires `--json` and a source and excludes `--range`/`--cell`/`--header`;
   `parseJsonGrid` with `allowObjects` for `update` when `--key` is set (and refused with
   the existing message when it is not).
2. **Match** (`values.ts` or a new `keyed.ts`, pure): `matchKeyedRows(objects, header, keyCol,
   column cells)` → per object `{row0, cells: CellArg[]}` or an error; reads the key column
   via one `fetchGrid` of `<keyCol>2:<keyCol>` (display text) plus the header row (shared
   with `appendKeyed`).
3. **Write**: build a `{kind: "cells"}` plan from the matches and hand it to `writePlan`;
   then, with `--append-missing`, the unmatched objects through `appendKeyed`. Render as
   `update` with the `rows[]` block inserted after the summary.
4. Help text, `flag-declarations` test, README § Sheets example, CLAUDE.md status.

**Concurrency note:** same wave as `sheets-tabs`, `sheets-dimensions`, `sheets-note`;
this plan edits `write.ts` and `values.ts` in place (the others only append to
`sheets.ts`/`shared.ts`/README/CLAUDE.md). Keep README/CLAUDE.md additions grouped.

## Validation

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Unit: `matchKeyedRows` — match, no match, ambiguous, missing key in object, duplicate
      key in block, `--key` not a header, header gap, key default to column A.
- [ ] Live: on a tracker tab, `update --key Name` with two objects changes exactly the named
      cells of the two rows (snapshot diff), reports `rows[]`, leaves formats; re-run is
      `unchanged`; a formula in the row shows its result in `formulas[]`.
- [ ] Live: an unknown label is `ROW_NOT_FOUND` with nothing written; with
      `--append-missing` it is appended under the headers and `rows[]` marks it; a duplicated
      label is `ROW_AMBIGUOUS`.
- [ ] Live: `--key` with `--range` / `--cell` / `--header` is refused.

## Risks / unknowns

- **Display-text matching**: the key column is matched on `formattedValue`, so a numeric id
  column formatted `0001` matches `"0001"`, not `"1"`; the spec says "displays". Document
  in help.

## Notes

(At closeout.)

## Follow-ups

(At closeout.)
