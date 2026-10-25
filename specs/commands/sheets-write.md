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

**Two ways in from CSV.** `drive upload x.csv --convert` hands the file to Google's importer and
returns a Drive file; `sheets create --title T x.csv` writes the rows itself through
`values.update` and returns the tab's `gid`, its listing, and the read-back below. Use `drive
upload` to park a file; use `sheets create` when the next step is to edit or read it — the verb
names the path, as it does for Docs.

## Invocation

```
gws-axi sheets update  <spreadsheetId> (--range <A1> (<file> | - | --content <values>) | --cell <A1>=<value>...) [--tab <name|gid>] [--json | --tsv] [--raw] [--header]
gws-axi sheets append  <spreadsheetId> (<file> | - | --content <values>) [--tab <name|gid>] [--json | --tsv] [--raw]
gws-axi sheets clear   <spreadsheetId> (--range <A1> | --all) [--tab <name|gid>]
gws-axi sheets create  --title <title> [<file> | - | --content <values>] [--tab <title>] [--parent <folderId>] [--json | --tsv] [--raw] [--header]
gws-axi sheets add-tab <spreadsheetId> --title <title> [<file> | - | --content <values>] [--first | --last | --before <tab> | --after <tab>] [--json | --tsv] [--raw] [--header]
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
  is a `VALIDATION_ERROR` naming the shape (a single row is `[[…]]`). For `append` only, an
  array of **objects** keyed by header title is also a block — see Header-keyed rows. Anything else that is not
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

### Header-keyed rows (`append`)

With `--json`, `append` accepts `[{"Name": "…", "Status": "…"}, …]`: each object is one row,
each key a column named by the tab's **header row** — row 1 of the tab, the row `sheets read`
promotes to `rows[N]{…}`. Keys are matched to header cells exactly (trimmed, case-sensitive); a
key that names no header cell is `COLUMN_NOT_FOUND` listing the headers, before any write. A
header cell that no object names gets `null` — the column is left untouched in the appended
row. The tab's row 1 must have at least one non-empty cell (`HEADER_REQUIRED` otherwise).
Whether row 1 is frozen does not matter here; `--header` is how to make it so.

The read's `rows[N]{…}` shape invites this: an agent that read `rows[N]{Name,Status,Owner}`
appends `{"Name": …}` without knowing which letter `Owner` is.

### Single cells (`update --cell`)

`--cell <A1>=<value>`, repeatable, writes scattered cells in one call: `--cell B5=4800 --cell
C9=3 --cell D2='=B2*C2'`. Everything before the first `=` is the cell (optionally tab-qualified;
all must name the same tab), everything after it is the value — so a formula keeps its own
`=`. `--cell` is the whole block: it cannot be combined with `--range`, a file, `-` or
`--content` (`VALIDATION_ERROR`). The same cell twice is a `VALIDATION_ERROR`. Values are
strings in the chosen input mode; `--json` does not apply.

All cells go in one `values.batchUpdate`; the pre-read and the read-back fetch every named
cell in one `spreadsheets.get` with one `ranges` entry per cell. The response is the one
`update` gives, with `range` listing the cells (`Sheet1!B5,C9,D2`) and `shape` omitted.

### The header row (`--header`)

