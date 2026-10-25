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

Keyed rows are placed by the header, not by upstream's table detection: they are written
from **column A of the row after the last row with data in the header's columns** (row 1's
first through last non-empty cell), through `update`'s path — `values.update`, grid growth
included — rather than `values.append`. `values.append` starts the rows at the first column of
the last block of data it detects, which need not be column A (§ `append`); that would put
every value under the wrong header. A keyed append therefore fills no gap and inserts no row:
the rows below the last one are empty in those columns by construction.

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
  Uniqueness is **case-insensitive** upstream and covers every sheet, chart sheets included
  (observed: `addSheet` `q4` beside `Q4`, and `diagramm1` beside a chart sheet `Diagramm1`,
  are both refused); resolving `--tab` stays exact.
- A tab title that stands alone as a range — the whole-tab `values.append`, the whole-tab
  error scan, `sheets read --full` — is **always quoted** (`'Q4'`). Unquoted, a title that is
  also A1 notation is a cell on the first sheet (observed: `values.get` with range `Q4`
  returned `Sheet1!Q4`).
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
- Column-only or row-only references (`B:B`, `3:3`), and open-ended ones (`B2:B`, `A3:3`),
  are accepted as ranges with the tab's allocated extent.

The written range is **grown into the tab's allocation when it would exceed it**: a 30-column
block at `A1` on a fresh 26-column tab makes the tab 30 columns wide (one `batchUpdate` of
`appendDimension` requests — rows and columns separately — before the values call). Growth is
**relative** (`length` = what the block needs beyond the allocation the command read), never an
absolute `rowCount`/`columnCount`: an absolute count computed from a snapshot lowers a tab that
grew since (a form response, a concurrent append), and lowering it deletes the trailing rows
(observed: `rowCount: 3` on a 7-row tab removed four rows). Upstream is inconsistent
here: a block that spills from an anchor *inside* the allocation is grown by `values.update`
itself, but a range — or an anchor — that lies outside it is refused ("Range (Tiny!D1:E2)
exceeds grid limits. Max rows: 3, max columns: 3"), and so is a `--cell` outside it. Growing
first makes every case one path, and is what a human pasting the same block gets. The
response says `grid: grown to <rows>×<cols>` when it happened.

## Behavior

### `update`

1. **Read** the spreadsheet's tabs (`spreadsheets.get`, properties only) to resolve the tab,
   and the target range's current entered values (`includeGridData` with
   `userEnteredValue`), in one call where the tab is already known.
2. **Compare** each cell of the block with what is there. A cell is *unchanged* when its
   stored entered value is the same kind and the same text as what the input would store:
   a string against a `stringValue`, a formula (`=…`) against a `formulaValue`, a number or
   boolean against a `numberValue`/`boolValue` rendering to the same text. The text
   shortcuts — a typed string read as a number or a boolean — depend on the spreadsheet's
   `locale` and the cell's format, so they apply only where they hold: an integer string in
   any locale; a decimal string only when the locale's decimal separator is `.` (in `de_DE`
   `5.5` is a date and `5,5` the number — observed); `TRUE`/`FALSE` only in an English
   locale; and none of them on a cell whose number format is `TEXT`, which stores what is
   typed as a string (observed: `5` into a `TEXT` cell holding the number 5 became the string
   `"5"`). Anything the comparison cannot be sure of — a `USER_ENTERED` string that Sheets
   might parse into a different kind — counts as *changed*. The check errs toward writing: a false "changed"
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
6. **Error scan**: the pre-read and the read-back each also fetch the **whole tab's error
   cells** (`effectiveValue.errorValue` only — a mask that carries nothing for a healthy
   cell), and the two sets are diffed. See § Formula errors: the feedback loop.

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
   they landed. A blank row inside the data is **not** filled: the rows land after the last
   row that has data, below the gap (observed). `values.append` grows the tab's rows — and
   its columns, for a wider block — itself, so `append` sends no growth request. The rows
   start at the **first column of the last block of data** upstream detects — column A on an
   ordinary table, but a tab whose lowest data starts further right takes them there
   (observed: `A1:B1` above `C5:D5` → the row landed at `C6`). The `range` echo shows it.
   Header-keyed rows do not take this path (§ Header-keyed rows): they are aligned to row 1
   from column A, and a landing column other than A would put them under the wrong headers.
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
   the list — compared case-insensitively, as upstream does — are a `VALIDATION_ERROR` before
   any call.
3. A value block, when given, is written into the **first tab at `A1`** through the `update`
   path (grid growth included).
