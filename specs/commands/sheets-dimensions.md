# Command group: sheets insert-rows, insert-cols, delete-rows, delete-cols

## Summary

Structural edits that **shift data in place**: insert empty rows or columns at a position
(everything below or to the right moves), or delete rows or columns (everything after them
moves up or left). `sheets append` only ever adds rows at the end and `sheets clear` empties
cells without moving anything; these four are the verbs for "make room in the middle" and
"take this row out". Formulas elsewhere are adjusted by Sheets on an insert and turn `#REF!`
on a delete that removes what they read — both reported.

No new scope: `insertDimension` / `deleteDimension` under the `spreadsheets` grant.

## Invocation

```
gws-axi sheets insert-rows <spreadsheetId> <rows> [--tab <name|gid>] [--no-inherit]
gws-axi sheets insert-cols <spreadsheetId> <cols> [--tab <name|gid>] [--no-inherit]
gws-axi sheets delete-rows <spreadsheetId> <rows> [--tab <name|gid>]
gws-axi sheets delete-cols <spreadsheetId> <cols> [--tab <name|gid>]
```

- `<rows>` is an A1 row range: `3:5`, or `3` for one row; `<cols>` an A1 column range: `B:D`,
  or `B` for one. Either may be tab-qualified (`Costs!3:5`), which makes `--tab` optional and
  must agree with it when both are given. Anything else (`B2:D9`, `3:B`) is a
  `VALIDATION_ERROR` naming the two forms.
- **Insert** means: after the call, **those** rows/columns are the new empty ones. `insert-rows
  3:5` inserts three rows so that rows 3–5 are empty and the old row 3 is now row 6.
  `insert-rows 1` inserts above everything.
- **Delete** means: those rows/columns are removed, and what followed moves up/left.
- `--tab` — as every `sheets` write: required on a multi-tab spreadsheet (`TAB_REQUIRED`).
- `--account <email>` — REQUIRED when 2+ accounts are authenticated.

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| `insertDimension` with `range{sheetId,dimension,startIndex,endIndex}` inserts `end−start` empty rows/columns **before** `startIndex`; `inheritFromBefore: true` copies the formatting of the row/column before the range, and is refused (400) when `startIndex` is 0 | Documented. **To verify live** |
| Formulas referencing rows/columns at or after an insertion point are shifted by Sheets; a range that spans the insertion point grows | Documented (as the editor does). **To verify live** |
| `deleteDimension` removes the range; what follows moves up/left; formulas that referenced a deleted cell become `#REF!`; a range partly deleted shrinks | Documented. **To verify live** |
| Deleting every row (or every column) of a sheet is refused (400) | Documented. **To verify live** for the message |
| Deleting rows inside the frozen area reduces the frozen count; deleting all frozen rows is allowed | **To verify live** |
| An insert that would exceed the 10,000,000-cell spreadsheet limit is refused (400) | Documented. Not exercised; translated generically |
| A protected range overlapping the dimension is refused (400 "protected cell or object") | **Observed 2026-10-24** (`sheets-write.md`) for a values write; **to verify** for a dimension request |

## Behavior

### Common

