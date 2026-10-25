# Command group: sheets update, sheets append, sheets clear, sheets create, sheets add-tab

## Summary

The write side of [`sheets read`](sheets-read.md). Each command puts **values** into one range
of one tab, or makes a spreadsheet or tab to put them in, and leaves everything it did not
name — other tabs, other cells, formatting, column widths, data validation, protected ranges —
exactly as it was:

- **`sheets update`** writes a rectangular block of values at a cell, or into a range.
- **`sheets append`** adds rows after the last row of a tab's data.
- **`sheets clear`** empties the values of a range (formatting stays).
- **`sheets create`** makes a new spreadsheet, optionally with initial values.
- **`sheets add-tab`** adds a tab, optionally with initial values.

They exist because the only write path before them, `drive upload --update --convert`,
replaces a spreadsheet **wholesale**: every tab but the first is destroyed and every format is
dropped (`MULTI_TAB_TARGET` in [drive-upload.md](drive-upload.md) § Multi-tab targets). An
agent that read one tab with `sheets read` and wants to change three cells needs a command
that changes three cells.

No new scope: the `spreadsheets` grant `sheets read` already requires authorizes
`spreadsheets.values.*`, `spreadsheets.create` and `spreadsheets.batchUpdate`; `drive` covers
`--parent` on `create`. Accounts that re-authed for `sheets read` need nothing further.

## Invocation

```
gws-axi sheets update  <spreadsheetId> --range <A1> (<file> | - | --content <values>) [--tab <name|gid>] [--json | --tsv] [--raw]
gws-axi sheets append  <spreadsheetId> (<file> | - | --content <values>) [--tab <name|gid>] [--json | --tsv] [--raw]
gws-axi sheets clear   <spreadsheetId> (--range <A1> | --all) [--tab <name|gid>]
gws-axi sheets create  --title <title> [<file> | - | --content <values>] [--tab <title>] [--parent <folderId>] [--json | --tsv] [--raw]
gws-axi sheets add-tab <spreadsheetId> --title <title> [<file> | - | --content <values>] [--first | --last | --before <tab> | --after <tab>] [--json | --tsv] [--raw]
```

Every command takes `--account <email>`, REQUIRED when 2+ accounts are authenticated
([write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)).

### The value block

`update`, `append`, `create` and `add-tab` take values the way `docs write` takes Markdown: a
readable local file, `-` for stdin, or `--content <string>`, **exactly one**. Missing path →
`LOCAL_FILE_NOT_FOUND`; a directory → `LOCAL_PATH_NOT_FILE`; none or more than one →
`VALIDATION_ERROR`. For `create` and `add-tab` the source is optional (none → empty).

The block is a grid of rows. Two encodings, chosen by flag, never by sniffing:

- **CSV (default)** — RFC 4180: comma-separated, `"…"` quoting, `""` for a literal quote,
  newlines inside quotes allowed, `\r\n` or `\n` rows. A `.tsv` file, or `--tsv`, switches the
  separator to a tab. Every field is a string; what it *becomes* in the cell is the input
  mode's business (next section). An **empty field writes an empty cell** — it clears what was
  there. There is no way to skip a cell in CSV.
- **JSON (`--json`)** — a 2-D array of rows. Strings, numbers and booleans are written as
  typed values; **`null` leaves that cell untouched**; `""` clears it. A one-dimensional array
  is a `VALIDATION_ERROR` naming the shape (a single row is `[[…]]`). Anything else that is not
  a string, number, boolean or null (an object, a nested array) is a `VALIDATION_ERROR` naming
  the cell.

Rows may be ragged; short rows are left short (the cells beyond them are untouched, not
cleared). The block's **shape** is `rows × columns` where `columns` is the longest row, and
the response reports it. An empty block (no rows, or every row empty) on `update` or
`append` is a `VALIDATION_ERROR` — `clear` is the command for emptying.

### Input mode