4. Not idempotent (Drive allows duplicate names); the response says so and names the id.

### `add-tab`

1. **Read** the tabs. A grid tab with the same title, compared case-insensitively, already
   exists → `action: exists`, exit 0;
   the response carries that tab's `gid`, and says placement flags and the value block were
   **not** applied. Idempotence is "a tab by that name exists", not "it looks like this".
   A chart sheet holding the title is a `VALIDATION_ERROR` (the name is taken, and there is
   no grid to write into), as is the duplicate-name 400 if the tabs changed since the read.
2. One `batchUpdate` `addSheet` with `title` and the `index` the placement resolves to:
   `--first` → 0, `--last` (default) → the tab count, `--before <tab>` → that tab's index,
   `--after <tab>` → its index + 1; the anchor is resolved like `--tab` (`TAB_NOT_FOUND`
   otherwise). At most one placement flag.
3. A value block is written into the new tab at `A1` through the `update` path. A write
   that fails after the add **deletes the tab again** and the error says so — a failed call
   never leaves an empty tab behind (the rule `docs write --new-tab` follows).

## Output

**The rule for formulas:** the response to any write that contains a formula carries, for
**every** formula written, its computed result or its error with Sheets' message — in the
same response, from the read-back, always. There is no formula write whose outcome needs a
`sheets read` to learn. This is the immediate feedback loop; `sheets read` and `sheets cell`
are for the next turn, not for finding out whether this one worked.

Header: `account` (+ `account_source` per the standard rules), then `action: updated |
unchanged | appended | cleared | created | added | exists`, then — when the write left formula
errors to report — `errors: N` and its siblings directly under `action`.

```
account: alice@example.com
action: updated
errors: 1
spreadsheet:
  id: 1AbC…
  title: Q4 Tracker
  tab: Costs
  gid: 1374928
  web_view_link: https://docs.google.com/spreadsheets/d/1AbC…/edit#gid=1374928
range: Costs!B2:D4
shape: 3x3
cells: 9
changed: 5
input: user-entered
formulas[2]{cell,formula,result,message}:
  D2,=B2*C2,"$9,600",
  D3,=B3/C3,#DIV/0!,Function DIVIDE parameter 2 cannot be zero.
written[3]{cell,before,input,now}:
  B2,"$4,200",4800,"$4,800"
  C3,pending,done,done
  D4,,1/2,1/2 (date 2026-01-02)
errors[1]{cell,error,message,written}:
  D3,DIVIDE_BY_ZERO,Function DIVIDE parameter 2 cannot be zero.,yes
help[5]:
  1 formula error after this write — see errors[]
  Fix D3 (#DIV/0!, Function DIVIDE parameter 2 cannot be zero.): gws-axi sheets update 1AbC… --tab Costs --cell D3='=B3/C3'
  Run `gws-axi sheets cell 1AbC… D3 --tab Costs` to see the formula with the current values it reads
  Run `gws-axi drive revisions 1AbC…` for the version history; the pre-write version is the newest revision before this one
  Values were parsed as typed (USER_ENTERED): dates, numbers, currencies and =formulas take effect. Pass --raw to store strings verbatim
```

- `spreadsheet{id,title,tab,gid,web_view_link}` — `gid` is first-class; the link opens on
  that tab.
- `range` — the A1 range actually written, tab-qualified. For `append`, the rows the API
  reports. For `clear`, the range cleared.
- `shape`, `cells` — the block's rows×columns and the number of cells it carried (`null`
  cells excluded); for `clear`, `cells` counts the cells that held a value. `changed` — cells
  whose value differs after the write (`update` only).
- `grid: grown to <rows>×<cols>` — only when the tab was enlarged.
- `formulas[N]{cell,formula,result,message}` — **every formula the block contained**, in
  block order, never capped: the formula as stored, `result` as the displayed value after
  recalculation or the error text (`#DIV/0!`), and `message` — Sheets' own explanation —
  only when it errored. Under `--raw` there are no formulas (the `=` text is a string) and
  the block is absent; the help line says so.
