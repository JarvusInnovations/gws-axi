---
status: in-progress
depends: []
specs:
  - specs/commands/sheets-write.md
  - specs/commands/sheets-read.md
  - specs/commands/sheets-cell.md
  - specs/commands/drive-upload.md
---

# Plan: Sheets writes (update, append, clear, create, add-tab)

## Scope

The five scaffolded `sheets` write stubs become real: the value-block grammar (CSV/TSV/JSON,
header-keyed objects, input mode), the three range commands (`update` with `--range` or
`--cell`, `append`, `clear`) with the pre-read comparison, the post-write read-back
(`written[]`, `errors[]`), grid growth and the `--header` freeze, and the two structure
commands (`create`, `add-tab`) that seed a new surface through the same write path. On the
read side, `sheets read` gains `formulas[]` / `--formulas` and `errors[]` from the same
`includeGridData` call it already makes, and `sheets cell` is the one-cell detail view that
shows a formula beside the current values of what it references. The `drive upload`
CSV signposts turn around to point here, and `sheets --help` loses its `alternatives[]` block.

**Out of scope** (issues, not plans): formatting, widths, validation, merges beyond the
`--header` freeze; cell notes; a `sheets tabs` group for rename/reorder/delete; row/column
insertion that shifts data; multi-block batches; header-keyed `update`.

## Implements

- `specs/commands/sheets-write.md` — the whole spec: § The value block, § Input mode,
  § Choosing the tab, § The range, § Behavior (all five), § Output, § Errors, § Upstream
  behavior relied on, § Dispatcher.
- `specs/commands/sheets-read.md` — § Flags (`--formulas`), § Data Requirements (the wider
  fields mask), § Formulas, § Error values, the fidelity disclosure and the two new `help[]`
  lines.
- `specs/commands/sheets-cell.md` — the whole command.
- `specs/commands/drive-upload.md` — the `.csv`/`.tsv` help line and the Out-of-scope
  pointer to `sheets update` / `sheets append`.

## Approach

Range commands first, structure commands on top of them; one branch, one PR.

1. **Probe first** (a scratch spreadsheet in the owner's safe-to-delete folder, driven by hand
   through the API before any command exists): every "To verify live" row of the spec's
   upstream table. Record each outcome in the table in the same PR; a contradicted row
   changes the spec — as its own `docs(specs):` commit — before code is written to it.
2. **Value block** (`src/commands/sheets/values.ts`): `parseCsv(text, sep)` — a small RFC 4180
   reader (quotes, doubled quotes, embedded newlines, CRLF; an unterminated quote is a
   `VALIDATION_ERROR` naming the line), no new dependency; `parseJsonGrid(text)` — 2-D array
   check with per-cell type validation, `null` passthrough, or (for `append`) an array of
   objects plus `mapKeyedRows(objects, headerCells)` → grid with `null` gaps and
   `COLUMN_NOT_FOUND`; `parseCellArgs(["B5=4800", …])` for `--cell`; `blockShape(rows)`.
   Pure, unit-tested.