What Sheets makes of a string is the choice between `USER_ENTERED` and `RAW`
(`valueInputOption`). The default is **`USER_ENTERED`**: a string is parsed as if typed into
the cell, so `=SUM(B2:B9)` is a formula, `2026-10-24` a date, `$5.00` a currency, `TRUE` a
boolean, `42` a number. `--raw` stores every string **verbatim** — `=SUM(...)` is the text
`=SUM(...)`. The response echoes `input: user-entered | raw`.

`USER_ENTERED` is the default because it round-trips `sheets read`: the read renders the
*displayed* strings, and typing a displayed string back produces the same cell. It is also the
only mode that writes a formula. The hazard — a value that looks like a date or number and was
meant as text (`1/2`, a zip code with a leading zero) — is disclosed by a standing `help[]`
line naming `--raw`, and the typed-JSON encoding sidesteps it for numbers.

### Choosing the tab

- `--tab <name|gid>` — by title, then by numeric `sheetId`, exactly as `sheets read` resolves
  it. Titles are unique within a spreadsheet, so unlike a Doc tab a title is a safe address.
- A tab-qualified `--range` (`Costs!B2`) names the tab; `--tab` is then optional and, if also
  given, must agree (`VALIDATION_ERROR` otherwise).
- Omitted on a single-tab spreadsheet → that tab.
- Omitted on a multi-tab spreadsheet → `TAB_REQUIRED`, carrying the `sheets[N]{gid,title,…}`
  listing so the next call can name one. Nothing is written. **There is no all-tabs write**;
  that is `drive upload --update --replace-all-tabs`, by name.
- `--tab` naming no tab → `TAB_NOT_FOUND`, with the listing.

Only grid tabs are addressable; a chart-only tab is `TAB_NOT_FOUND` with a note.

### The range (`update`, `clear`)

`--range` is an A1 reference within the tab, unqualified (`B2`, `B2:D9`) or qualified
(`Costs!B2:D9`). For `update`:

- A **single cell** is the block's top-left anchor; the block's shape sets the extent.
- A **range** bounds the write: a block larger than the range is a `VALIDATION_ERROR` naming
  both shapes, before any call. A block smaller than the range writes its own extent from the
  range's top-left and leaves the rest of the range untouched — it does **not** clear it. To
  clear, `sheets clear` first, or write empty fields.
- Column-only or row-only references (`B:B`, `3:3`) are accepted as ranges with the tab's
  allocated extent.

The written range is **grown into the tab's allocation when it would exceed it**: a 30-column
block at `A1` on a fresh 26-column tab makes the tab 30 columns wide (one
`updateSheetProperties` on `gridProperties` before the values call). Upstream refuses such a
write outright ("exceeds grid limits"); growing is what a human pasting the same block gets.
The response says `grid: grown to <rows>×<cols>` when it happened.

## Behavior

### `update`

1. **Read** the spreadsheet's tabs (`spreadsheets.get`, properties only) to resolve the tab,
   and the target range's current entered values (`includeGridData` with
   `userEnteredValue`), in one call where the tab is already known.
2. **Compare** each cell of the block with what is there. A cell is *unchanged* when its
   stored entered value is the same kind and the same text as what the input would store:
   a string against a `stringValue`, a formula (`=…`) against a `formulaValue`, a number or
   boolean against a `numberValue`/`boolValue` rendering to the same text. Anything the
   comparison cannot be sure of — a `USER_ENTERED` string that Sheets might parse into a
   different kind — counts as *changed*. The check errs toward writing: a false "changed"
   costs a harmless re-write; a false "unchanged" would leave the sheet wrong.
3. **Nothing changed** → `action: unchanged`, no write, exit 0.
4. **Write**: grow the grid if needed, then one `spreadsheets.values.update` of the block at
   the range with the chosen `valueInputOption`.

Formatting, data validation, notes, and the other cells of the tab are never touched; the
only requests sent are the values call and, when needed, the grid growth.