- `written[N]{cell,before,input,now}` — the non-formula cells worth a second look after the
  write: every cell that **had a value** and received a different one (`before` is its previous
  entered text — a formula shows as its formula), and every cell whose **displayed value
  differs from the input** (`now` is the read-back `formattedValue`: a formula's result, a
  parsed date, a currency). A string that Sheets **parsed into a date** shows the date it
  became beside its display — `1/2 (date 2026-01-02)` — because the display alone hides it:
  `1/2` is stored as a date whose `m/d` format displays `1/2` again (observed). An input that
  already reads as that ISO date (`2026-10-24`) is not annotated. A cell that was empty and
  now displays exactly what was typed is not listed — the block is the record of it. Capped at 50 rows; past the cap the header
  carries `written_total`. `clear` lists the cleared cells with `input` and `now` empty. This
  is the undo line *and* the verification: the previous values and what Sheets made of the
  new ones are in the response, not behind a re-query
  ([provenance-by-default](../principles.md#provenance-by-default) applied to a write).
- `errors[N]{cell,error,message,written}` and `errors_fixed: N` — the formula-error diff,
  per § Formula errors: the feedback loop. Shown only when something errors now or stopped
  erroring; the header then carries `errors: N`.
- `header: frozen` — with `--header`; `frozen (N rows, unchanged)` when the tab already had a
  taller freeze.
- `create` and `add-tab` end with the `sheets[N]{gid,title,index,rows,cols}` listing from
  `sheets read`, so the structure is confirmed without a read.

### help[] suggestions

- Read back: `sheets read <id> --tab <tab> --range <range>` (the written range); after
  `create`/`add-tab`, `sheets read <id> --tab <tab>`.
- Undo: `drive revisions <id>` — Sheets exposes no revision id to the API, so the suggestion
  names the version history rather than a specific revision.
- When `errors[]` is non-empty: the count first, then a fix line per error (up to 5) — § Formula errors.
- The input-mode line (above), on every `USER_ENTERED` write; under `--raw`, the converse
  (`=…` was stored as text). When any `written[]` row has `now` differing from `input` without
  being a formula, the line names one (`D4: 1/2 became the date 2026-01-02; --raw stores it as
  text`).
- When the block has 2+ columns, was written at row 1, and `--header` was not given: one line
  showing the `--header` form, so the agent learns that the read promotes a frozen row.
- `append`: "re-running appends the same rows again".
- `update` with a block smaller than a given range: "N cells of the range were left as they
  were; `sheets clear` empties them".
- `create`: `drive share <id> --with <email>`; `sheets add-tab <id> --title <title>`.
- `add-tab` with `exists`: `sheets update <id> --tab <title> --range A1 …` to write into it.

## Formula errors: the feedback loop

A formula that evaluates to an error is a write whose intent was not met, even though the
value was stored. And a plain value can break a formula somewhere else: writing text into a
cell a `SUM` covers, clearing a range a `VLOOKUP` reads (`#REF!`), renaming a header a
`QUERY` names. The cells the caller named are not the only cells to check. So every write
(`update`, `append`, `clear`, and the seed writes of `create` and `add-tab`) runs the same
loop:

1. **Before**: the set of cells in the tab whose effective value is an error, with the error
   type (`errorValue.type`: `REF`, `NAME`, `VALUE`, `DIVIDE_BY_ZERO`, `N_A`, `NUM`,
   `NULL_VALUE`, `ERROR`) and message. Fetched beside the pre-read, as its own
   `spreadsheets.get` sent in parallel (one `ranges` entry for the whole tab, fields
   `sheets(data(startRow,startColumn,rowData(values(effectiveValue/errorValue))))`) — a
   request carries one fields mask, and the target range's mask on the whole tab would fetch
   every value in it.
2. **After**: the same set from the read-back.
3. **Report** the diff, not the state:
   - `errors[N]{cell,error,message,written}` — every cell that errors **after** the write and
     either did not error before or was written by this call. `written: yes` marks cells the
     block named; the rest are collateral — dependents the write broke. `message` is Sheets'
     own (`Unresolved sheet name 'Cost'`, `Function SUM parameter 1 expects number values`),
     which is the diagnostic the agent needs to fix it.
   - `errors_fixed: N` — cells that errored before and do not now (a write whose point was to
     fix a formula sees it confirmed).
   - Pre-existing errors the write neither caused nor touched are not listed — they are
     `sheets read`'s business — but the header carries `errors_elsewhere: N` so the agent
     knows the tab is not clean.
4. **Point at the fix.** The first `help[]` line is the count. Then one line per reported
   error, up to 5, as a runnable command carrying the cell's **current formula** so the agent
   edits rather than re-derives it:
   `Fix D2 (#NAME?, Unknown range name: 'Cost'): gws-axi sheets update <id> --tab Costs --cell D2='=Cost!B2*C2'`.
   For a collateral error the line also names the written cell it depends on when the
   formula text contains that cell's reference, which is the common case. After the fix
   lines, one line: `Run \`gws-axi sheets cell <id> <first error cell> --tab <t>\` to see the
   formula with the current values it reads` — [sheets-cell.md](sheets-cell.md) is the
   debugging view.

**Exit code is 0 and `action` is unchanged.** The write did what it was told; the error is
the *result* of what it was told, reported as loudly as the output envelope allows: `errors:
N` directly under `action`, the block, and the first help line. A non-zero exit would turn a
successful write into an error envelope and hide `written[]` — the undo — in the one case
the agent most needs it.

**Bound**: the tab-wide scan runs when the tab's allocation is at most 200,000 cells
(`rowCount × columnCount`). Above that, the scan covers the written range only and the
header says `error_scan: written range only (tab is R×C)`, so a silent gap never looks like
a clean tab ([surface-completeness-limits](../principles.md#surface-completeness-limits)).
The mask is **not** compact: every populated cell comes back as an empty
`{"effectiveValue":{}}` (only empty rows collapse to `{}`), about 22 bytes a cell. Measured
2026-10-24: a fully populated 1000×26 tab returned 585 KB in about 230 ms; a fully populated
8000×25 tab (200,000 cells) 4.5 MB in about 610 ms. Two of those per write is the price of
the scan at the bound, and the bound stays at 200,000.

**The read side of the loop** is [sheets read](sheets-read.md) § Error values: the same
`errors[]` shape, the same fix line per error, so an agent that reads first and writes second
sees one vocabulary.

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
| `PROTECTED_RANGE` | Upstream refused the write because the range is protected for this account (a 400 whose message reads "You are trying to edit a protected cell or object"); names the range and that an editor of the sheet must unprotect it or write it |
| `FILE_NOT_FOUND` | `--parent` folder absent or inaccessible (`create`) |
| `WRITE_INCOMPLETE` | `add-tab`: the tab was added but the value write failed and the tab could not be deleted again; names the tab so it can be removed by hand. `create`: the spreadsheet exists but the tabs or values did not all apply; names the id |

All Google failures pass through `translateGoogleError`. There is no optimistic-locking guard:
the Sheets API has no `requiredRevisionId`, so a change between the read and the write is
not detected. The read-then-write window is one round trip; the `written[]` block is
what makes a collision visible after the fact.

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| `values.update` with a range larger than the block leaves the uncovered cells unchanged | **Observed 2026-10-24**: one value into `A1:C3` wrote `A1` and left the other eight cells as they were (`updatedCells: 1`) |
| `values.update` beyond the tab's allocated rows/columns is refused ("exceeds grid limits"), not grown | **Amended 2026-10-24**: only partly. A block spilling from an anchor inside the allocation is grown by upstream (3 values at `Z1` made a 26-column tab 28 wide; 2 rows at `A1000` made it 1001 rows). A range or anchor outside it is refused — `values.update` `Tiny!D1:E2`, `values.batchUpdate` `Tiny!G9`, and `spreadsheets.get` on a range wholly outside the grid (one partly outside is clipped). The growth step stays, for the refused cases |
| `values.append` with the tab as the range appends after the last data row and grows the row allocation itself | **Observed 2026-10-24**: rows landed after the last data row; with data in rows 1–4 and 6 (row 5 blank) the row landed at 7, not 5; a value in a far column (`J2`) did not move it. A full 2×2 tab took a 3-column row and grew to 3×3. A `null` in the row left that cell empty (`updatedColumns: 2`) |
| `null` in a `values.update` row leaves the cell untouched; `""` clears it | **Observed 2026-10-24**: `[null, "", "9"]` kept the first cell, emptied the second, wrote the third |
| `USER_ENTERED` parses `=…`, dates and currencies; `RAW` stores verbatim | **Observed 2026-10-24**: `=1+1` → formula showing `2`; `2026-10-24` → date (`yyyy-mm-dd`); `$5.00` → 5 as currency; `TRUE` → boolean; `42` → number; `00123` → 123; `1/2` → a date with format `m/d` that **displays `1/2`** (hence the date annotation in `written[]`). `RAW` stored all ten strings as `stringValue` verbatim |
| `values.clear` keeps formatting, notes and validation | **Observed 2026-10-24**: a bold cell with a note and a list-validation rule kept all three. Clearing an already-empty range succeeds silently (`unchanged` is computed from the pre-read) |
| `addSheet` with a duplicate title is refused (400) and adds nothing | **Observed 2026-10-24**: 400 `A sheet with the name "Sheet1" already exists. Please enter another name.` |
| A protected range refuses `values.update` with a 403 naming the protection | **Amended 2026-10-24**: it is a **400** `INVALID_ARGUMENT`, not a 403, and it names no range: "You are trying to edit a protected cell or object. Please contact the spreadsheet owner to remove protection if you need to edit." (`values.update`, `values.clear`; `values.batchUpdate` prefixes `Invalid data[0]: `). Observed as an editor writing a range protected to the owner. `PROTECTED_RANGE` is classified from that message and names the range from the request |
| `updateSheetProperties` with `gridProperties.frozenRowCount` and that fields mask freezes the top rows and changes nothing else | **Observed 2026-10-24**: `frozenRowCount: 1` set, `rowCount`/`columnCount` unchanged, and `sheets read` on the tab then reported `header_source: frozen-row` |
| A `spreadsheets.get` right after `values.update` returns computed formula results and `effectiveValue.errorValue` for broken ones (no "Loading…" state for ordinary formulas) | **Observed 2026-10-24** for `=1+1`, `=SUM(A5:B5)`, `=A2/0` (`DIVIDE_BY_ZERO`, "Function DIVIDE parameter 2 cannot be zero.") and `=Cost!B2` with no `Cost` tab (`REF`, "Unresolved sheet name 'Cost'."). `IMPORTRANGE`-class formulas not tested; a `LOADING` error type is reported as it comes |
| A fields mask of `effectiveValue/errorValue` alone returns a compact response for a healthy tab (no per-cell payload for cells with no error) | **Amended 2026-10-24**: not compact — each populated cell returns `{"effectiveValue":{}}`. 585 KB / ~230 ms on a populated 1000×26 tab; 4.5 MB / ~610 ms at 200,000 cells. Bound kept (§ Formula errors) |
| `values.batchUpdate` with one single-cell range per entry writes them all, or none on a bad range | **Observed 2026-10-24**: a good `H1` beside a bad `Nope!A1` → 400 `Invalid data[1]: Unable to parse range: Nope!A1`, and `H1` stayed empty. A range naming no tab is the same "Unable to parse range" 400 as a malformed one |
| `values.append` starts the rows at the detected table's first column | **Observed 2026-10-24**: data at `A1:B1` and `C5:D5` → a one-cell row landed at `C6`. Narrowing the range to the header's columns (`A:B`) made it land at `A2` and insert rows above `C5`, shifting that data down — so plain rows keep the whole tab as the range, and header-keyed rows are written by `values.update` under the header instead (observed through the command: a keyed row on a tab whose lowest block started in column B landed at `B9`, misaligned, before this change). A leading `null` does not move the start (`[null, …]` → `A9:C9`) |
| A tab title alone is a whole-tab range | **Amended 2026-10-24**: only when quoted. `values.get` with range `Q4` on a spreadsheet with a `Q4` tab returned `Sheet1!Q4` (a cell on the first sheet); `'Q4'` returned the tab. Titles standing alone are always quoted |
| Growing the grid with an absolute `rowCount`/`columnCount` is safe | **Amended 2026-10-24**: not on a tab that grew since it was read — `rowCount: 3` on a 7-row tab deleted four rows. `appendDimension` (`length` relative to the read) only ever adds: 5×3 + 2 rows + 1 column → 7×4 |
| Tab titles are unique | **Observed 2026-10-24**: case-insensitively, across every sheet: `addSheet` `q4` beside `Q4`, and `diagramm1` beside a chart sheet `Diagramm1`, → 400 `A sheet with the name "…" already exists` |
| `USER_ENTERED` text reads the same in every spreadsheet | **Amended 2026-10-24**: it follows `properties.locale` and the cell's format. In `de_DE`: `5.5` → a date, `5,5` → 5.5, `1.5` → a date, `WAHR` → text, `TRUE` → boolean. A `TEXT`-formatted cell stores `5` as the string `"5"` |
| Drive `files.create` with the spreadsheet MIME creates a spreadsheet whose first tab is `Sheet1` | **Observed 2026-10-24**: `Sheet1`, gid `0`, 1000×26, created directly in the `parents` folder |

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

- **A write is judged by the tab it leaves, not the cells it named.** Every write reports
  the formula errors it introduced anywhere in the tab, the ones it fixed, and a ready fix
  for each — the same way whether the cause was a formula it wrote or a value a formula
  elsewhere depended on.

  > **Why:** an agent fills a sheet in a loop: write, read, adjust. A `#REF!` three columns
  > over, found two turns later by a human, is the failure that makes the loop untrustworthy.
  > The scan costs one tab-wide errors-only fetch on each side of the write; that is cheaper
  > than any re-read, and far cheaper than the undetected case.

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
