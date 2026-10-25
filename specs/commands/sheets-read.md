# Command: sheets read

## Summary

Reads a native Google Sheets spreadsheet and renders one tab's cell values into an agent's context in a single pass. A spreadsheet's individual sheets *are* its tabs, so `sheets read` mirrors [`docs read`](docs-read.md)'s tab model exactly: it always lists the tabs, auto-renders the grid when there is only one (or when `--tab` picks one), and — when there are several and no `--tab` — returns just the tabs listing so the agent can choose.

Operates only on native Google Sheets. Uploaded `.xlsx`/`.csv` files (Drive files that are not `application/vnd.google-apps.spreadsheet`) are routed toward `drive download` / `drive upload --convert` via the `SPREADSHEET_NOT_FOUND` error's suggestions. (A distinct `NON_NATIVE_SPREADSHEET` code that positively detects the mismatch via a Drive `files.get` is a follow-up — see the plan.)

## Invocation

- `gws-axi sheets read <spreadsheetId> [flags]`

## Flags

- `--tab <name|gid>` — tab to render, resolved by title first then by numeric `sheetId` (gid). Omit for single-tab spreadsheets; required to pick one in a multi-tab spreadsheet.
- `--range <A1>` — restrict the read to an A1 range *within the selected tab* (e.g. `A1:D50`). A tab-qualified range (`Costs!A1:D50`) is accepted and, when given, makes `--tab` optional. Omitted → the tab's used data range.
- `--header-row` — force-promote the first fetched row to TOON column names (`rows[N]{<h1>,<h2>,…}`) instead of the column-letter grid. Use only for tidy, single-header tables — it drops A1 addressing.
- `--raw` — force the A1 column-letter grid, overriding header auto-detection. Mutually exclusive with `--header-row`.
- `--full` — don't cap the number of rendered rows (default cap: 50). `--range` and `--full` compose.
- `--max-rows <n>` — override the default 50-row render cap (ignored under `--full`).
- `--formulas` — render each formula cell as its **formula** (`=B2*C2`) in place of its displayed
  value. Non-formula cells are unchanged. The `formulas[]` block is then omitted (the grid
  already shows them).