1. **Read**: the tabs (`spreadsheets.get`, properties) to resolve the tab and its allocation;
   the dimension range is checked against the allocation (`VALIDATION_ERROR` when the start
   is past it; an insert may *extend* it, and does — see below). The whole-tab errors-only
   scan runs when the allocation is ≤ 200,000 cells, as every `sheets` write does
   ([sheets-write.md § Formula errors](sheets-write.md#formula-errors-the-feedback-loop)).
2. **Write**: one `batchUpdate` with the one dimension request.
3. **Read back**: the errors-only scan again; the diff is reported. For a delete, the
   populated cells of the deleted range were read **before** the write and are the undo.

### Insert

- `inheritFromBefore` is **true by default** when the insertion point is not the first
  row/column: the new rows take the formatting of the row above (the editor's "insert
  below" behavior — a row inserted mid-table gets the table's borders and number formats,
  which is what a human doing this gets). `--no-inherit` turns it off. At row/column 1 it is
  always off (upstream refuses it), and the response says `inherit: none`.
- The tab's allocation grows by the inserted count (upstream does this); the response
  carries `grid: R×C` after.
- A request that starts **past** the current allocation is a `VALIDATION_ERROR` pointing at
  `sheets update --range` (which grows the grid) — inserting at row 5000 of a 1000-row tab is
  not "make room", it is a typo.
- **Not idempotent**: re-running inserts again. The response says so.

### Delete

- Before the write, the deleted range's populated cells are fetched (the write mask:
  entered value + display) and rendered in the read's grid shape, capped at 50 rows with
  `cells_total` past the cap — the undo record, as `written[]` is for a value write.
- A delete covering the whole allocation (every row, or every column) is refused locally
  with `VALIDATION_ERROR`, pointing at `sheets clear --all` or `sheets tabs delete`.
- Deleting inside the frozen rows/columns is allowed; the response notes the new freeze
  count when it changed.
- **Not idempotent** in the usual sense: a second identical call deletes the rows that
  moved into the range. The response says so, naming the rows that now occupy the range.

## Output

```
account: alice@example.com
action: inserted
spreadsheet:
  id: 1AbC…
  title: Q4 Tracker
  tab: Costs
  gid: 0
  web_view_link: https://docs.google.com/spreadsheets/d/1AbC…/edit#gid=0
range: Costs!3:5
count: 3
shifted: rows 3 and below moved down by 3 (old row 3 is now row 6)
inherit: from row 2
grid: 1003×26
help[3]:
  Run `gws-axi sheets update 1AbC… --tab Costs --range A3 <source> --account alice@example.com` to fill the new rows
  Re-running inserts three more rows at 3:5 (not idempotent); `gws-axi sheets delete-rows 1AbC… 3:5 --tab Costs --account alice@example.com` undoes this
  Formulas below row 3 were shifted by Sheets; none errored
```

For a delete:

```
action: deleted
range: Costs!3:5
count: 3
shifted: rows 6 and below moved up by 3 (old row 6 is now row 3)
cells: 11
cells[3]{row,A,B,C,D}:
  3,bolts,40,"$4.00","$160.00"
  4,nuts,,"$0.20",
  5,washers,200,"$0.05","$10.00"
errors: 1
errors[1]{cell,error,message,written}:
  D12,REF,…,no
help[4]:
  1 formula error after this delete — see errors[]
  Fix D12 (#REF!, …): gws-axi sheets update 1AbC… --tab Costs --cell D12='=SUM(D2:D11)' --account alice@example.com
  The deleted cells are above and in version history: `gws-axi drive revisions 1AbC…`; `gws-axi sheets insert-rows 1AbC… 3:5 --tab Costs` then `sheets update --range A3` restores them
  Rows 3:5 are now what was 6:8 — re-running would delete those
```

- `range` — the tab-qualified dimension range as given; `count` the number of rows/columns.
- `shifted` — one sentence stating the move in old-row terms, so an agent holding a stale read
  can re-address.
- `inherit` (insert) — `from row N` / `from column X` / `none`.
- `grid` — the tab's allocation after an insert.
- `cells` + `cells[N]{row,…}` (delete) — the populated cells removed, in the read's grid
  shape; the block's `row` numbers are the **old** numbers. Omitted (`cells: 0`) when the
  range held nothing.
- `errors[]`, `errors_fixed`, `errors_elsewhere`, `error_scan` — exactly as a value write.
- `frozen_rows: N` / `frozen_cols: N` (delete) — only when the freeze count changed.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | Missing id or range; a range that is not a row range (for `*-rows`) or column range (for `*-cols`); `--tab` disagreeing with a qualified range; start past the allocation (insert) or past the data (delete); a delete covering every row/column; `--no-inherit` on a delete |
| `SPREADSHEET_NOT_FOUND`, `TAB_REQUIRED`, `TAB_NOT_FOUND` | As `sheets update` |
| `PROTECTED_RANGE` | Upstream refused because a protected range overlaps |

## Dispatcher

Four `{ mutation: true }` entries with their own `FlagSpec`s; the shared dimension-range
parser lives beside `parseA1`. `sheets --help` groups them under writes.

## Out of scope

- **Moving** rows/columns (`moveDimension`), **resizing** them (`updateDimensionProperties`
  pixel size), **hiding** them — later verbs if asked for; hiding is formatting-adjacent.
- **Grouping** (`addDimensionGroup`).
- **Insert with content in one call** — insert, then `sheets update --range`, which the
  help line spells out; a combined form is a convenience to add once the pair is in use.

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
- [provenance-by-default](../principles.md#provenance-by-default) — a delete carries the
  cells it removed.
- [fail-loud-on-unknown-flags](../principles.md#fail-loud-on-unknown-flags) — a range of the
  wrong shape is refused, never reinterpreted.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — the undo and
  the "what is at that range now" line.

**Local:**

- **Say where everything went.** A structural edit invalidates every A1 address the agent is
  holding from its last read. The response states the shift in old-row terms and names the
  new occupant of the edited range, so the next command is addressed right without a
  re-read. Inherited from [sheets-write.md](sheets-write.md)'s "the response is the proof",
  applied to position instead of value.
- **The editor's default for formatting continuity, nothing more.** An inserted row inherits
  its neighbor's formatting because that is what the editor does and a table with one
  unbordered row is a defect, not a choice; the flag to turn it off exists because the
  `sheets` writers otherwise never touch formatting.