### `append`

1. **Read** the tabs to resolve the target.
2. **Write**: one `spreadsheets.values.append` with the tab as the range, `insertDataOption`
   `INSERT_ROWS` — the rows land after the last row that has data in the tab, as a new
   row each, shifting nothing. Upstream locates "the table" from the range; with the whole
   tab as the range that is the tab's data region. The response reports the **actual rows
   written** (`range: Costs!A12:C13`) from the API's `updatedRange`, so the caller sees where
   they landed — a tab with blank rows inside its data can place them later than its last
   visible row.
3. `append` is **not idempotent**: re-running adds the rows again. The response says so
   ([drive mkdir](drive-mkdir.md) sets the pattern). Rows are appended as a block; a
   partial append is not possible through this API.

### `clear`

1. **Read** the tabs, and the range's current values.
2. Already empty → `action: unchanged`, exit 0, nothing sent.
3. Otherwise one `spreadsheets.values.clear`. **Values only**: formatting, validation, notes
   and merges stay. `--all` clears the whole tab's values; one of `--range`/`--all` is
   required and both is a `VALIDATION_ERROR` — a bare `clear <id>` never empties a tab.

### `create`

1. Drive `files.create` with the spreadsheet MIME type, `--title` as the name, and
   `--parent` as `parents` when given (what lets a spreadsheet be born inside a folder;
   `spreadsheets.create` cannot). The result has one tab, `Sheet1`.
2. `--tab <title>` (repeatable) names the tabs: the first renames `Sheet1`, the rest are
   added in order (`batchUpdate`: `updateSheetProperties` + `addSheet`). Duplicate titles in
   the list are a `VALIDATION_ERROR` before any call.
3. A value block, when given, is written into the **first tab at `A1`** through the `update`
   path (grid growth included).
4. Not idempotent (Drive allows duplicate names); the response says so and names the id.

### `add-tab`

1. **Read** the tabs. A tab with the same title already exists → `action: exists`, exit 0;
   the response carries that tab's `gid`, and says placement flags and the value block were
   **not** applied. Idempotence is "a tab by that name exists", not "it looks like this".
2. One `batchUpdate` `addSheet` with `title` and the `index` the placement resolves to:
   `--first` → 0, `--last` (default) → the tab count, `--before <tab>` → that tab's index,
   `--after <tab>` → its index + 1; the anchor is resolved like `--tab` (`TAB_NOT_FOUND`
   otherwise). At most one placement flag.
3. A value block is written into the new tab at `A1` through the `update` path. A write
   that fails after the add **deletes the tab again** and the error says so — a failed call
   never leaves an empty tab behind (the rule `docs write --new-tab` follows).

## Output

Header: `action: updated | unchanged | appended | cleared | created | added | exists`, then
`account` (+ `account_source` per the standard rules).

```
account: alice@example.com
action: updated
spreadsheet:
  id: 1AbC…
  title: Q4 Tracker
  tab: Costs
  gid: 1374928
  web_view_link: https://docs.google.com/spreadsheets/d/1AbC…/edit#gid=1374928
range: Costs!B2:D4
shape: 3x3
cells: 9
changed: 4
input: user-entered
overwritten[3]{cell,before,after}:
  B2,"$4,200",4800
  C3,pending,done
  D4,,2026-10-24
help[3]:
  Run `gws-axi sheets read 1AbC… --tab Costs --range B2:D4` to read the range back
  Run `gws-axi drive revisions 1AbC…` for the version history; the pre-write version is the newest revision before this one
  Values were parsed as typed (USER_ENTERED): dates, numbers, currencies and =formulas take effect. Pass --raw to store strings verbatim
```

- `spreadsheet{id,title,tab,gid,web_view_link}` — `gid` is first-class; the link opens on
  that tab.
- `range` — the A1 range actually written, tab-qualified. For `append`, the rows the API
  reports. For `clear`, the range cleared.