3. **Source reading**: lift `readSource` and the one-source rule out of `docs/write.ts` into a
   shared helper (`src/util/source.ts`) and route `docs` through it too
   ([single-source-of-truth-helpers](../specs/principles.md#single-source-of-truth-helpers));
   a `.tsv` extension selects the tab separator.
4. **Tab + range resolution** (`src/commands/sheets/shared.ts`): factor the tab listing and
   resolution out of `read.ts` (`toTabInfo`, title-then-gid, `quoteTitle`,
   `splitQualifiedRange`) so read and write resolve one way; add `TAB_REQUIRED` for writes.
   A1 parsing: extend `parseRangeOrigin` with an end corner (`B2:D9` → rows 2–9, cols B–D)
   and the column-/row-only forms; `rangeFits(block, range)`.
5. **Pre-read** (`update`, `clear`): `spreadsheets.get` with `includeGridData`, the target
   range, and `fields=sheets(data(rowData(values(userEnteredValue,formattedValue))))`; the
   comparison from § Behavior as a pure `diffBlock(current, input, mode)` returning per-cell
   `{cell, before, changed}`. Unit-tested on every kind × mode case the spec names. The same
   fetch shape serves the **read-back** after the write (`formattedValue`, `effectiveValue`),
   from which `formulas[]` (every formula in the block, uncapped) and `written[]` (before ≠
   input, or now ≠ input, non-formula) are built by a pure
   `reportWrite(pre, input, post)`; `--cell` passes one `ranges` entry per cell to both.
   **Error scan**: both fetches add a whole-tab `ranges` entry under the errors-only mask
   (when the allocation is ≤ 200k cells; else the written range, disclosed); a pure
   `diffErrors(before, after, writtenCells)` yields `errors[]` (new or written), `errors_fixed`,
   `errors_elsewhere`; `fixLines(errors, formulasById)` renders the `--cell` fix commands with
   each cell's current formula and, for collateral errors, the written cell its formula
   references. The read reuses `fixLines`.
6. **Grid growth**: compare the block's extent against `gridProperties`; when larger, one
   `batchUpdate` `updateSheetProperties` (`gridProperties.rowCount/columnCount` with a fields
   mask) before the values call.
7. **Range commands** (`src/commands/sheets/write.ts`): `update` → `values.update`
   (`values.batchUpdate` with one `ValueRange` per `--cell`), then `updateSheetProperties`
   `frozenRowCount: 1` for `--header` unless the pre-read already shows a freeze; `append`
   → `values.append` (`insertDataOption: INSERT_ROWS`, range = the quoted tab title), parse
   `updates.updatedRange` for the response; `clear` → `values.clear`. Output per § Output
   through `renderObject`/`renderList`; `overwritten[]` capped at 50 with `overwritten_total`.
   Error translation: `RANGE_INVALID` from the "Unable to parse range" 400, `PROTECTED_RANGE`
   from the 403 the probe recorded.
8. **`create`** (`src/commands/sheets/create.ts`): Drive `files.create` (spreadsheet MIME,
   name, `parents`, `fields: id,name,webViewLink`); with `--tab`, one `batchUpdate`
   (`updateSheetProperties` renames the first tab by the pre-read's gid, `addSheet` per further
   title); then the seed write through the shared `update` path at `A1` of the first tab. A
   failure after the file exists → `WRITE_INCOMPLETE` naming the id (the file is not deleted;
   it is the caller's now and `drive trash` is one command away).
9. **`add-tab`** (`src/commands/sheets/add-tab.ts`): pre-read tabs; same title → `exists`;
   placement → `index` per the spec's arithmetic; `addSheet`; seed write; on seed failure
   `deleteSheet` then rethrow, `WRITE_INCOMPLETE` if the delete also fails. The listing
   renderer from `read.ts` closes the response.
10. **Read side** (`src/commands/sheets/read.ts`): widen the fields mask; `extractGrid` keeps
    `formula` and `error` per cell; `formulas[]` (cap 20, `formulas_total`), `errors[]` (cap
    50), `--formulas` swaps the rendered value; the two `help[]` lines. Unit tests on fixtures
    with a formula cell, an error cell and both.
11. **`sheets cell`** (`src/commands/sheets/cell.ts`): `parseFormulaRefs(formula)` — a pure
    tokenizer for A1 cells/ranges (absolute, tab-qualified, column/row-only), named ranges,
    skipping string literals and function names, flagging `INDIRECT`/`OFFSET` as dynamic;
    `namedRanges` resolution; one multi-`ranges` fetch; breadth-first `--depth` with cycle
    detection. Shares `fixLines`. Unit tests on the tokenizer (every form in the spec, a
    quoted-string decoy, `Sheet1!A1:B2`, a named range) and the cycle case.
12. **Dispatcher** (`sheets.ts`): the five entries get `flags: "self"` and handlers, and lose
    `instead`; `REPLACE_WHOLESALE` / `CREATE_VIA_UPLOAD` go away (the `renderAlternatives`
    call stays — it renders nothing when no stub remains). `drive upload`: the CSV/TSV line +
    the `MULTI_TAB_TARGET` suggestion. Help text, `flag-declarations` test, README § Sheets,
    CLAUDE.md status.

## Validation

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Unit: CSV reader on quoted commas, doubled quotes, embedded newlines, CRLF, ragged rows,
      unterminated quote; JSON grid on typed cells, `null`, 1-D input, nested objects.
- [ ] Unit: `diffBlock` — string/number/bool/formula vs each stored kind under both modes;
      the "unsure → changed" cases; `reportWrite` on before≠input, now≠input, error cells,
      and the omitted "empty before, now = input" case; `parseCellArgs` on `=`-bearing values,
      duplicates, tab-qualified cells; `mapKeyedRows` on missing and unknown keys.
- [ ] Unit: range fit — anchor cell, bounding range too small, `B:B`, `3:3`; grid-growth
      arithmetic; placement index for `--first`/`--last`/`--before`/`--after`; conflicting
      placement flags and duplicate `--tab` titles refused.
- [ ] Every "To verify live" row in the spec's upstream table is **Observed** (or the spec was
      amended), with a date.
- [ ] Live: `update` at an anchor writes the block and nothing else — the tab's other cells,
      number formats, a column width and a data-validation rule are identical before/after
      (`includeGridData` diff).
- [ ] Live: re-running the same `update` is `action: unchanged` with no values call; a
      changed cell reports `changed: 1` and a `written[]` row with the previous value.
- [ ] Live: writing `=B2*C2` reports it in `formulas[]` with `result: $9,600`; writing
      `=Cost!B2` on a tab with no `Cost` reports it in `errors[]` with Sheets' message, a
      `Fix D2 …` help line carrying that formula, and `action: updated`, exit 0; writing `1/2`
      reports `now: 1/2 (date <year>-01-02)` and the hazard help line (amended: Sheets keeps
      displaying `1/2` under an `m/d` date format, so the spec annotates the date).
- [ ] Live: writing text into a cell an arithmetic formula reads (`=B2+B3+B4`, `=B3*C3`)
      reports that formula in `errors[]` with `written: no` and names the written cell in its
      fix line (amended: `SUM` ignores text, so it cannot error this way; a `SUM` over an
      erroring cell propagates and is reported too); `clear` of a cell a division reads reports
      the `#DIV/0!` (amended: a cleared cell reads as empty/0 — clearing never yields `#REF!`);
      re-writing correctly reports `errors_fixed`; a pre-existing unrelated error shows only as
      `errors_elsewhere`.
- [ ] Live: the errors-only mask on a healthy 1000×26 tab — response size and latency
      recorded in Notes; the 200k bound kept or amended from the measurement.
- [ ] Live: `--cell B5=4800 --cell C9=3 --cell D2='=B2*C2'` writes all three in one
      `values.batchUpdate` with one pre-read and one read-back; a bad cell ref writes nothing.
- [ ] Live: `create … --header` freezes row 1; `sheets read` then auto-promotes
      (`header_source: frozen-row`); re-running `update --range A1 … --header` sends no freeze;
      a tab frozen at 2 rows reports `frozen (2 rows, unchanged)`.
- [ ] Live: header-keyed `append --json '[{"Name":"x","Status":"done"}]'` lands the values
      under those header cells and leaves the unnamed columns empty; an unknown key is
      `COLUMN_NOT_FOUND` listing the headers.
- [ ] Live: `sheets read` on the tab lists `formulas[N]{cell,formula}` with the formulas as
      entered, `--formulas` renders them in the grid, and a broken formula appears in
      `errors[]` with the count as the first `help[]` line and a `sheets cell` line.
- [ ] Live: `sheets cell` on `=B2*C2` where `C2` is text shows the `#VALUE!` message and
      `refs[]` with `C2,text,n/a`; on `=SUM(Cost!B2:B500)` shows 20 ref rows, `ref_cells_total`
      and a cross-tab ref; `--depth 2` expands a referenced formula; an `INDIRECT` ref is
      `kind: dynamic`.
- [ ] Live: a block wider than the tab grows the grid and reports `grid:`; the same block
      without growth is what upstream refuses (amended: upstream refuses a range or anchor
      outside the allocation, and grows a block spilling from an anchor inside it itself).
- [ ] Live: `append` lands after the last data row and `range:` matches where the rows
      appear; a tab with a blank row inside its data is checked and the outcome recorded.
- [ ] Live: `--json` with `null` leaves a cell untouched; a CSV empty field clears it; `--raw`
      stores `=1+1` as text while the default stores a formula whose read-back is `2`.
- [ ] Live: `clear --range` empties values and keeps a bold format; `clear` without
      `--range`/`--all` is refused; `clear` on an empty range is `unchanged`.
- [ ] Live: multi-tab spreadsheet without `--tab` → `TAB_REQUIRED` and nothing written.
- [ ] Live: `create --title --parent --tab A --tab B` with a CSV seed → file in the folder,
      tabs `A`,`B` in order, values in `A` at `A1`, listing in the response.
- [ ] Live: `add-tab --after A --title C` lands between `A` and `B`; re-running is
      `action: exists` with `C`'s gid and no change to the spreadsheet.
- [ ] Live (or unit on the request sequence, if no live failure is practical — say which in
      Notes): a seed write that fails deletes the new tab and the error says so.
- [ ] `gws-axi sheets --help` has no `alternatives[]` block; no `sheets` subcommand throws
      `NOT_IMPLEMENTED`; every write's `--help` matches its flag declaration.
- [ ] `drive upload x.csv --convert` shows the `sheets update` line.
- [ ] Implementation branch follows the branch-update rule (rebased, never back-merged);
      the closeout commit is last.

## Risks / unknowns

- **`USER_ENTERED` comparison** — the "unsure → changed" rule makes most string inputs
  against numeric cells re-write every time; harmless, but `unchanged` will fire less often
  than it looks. If live use shows it never fires, consider comparing `formattedValue` too.
- **`append` placement** — upstream's table detection is documented loosely; the probe
  decides the wording of the spec's placement sentence.
- **Protected-range error shape** — classified from whatever the probe returns; if it is a
  bare 403, `PROTECTED_RANGE` may have to give way to a translated `PERMISSION_DENIED` with
  the hint.
- **Large blocks** — no local cap; the API's request-size limit is the only one. Add a cap
  with a clear error if a live write hits it.
- **`files.create` first-tab name** — the rename targets the pre-read's gid, not the name
  `Sheet1`, so a localized default name is harmless; confirm anyway.
- **Forcing a seed failure live** may need a contrived case; the validation line allows a
  unit test on the request sequence instead, disclosed in Notes.

## Notes

(At closeout.)

## Follow-ups

(At closeout.)
