---
status: done
depends: []
specs:
  - specs/commands/sheets-write.md
pr: 141
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

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit: `matchKeyedRows` — match, no match, ambiguous, missing key in object, duplicate
      key in block, `--key` not a header, header gap, key default to column A.
- [x] Live: on a tracker tab, `update --key Name` with two objects changes exactly the named
      cells of the two rows (snapshot diff), reports `rows[]`, leaves formats; re-run is
      `unchanged`; a formula in the row shows its result in `formulas[]`.
- [x] Live: an unknown label is `ROW_NOT_FOUND` with nothing written; with
      `--append-missing` it is appended under the headers and `rows[]` marks it; a duplicated
      label is `ROW_AMBIGUOUS`.
- [x] Live: `--key` with `--range` / `--cell` / `--header` is refused.

## Risks / unknowns

- **Display-text matching**: the key column is matched on `formattedValue`, so a numeric id
  column formatted `0001` matches `"0001"`, not `"1"`; the spec says "displays". Document
  in help.

## Notes

- **Spec amended before the code** (`docs(specs)` commit): the column-A default for `--key`
  contradicted the error table's "objects on `update` without `--key`". Objects with neither
  `--range` nor `--cell` are now a keyed update, and objects beside `--range` are refused.
  `--append-missing` rows ride the matched cells' `values.batchUpdate`, so one pre-read,
  read-back and error diff covers the whole block. `rows[]` gained a per-row `unchanged`.
- Matching lives in `src/commands/sheets/keyed.ts` (pure). It reuses `mapKeyedRows` for header
  alignment, so unknown keys stay `COLUMN_NOT_FOUND` and the `--key`-not-a-header case is in
  `resolveKeyColumn`. The per-row action comes from `WriteOutcome.changedCells`, added to
  `writePlan`.
- Display-text matching was confirmed live: a `0000`-formatted `1` matched `"0001"` and not `1`.
  `ROW_NOT_FOUND` hints a case-only near miss (`"ship IT"`: row 2 displays `"Ship it"`).
- Live evidence: a snapshot diff of the two-object write changed only the named cells (formats
  stayed) plus the dependent formula's result. The re-run was `unchanged` with no write. Refusals
  wrote nothing (identical snapshot). An appended row landed at column A under the headers, and
  its re-run matched.
- **Review round (PR #141)**, spec amended first (`docs(specs)`), then one `fix(sheets)`:
  - `--header` is refused on the default-key route too. One helper serves both keyed routes.
  - A near miss is `ROW_NOT_FOUND` even under `--append-missing`. That covers case only, and a
    number shown formatted (`7.00`, `$1,200`, `0001`). Appending it would have left the real
    row stale and created a duplicate.
  - Keyed plans read one rect per row (`WritePlan.rows`), not one range per cell, so a large
    sync is no longer a ~16 KB URL. `range:` is the bounding rect plus `(N rows)`.
  - Each matched row's key cell is re-read in the pre-read. A row that moved is the new
    `ROW_MOVED`, with nothing written.
  - The key-column read is clipped to the allocation and skipped on a header-only tab.
  - Checked live: `--header` refused; a case near miss and `1` vs `0001` refused under
    `--append-missing`; a 3-row write printed `Tasks!A2:G8 (3 rows)`; a 1-row header-only tab
    appended under `--append-missing`.
  - `ROW_MOVED` is covered by unit tests only, because the race can't be staged reliably live.
- Not exercised live: a keyed update on a tab above the 200k-cell error-scan bound, and `--raw`
  with a keyed block. Both go through the shared `writePlan` path.

## Follow-ups

None.