- `--json-out[=<path>]`, `--csv-out[=<path>]` — the **whole tab** (or the whole `--range`) to a
  file ([conventions.md § Export files](../api/conventions.md#export-files)): every populated
  row and column regardless of the render cap, as the displayed strings (`formattedValue`, links
  as plain text, not markdown; the formula instead under `--formulas`). The CSV is gws-axi's own
  RFC 4180 serialization of the grid in sheet order, so a header row is its first line; the JSON
  is `{tab, origin, columns, rows}` — `origin` the A1 cell of `rows[0][0]`, `columns` the header
  names when the header was promoted (and the header row is then not in `rows`), else the column
  letters, `rows` arrays of strings padded to `columns`' width. The preview on stdout is the same
  capped render as without the flag; the response adds `wrote:`, `columns:` (`<name>:string`
  each — every value is a display string) and the help line. At most one of the two.
- `--account <email>` — account override.

## Data Requirements

- Sheets `spreadsheets.get` with `fields=spreadsheetId,properties.title,sheets(properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount,frozenRowCount)))` — cheap metadata for the tabs listing (and `frozenRowCount` for header auto-detection); **no cell data**.
- Sheets `spreadsheets.get` with `includeGridData=true`, `ranges=[<window>]`, and `fields=sheets(data(rowData(values(formattedValue,userEnteredValue,effectiveValue,hyperlink,note,textFormatRuns(startIndex,format(link(uri)))))))` — the grid **plus** formulas (`userEnteredValue.formulaValue`), error values (`effectiveValue.errorValue`), embedded links and cell notes in one call (rather than a plain `values.get`, which would return only display text and silently drop links/notes). Only issued once a specific tab is being rendered. Covered by the `spreadsheets` scope; no new scope.
  - **Bounded default window**: with neither `--range` nor `--full`, the window is bounded to the render cap (`A1:<lastCol><maxRows+2>`, `lastCol` from the tab's `columnCount`) rather than the whole sheet — keeps the read context-sized and fast on tall sheets. `--full` fetches the whole tab; an explicit `--range` is honored verbatim. Trailing fully-empty rows padded by the bounded window are trimmed.
  - **With an export flag** the window is the whole tab (as `--full`) or the explicit `--range`,
    whatever the render cap; the cap then applies to the rendered rows only. Everything counted
    from the fetch then covers the whole tab, not the window: `cells_total_rows` is exact, and
    `notes`/`notes[]`, `formulas` (and `formulas_total`) and `errors` count every cell — so a
    capped read with an export can report more of them than the same read without one.

## Display Rules

Output order: account header, `spreadsheet{}` header, `sheets[N]` tabs listing, then either the grid (`cells`/`rows`) or nothing (multi-tab disambiguation).

### `spreadsheet{}` header

`spreadsheet{id,title,tab?,tab_count?}`. `tab` (the rendered tab's title) when a single tab is rendered; `tab_count` when multi-tab and no `--tab`/`--range`.

### `sheets[N]{gid,title,index,rows,cols}`

Always shown when the file has tabs. `gid` is the numeric `sheetId` (first-class, never truncated — it is the stable handle `--tab` accepts and the value a future write targets). `rows`/`cols` are the tab's grid dimensions from `gridProperties` (allocation, not necessarily populated extent). Multi-tab spreadsheets with neither `--tab` nor a tab-qualified `--range` render **only** this listing (no grid) so the agent can pick one.

**`row1` on the disambiguation listing.** When the listing is all there is (multi-tab, no tab
chosen), it gains a sixth column, `row1`: each tab's first-row text, non-empty cells joined
with `, ` and truncated to 120 characters (`…`). An agent choosing among `Sheet1`, `Data` and
`Q3` sees what each holds without reading each one. It comes from **one** `spreadsheets.get`
with a `ranges` entry per grid tab (`'<title>'!1:1`, `formattedValue` only), whatever the tab
count. It is named for what it is — the first row — not `headers`: on many tabs row 1 is a
title, a blank line or data; whether it is a header is the reader's call, and `sheets read
--tab` applies the frozen-row rule once a tab is chosen. Empty for a tab whose row 1 is empty.
Past 100 grid tabs only the first 100 get `row1` (the request carries one range per tab). Best-effort: a failed read leaves the column out and adds `row1: unavailable (<reason>)` to
the `spreadsheet{}` header. A rendered-tab response keeps the five-column listing — the grid
below it already shows row 1.

### Grid content

Rendered only when a tab is selected. Two shapes:

- **Default (column-letter grid)** — `cells[N]{row,A,B,…}`: each row carries its real sheet row number in `row`, and every column is keyed by its true A1 letter, both derived from the *origin of the returned range* (parsed from the `values.get` `range` field, so a `--range C5:E9` renders `cells[N]{row,C,D,E}` starting at `row: 5`). Ragged rows pad to the widest row in the range. This is the honest, addressable default: it never assumes the data is headered, and every cell stays A1-addressable for a later write. See [principles.md#ids-are-first-class](../principles.md#ids-are-first-class) — the A1 coordinate is the cell's identifier.
- **Header promotion** — `rows[N]{<h1>,<h2>,…}`: the first fetched row becomes the column names and is consumed as the header; the `row` column is dropped. Empty/duplicate header cells fall back to (or disambiguate with) their column letter. Convenience for tidy tables at the cost of addressing; disclosed in help.
  - **Auto-detection**: when neither `--header-row` nor `--raw` is given, a **single frozen top row** (`frozenRowCount === 1`) whose row is inside the fetched window (origin row 1) is auto-promoted — a frozen top row is a user-declared header. Multi-row frozen headers are left as the column-letter grid (promoting only the first would misrepresent them). When auto-promotion fires, the header carries `header_source: frozen-row` and help points at `--raw` to override. `--header-row` forces promotion regardless of freezing; `--raw` forces the column-letter grid.

### Header legend

When the grid renders as `rows[N]{…}` (a promoted header row, by `--header-row` or a frozen
top row), a `headers[N]{letter,header}` block follows it: the A1 letter of each column and
the column name the grid uses (after the empty-header and duplicate fallbacks). Columns are
counted from the fetched origin, so `--range C1:E9` lists C, D, E. Header promotion drops A1
addressing from the rows; the legend gives it back, so an agent that read by names can write
a `sheets query` (which addresses columns by letter) or a `sheets update --cell` without a
second read. Not shown for the `cells[N]{row,A,B,…}` grid, whose columns are already letters.

### Embedded links (inline markdown)

Links embedded in cells are resolved and rendered **inline as markdown** in the grid values, not dropped:

- A **whole-cell hyperlink** wraps the value: `[Transit Data Process](https://drive.google.com/…)`.
- A **rich-text cell** with one or more partial links is reconstructed span-by-span from `textFormatRuns`, so `…seen here or downloaded from here` becomes `…seen [here](u1) or downloaded from [here](u2)`.

When any links were resolved, the header carries `links_resolved: <n>` and a help line notes it. Cells carrying a markdown link are **exempt from the per-cell truncation cap** — cutting a URL mid-string would yield a broken link, and the resolved link is the high-value content this render exists to surface ([principles.md#provenance-by-default](../principles.md#provenance-by-default) in spirit: the linked source travels with the content).

### Cell notes

Cell notes (the Sheets per-cell notes, distinct from Drive **comments** — see help funnel) come back in a `notes[N]{cell,note}` block, each keyed by its A1 cell, shown only when present. The header carries `notes: <n>` when any exist.

### Formulas

A cell whose entered value is a formula is rendered by its **displayed value** in the grid, as
every other cell is, and listed in a `formulas[N]{cell,formula}` block after the grid: the
A1 cell and the formula text as entered (`=SUM(B2:B12)`). The header carries `formulas: <n>`
(the count in the fetched window) whenever there is at least one. The block is capped at 20
rows; past the cap the header carries `formulas_total` and `help[]` offers `--formulas`, which
renders the formulas *in* the grid instead — the right view for checking a model, the wrong
default for reading a report. The two views never mix: a cell shows its value or its formula,
never both in one column.

> **Why by default:** an agent that wrote `=B2*C2` and reads the tab back needs to know which
> cells are computed and which are typed; a displayed `$9,600` says nothing about that. The
> formula is the cell's provenance
> ([principles.md#provenance-by-default](../principles.md#provenance-by-default)), and twenty
> short rows are cheaper than the second call.

### Error values

A cell whose effective value is an error (`#REF!`, `#NAME?`, `#DIV/0!`, `#N/A`, `#VALUE!`,
`#NUM!`, `#ERROR!`) renders its error text in the grid, as the editor shows it, and is listed in
an `errors[N]{cell,error,message}` block: `error` is Sheets' error type (`errorValue.type` —
`REF`, `NAME`, `VALUE`, `DIVIDE_BY_ZERO`, …, the vocabulary the write side's `errors[]` uses)
and `message` its own explanation (`errorValue.message`, e.g. "Unresolved sheet name
'Cost'."). The header carries `errors: <n>` and the **first**
`help[]` line names the count, so an agent never takes `#REF!` for data. Capped at 50 rows
with `errors_total` past the cap. After the count, one `help[]` line per error (up to 5) is a
runnable fix carrying the cell's current formula —
`Fix D2 (#NAME?, Unknown range name: 'Cost'): gws-axi sheets update <id> --tab Costs --cell D2='=Cost!B2*C2'`
— the same line the write side emits ([sheets-write.md](sheets-write.md) § Formula errors:
the feedback loop), so read and write speak one vocabulary — and then a `sheets cell <id>
<cell>` line for the first error ([sheets-cell.md](sheets-cell.md)), the view that shows a
formula beside the values it reads. The scan is the fetched window:
a capped default read says so (`errors` counts the window; `--full` scans the tab).

### Truncation

Cell text is truncated per-cell to 200 chars (`…` marker), except link-bearing cells (above). Row count is capped at 50 (or `--max-rows`) unless `--full`; when capped, `cells_truncated` + `cells_rendered` ride in the header and a `--full`/`--range` suggestion lands in help ([principles.md#minimal-default-schemas](../principles.md#minimal-default-schemas)). Because the default fetch is bounded to the render window, a capped default read reports `cells_note` ("more exist beyond the cap") rather than a precise `cells_total_rows` — the exact total is only known (and shown) when the full scope was fetched (`--full` or an explicit `--range`), honoring [principles.md#surface-completeness-limits](../principles.md#surface-completeness-limits).

### Empty grid

A selected tab (or `--range`) with no populated cells collapses to the canonical empty scalar under the grid's field name: `cells: no data in <tab/range>` ([principles.md#canonical-empty-list-shape](../principles.md#canonical-empty-list-shape)).

## help[] suggestions

Built from the current result:

- Multi-tab, no tab picked → `sheets read <id> --tab <name>` for each of the first few tab titles.
- Grid rendered → `sheets read <id> --tab <t> --range <A1>` to scope, `--full` when row-capped, `--header-row` to promote headers (only when not already set).
- When links were resolved → an `N embedded link(s) resolved inline as markdown` line.
- Review comments funnel → `sheets comments <id>` (Drive comments; see below).
- When the spreadsheet has non-grid sheets (charts): `N chart sheet(s) not listed here; run `sheets tabs <id>` for every sheet` ([sheets-tabs.md](sheets-tabs.md)). Only upstream's `OBJECT` sheets are called charts; any other non-grid sheet (a data-source sheet) is counted as `N other non-grid sheet(s)`. The same line is a suggestion on `TAB_NOT_FOUND`, where a chart sheet's title is the likely miss.
- Version history / provenance funnel → `drive revisions <id>` and `drive activity <id>` (Sheets' `spreadsheets.get` exposes no per-read revision id, so provenance is funnelled to Drive rather than inlined — see Follow-ups in the plan).
- Formatted-values caveat line (see Errors/fidelity).
- When `errors[]` is non-empty, **first**: "N cell(s) show formula errors — see errors[]".
- When `formulas[]` was capped: `sheets read <id> --tab <t> --formulas` to see every formula in the grid.
- When the grid render was capped and no export flag was given: `Save the whole tab: --csv-out or --json-out` ([preview-to-stdout-full-data-to-a-file](../principles.md#preview-to-stdout-full-data-to-a-file)). When one was given: the runnable `jq`/`head` line against the written path.

## Errors & fidelity

- Not found / no access / non-native file → `SPREADSHEET_NOT_FOUND` with access-check suggestions, including a redirect to `drive download` / `drive upload --convert` for the uploaded-`.xlsx` case. (A distinct `NON_NATIVE_SPREADSHEET` code is a follow-up.)
- `--tab` not present → `TAB_NOT_FOUND` listing available tab titles + gids.
- **Fidelity disclosure** ([principles.md#surface-completeness-limits](../principles.md#surface-completeness-limits)): cell values are the displayed strings (`formattedValue`) — not unformatted numbers (`$9,600` is the string, not `9600`). Formulas are not lost: every formula cell is listed in `formulas[]`, or rendered in place with `--formulas`. A `help[]` line states the displayed-strings rule. Embedded links and cell notes are **not** dropped — links inline as markdown, notes in the `notes[]` block.

## Principles

**Inherited:**

- [ids-are-first-class](../principles.md#ids-are-first-class) — the tab `gid` and every cell's A1 coordinate (`row` + column letter) are first-class and never truncated; they are the handles `--tab`/`--range` and future writes consume.
- [minimal-default-schemas](../principles.md#minimal-default-schemas) — tabs listing is 5 columns; the grid is capped at 50 rows with a truncation marker and `--full` escape hatch.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — the formatted-values caveat and the grid-dimensions-are-allocation note keep the render honest about what it is and isn't.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — help names the concrete `--tab`/`--range`/`drive revisions` next steps with real ids.
- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — both `spreadsheets.get` and `values.get` are pure reads.
- [canonical-empty-list-shape](../principles.md#canonical-empty-list-shape) — an empty grid is a scalar under the grid's field name.
- [preview-to-stdout-full-data-to-a-file](../principles.md#preview-to-stdout-full-data-to-a-file) — `--csv-out` / `--json-out` write the whole tab beside the capped preview.