- `shape`, `cells` — the block's rows×columns and the number of cells it carried (`null`
  cells excluded). `changed` — cells whose value differs after the write (`update` only).
- `grid: grown to <rows>×<cols>` — only when the tab was enlarged.
- `overwritten[N]{cell,before,after}` — every cell that **had a value** and received a
  different one, with `before` as the entered text (`FORMULA` render, so a formula shows as
  its formula) and `after` as the input text. Capped at 50 rows with the usual truncation
  marker; past the cap the header carries `overwritten_total` and `help[]` points at
  `drive revisions`. Cells that were empty are not listed — the block itself is the record
  of what went in. `clear` lists the cleared cells the same way with `after` empty. This is
  the undo line: the previous values are in the response, not behind a re-query
  ([provenance-by-default](../principles.md#provenance-by-default) applied to a write).
- `create` and `add-tab` end with the `sheets[N]{gid,title,index,rows,cols}` listing from
  `sheets read`, so the structure is confirmed without a read.

### help[] suggestions

- Read back: `sheets read <id> --tab <tab> --range <range>` (the written range); after
  `create`/`add-tab`, `sheets read <id> --tab <tab>`.
- Undo: `drive revisions <id>` — Sheets exposes no revision id to the API, so the suggestion
  names the version history rather than a specific revision.
- The input-mode line (above), on every `USER_ENTERED` write; under `--raw`, the converse
  (`=…` was stored as text).
- `append`: "re-running appends the same rows again".
- `update` with a block smaller than a given range: "N cells of the range were left as they
  were; `sheets clear` empties them".
- `create`: `drive share <id> --with <email>`; `sheets add-tab <id> --title <title>`.
- `add-tab` with `exists`: `sheets update <id> --tab <title> --range A1 …` to write into it.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | Source rules broken; both/neither of `--range`/`--all` on `clear`; `--tab` disagreeing with a qualified range; block larger than the range; empty block on `update`/`append`; malformed CSV (unterminated quote, with the line), malformed or non-2-D JSON; conflicting placement flags; duplicate `--tab` titles on `create`; `--json` with `--tsv` |
| `LOCAL_FILE_NOT_FOUND`, `LOCAL_PATH_NOT_FILE` | As `drive upload` |
| `SPREADSHEET_NOT_FOUND` | Absent, no access, or not a native spreadsheet — as `sheets read`, including the `drive upload --convert` redirect for an uploaded `.xlsx` |
| `TAB_REQUIRED` | Multi-tab spreadsheet, no tab named; carries the listing |
| `TAB_NOT_FOUND` | `--tab`, a qualified range, or a placement anchor names no grid tab; carries the listing |
| `RANGE_INVALID` | Upstream rejected the A1 reference (translated from the 400) |
| `PROTECTED_RANGE` | Upstream refused the write because the range is protected for this account; names the range and that an editor of the sheet must unprotect it or write it |
| `FILE_NOT_FOUND` | `--parent` folder absent or inaccessible (`create`) |
| `WRITE_INCOMPLETE` | `add-tab`: the tab was added but the value write failed and the tab could not be deleted again; names the tab so it can be removed by hand. `create`: the spreadsheet exists but the tabs or values did not all apply; names the id |

All Google failures pass through `translateGoogleError`. There is no optimistic-locking guard:
the Sheets API has no `requiredRevisionId`, so a change between the read and the write is
not detected. The read-then-write window is one round trip; the `overwritten[]` block is
what makes a collision visible after the fact.

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| `values.update` with a range larger than the block leaves the uncovered cells unchanged | Documented (values.update reference: "cells outside the values are not changed"). **To verify live** before the spec is trusted |
| `values.update` beyond the tab's allocated rows/columns is refused ("exceeds grid limits"), not grown | Documented behavior; seen in third-party reports. **To verify live**; the growth step exists because of it |
| `values.append` with the tab as the range appends after the last data row and grows the row allocation itself | Documented ("the table" detection; `INSERT_ROWS`). **To verify live**, including where rows land on a tab with a blank row inside its data |
| `null` in a `values.update` row leaves the cell untouched; `""` clears it | Documented (ValueRange: "null values are skipped"). **To verify live** |
| `USER_ENTERED` parses `=…`, dates and currencies; `RAW` stores verbatim | Documented. **To verify live** for the exact strings the help line claims |
| `values.clear` keeps formatting, notes and validation | Documented ("only values are cleared"). **To verify live** |
| `addSheet` with a duplicate title is refused (400) and adds nothing | Documented. **To verify live** — the `exists` path is computed from the pre-read, not from the 400 |
| A protected range refuses `values.update` with a 403 naming the protection | Documented. **To verify live** for the message `PROTECTED_RANGE` is classified from |
| Drive `files.create` with the spreadsheet MIME creates a spreadsheet whose first tab is `Sheet1` | **Observed** (the `drive upload --convert` path produces the same) |

Each row flips to **Observed <date>** as the plan's live checks run; a contradicted row changes
the spec, not the code.

## Dispatcher

The five scaffolded entries gain handlers and lose their `instead[]` lines; `sheets --help`
drops its `alternatives[]` block. The `drive upload` help line for a `.csv`/`.tsv` source
and the `MULTI_TAB_TARGET` suggestions name `sheets update --tab` as the tab-safe path
(parity with the `.md` → `docs write` line).

## Out of scope (v1)

- **Header-keyed rows** — appending `{"Name": …, "Status": …}` objects mapped onto a header
  row. The read's `rows[N]{…}` shape invites it; a follow-up once the positional block is in.
- **Formatting, widths, validation, merges, freezes** — none of these commands sets any.
- **Cell notes** — `sheets read` surfaces them; writing one is a `batchUpdate`
  `updateCells` with a `note` field, deferred.
- **Deleting, renaming, reordering tabs** — a `sheets tabs` group modeled on `docs tabs`.
- **Inserting or deleting rows/columns in place** (shifting data) — `append` is the only
  structural write; `insertDimension`/`deleteDimension` are deferred.
- **Batch writes to several ranges in one call** (`values.batchUpdate`) — one range per
  invocation.
- **Formulas on read** — `--formula` on `sheets read` (its own follow-up).

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
- [ids-are-first-class](../principles.md#ids-are-first-class) — `gid` and the written A1
  range are in every response; the range is the handle `sheets read --range` consumes.
- [provenance-by-default](../principles.md#provenance-by-default) — a write that replaces
  values carries the values it replaced.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — the input-mode
  line, the no-revision-guard disclosure, the append-placement echo.
- [fail-loud-on-unknown-flags](../principles.md#fail-loud-on-unknown-flags) — a block that
  does not fit, a flag that does not apply, a JSON shape that is not a grid: refused, never
  trimmed to fit.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions)
- [no-dead-end-surfaces](../principles.md#no-dead-end-surfaces) — the `drive upload` signposts
  turn around to point here.

**Local:**

- **Values, never the file.** A `sheets` writer sends values calls and the one structural
  request that makes them fit. It never replaces the file, never touches formatting it was not
  asked to set, and never clears a cell the block did not name. The only command that can
  flatten a spreadsheet is `drive upload --update`, and it says so by flag.

  > **Why:** the reason these commands exist is that the import path destroys everything it
  > was not told about. A values writer that cleared the rest of a range "for tidiness", or
  > reset a column's format on its way through, would re-create the hazard at cell scale —
  > and against a sheet humans also format by hand, that is the hazard that matters.

- **The previous value rides with the write.** Any command that replaces a cell's value
  reports what was there. There is no revision id to point at, so the response is the undo.

  > **Why:** Sheets' version history is the only rollback, and it is reachable only in the
  > editor. An agent that overwrote the wrong range needs the old values *in hand*, in the
  > same turn, not a pointer to a UI it cannot open.