`--header` declares the block's first row a header: after the values are written, the tab's
**top row is frozen** (`updateSheetProperties` with `gridProperties.frozenRowCount: 1`, fields
mask `gridProperties.frozenRowCount`) — the exact property `sheets read` detects to promote
row 1 to column names, so a `--header` write and a read round-trip through `rows[N]{…}`. On
`update` the range must start at row 1 (`VALIDATION_ERROR` otherwise: "the header is row 1;
write it with `--range A1`"). Re-running is idempotent: a row already frozen is reported
`header: frozen` with no request sent; a tab frozen at 2+ rows is left alone and the response
says so (`header: frozen (2 rows, unchanged)`), since lowering it would un-freeze rows the
caller did not name.

Freezing is the only thing `--header` does. It sets no bold, fill or border: a frozen row is
Sheets' own notion of a header and the one the read understands, and formatting is
something these commands do not touch unless a flag names it. Changing a header's *text* is
an ordinary write to row 1 (`update --range C1 --content Owner`, or `--cell C1=Owner`); the
freeze survives it.

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
   the range (`values.batchUpdate` for `--cell`) with the chosen `valueInputOption`; then
   the freeze when `--header` asks for it.
5. **Read back**: one `spreadsheets.get` on the written range with `formattedValue`,
   `userEnteredValue` and `effectiveValue` — what Sheets made of the input. This is where a
   formula shows its result or its error, and where `1/2` shows up as a date. One extra
   call so the caller does not need a `sheets read` to learn whether the write did what it
   meant to ([AXI §4](https://axi.md): the follow-up call is the expensive token cost).

Formatting, data validation, notes, and the other cells of the tab are never touched; the
only requests sent are the values call, the grid growth when needed, and the freeze when
asked for. `append`, `create` and `add-tab` read back the same way.

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
written[4]{cell,before,input,now}:
  B2,"$4,200",4800,"$4,800"
  C3,pending,done,done
  D2,,=B2*C2,"$9,600"
  D4,,1/2,1/2/2026
help[3]:
  Run `gws-axi sheets read 1AbC… --tab Costs --range B2:D4 --formulas` to see the range with its formulas
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
- `written[N]{cell,before,input,now}` — the cells worth a second look after the write:
  every cell that **had a value** and received a different one (`before` is its previous
  entered text — a formula shows as its formula), and every cell whose **displayed value
  differs from the input** (`now` is the read-back `formattedValue`: a formula's result, a
  parsed date, a currency). A cell that was empty and now displays exactly what was typed
  is not listed — the block is the record of it. Capped at 50 rows; past the cap the header
  carries `written_total`. `clear` lists the cleared cells with `input` and `now` empty. This
  is the undo line *and* the verification: the previous values and what Sheets made of the
  new ones are in the response, not behind a re-query
  ([provenance-by-default](../principles.md#provenance-by-default) applied to a write).
- `errors[N]{cell,error,message}` — every written cell whose read-back is an error value
  (`#REF!`, `#NAME?`, `#DIV/0!`, …) with Sheets' own message (`effectiveValue.errorValue`).
  Shown only when there are any; the header then carries `errors: N` and the first `help[]`
  line names the first one. The write still succeeded — the formula is stored — so this is
  `action: updated` with a loud result, not a failure.
- `header: frozen` — with `--header`; `frozen (N rows, unchanged)` when the tab already had a
  taller freeze.
- `create` and `add-tab` end with the `sheets[N]{gid,title,index,rows,cols}` listing from
  `sheets read`, so the structure is confirmed without a read.

### help[] suggestions

- Read back: `sheets read <id> --tab <tab> --range <range>` (the written range); after
  `create`/`add-tab`, `sheets read <id> --tab <tab>`.
- Undo: `drive revisions <id>` — Sheets exposes no revision id to the API, so the suggestion
  names the version history rather than a specific revision.
- When `errors[]` is non-empty, first: "N written cell(s) show a formula error — see errors[]".
- The input-mode line (above), on every `USER_ENTERED` write; under `--raw`, the converse
  (`=…` was stored as text). When any `written[]` row has `now` differing from `input` without
  being a formula, the line names one (`D4: 1/2 became 1/2/2026; --raw stores it as text`).
- When the block has 2+ columns, was written at row 1, and `--header` was not given: one line
  showing the `--header` form, so the agent learns that the read promotes a frozen row.
- `append`: "re-running appends the same rows again".
- `update` with a block smaller than a given range: "N cells of the range were left as they
  were; `sheets clear` empties them".
- `create`: `drive share <id> --with <email>`; `sheets add-tab <id> --title <title>`.
- `add-tab` with `exists`: `sheets update <id> --tab <title> --range A1 …` to write into it.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | Source rules broken; both/neither of `--range`/`--all` on `clear`; `--tab` disagreeing with a qualified range; block larger than the range; empty block on `update`/`append`; `--cell` with any other source or `--range`, the same cell twice, or a `--cell` with no `=`; `--header` on an `update` whose range does not start at row 1; `--json` objects outside `append`; malformed CSV (unterminated quote, with the line), malformed or non-2-D JSON; conflicting placement flags; duplicate `--tab` titles on `create`; `--json` with `--tsv` |
| `LOCAL_FILE_NOT_FOUND`, `LOCAL_PATH_NOT_FILE` | As `drive upload` |
| `SPREADSHEET_NOT_FOUND` | Absent, no access, or not a native spreadsheet — as `sheets read`, including the `drive upload --convert` redirect for an uploaded `.xlsx` |
| `TAB_REQUIRED` | Multi-tab spreadsheet, no tab named; carries the listing |
| `TAB_NOT_FOUND` | `--tab`, a qualified range, or a placement anchor names no grid tab; carries the listing |
| `RANGE_INVALID` | Upstream rejected the A1 reference (translated from the 400), or a `--cell` whose A1 part does not parse |
| `COLUMN_NOT_FOUND` | Header-keyed `append`: an object key names no cell in the tab's row 1; lists the header cells |
| `HEADER_REQUIRED` | Header-keyed `append` on a tab whose row 1 is empty |
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
| `updateSheetProperties` with `gridProperties.frozenRowCount` and that fields mask freezes the top rows and changes nothing else | Documented. **To verify live**, including that `sheets read` then auto-promotes |
| A `spreadsheets.get` right after `values.update` returns computed formula results and `effectiveValue.errorValue` for broken ones (no "Loading…" state for ordinary formulas) | Expected from the API's synchronous recalculation. **To verify live**; `IMPORTRANGE`-class formulas may lag and are disclosed if so |
| `values.batchUpdate` with one single-cell range per entry writes them all, or none on a bad range | Documented (atomic per request). **To verify live** |
| Drive `files.create` with the spreadsheet MIME creates a spreadsheet whose first tab is `Sheet1` | **Observed** (the `drive upload --convert` path produces the same) |

Each row flips to **Observed <date>** as the plan's live checks run; a contradicted row changes
the spec, not the code.

## Dispatcher

The five scaffolded entries gain handlers and lose their `instead[]` lines; `sheets --help`
drops its `alternatives[]` block. The `drive upload` help line for a `.csv`/`.tsv` source
and the `MULTI_TAB_TARGET` suggestions name `sheets update --tab` as the tab-safe path
(parity with the `.md` → `docs write` line).

## Out of scope (v1)

- **Formatting, widths, validation, merges** — none of these commands sets any. The one
  structural property they set is the top-row freeze, by `--header`.
- **Cell notes** — `sheets read` surfaces them; writing one is a `batchUpdate`
  `updateCells` with a `note` field, deferred.
- **Deleting, renaming, reordering tabs** — a `sheets tabs` group modeled on `docs tabs`.
- **Inserting or deleting rows/columns in place** (shifting data) — `append` is the only
  structural write; `insertDimension`/`deleteDimension` are deferred.
- **Batch writes of several rectangular blocks** — `--cell` batches single cells; a block
  per range in one call is not offered.
- **Header-keyed `update`** — objects map onto appended rows only; a keyed update of an
  existing row (by a label column, as `docs edit-cell` does) is a follow-up.

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

- **The previous value and the resulting value ride with the write.** Any command that
  replaces a cell's value reports what was there, and any command that writes a value
  reports what Sheets displays for it when that differs from what was sent. There is no
  revision id to point at, so the response is the undo; and `USER_ENTERED` is an
  interpretation, so the response is also the proof.

  > **Why:** Sheets' version history is the only rollback, and it is reachable only in the
  > editor. An agent that overwrote the wrong range needs the old values *in hand*, in the
  > same turn, not a pointer to a UI it cannot open.
