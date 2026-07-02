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
- `--account <email>` — account override.

## Data Requirements

- Sheets `spreadsheets.get` with `fields=spreadsheetId,properties.title,sheets(properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount,frozenRowCount)))` — cheap metadata for the tabs listing (and `frozenRowCount` for header auto-detection); **no cell data**.
- Sheets `spreadsheets.get` with `includeGridData=true`, `ranges=[<window>]`, and `fields=sheets(data(rowData(values(formattedValue,hyperlink,note,textFormatRuns(startIndex,format(link(uri)))))))` — the grid **plus** embedded links and cell notes in one call (rather than a plain `values.get`, which would return only display text and silently drop links/notes). Only issued once a specific tab is being rendered. Covered by the `spreadsheets` scope; no new scope.
  - **Bounded default window**: with neither `--range` nor `--full`, the window is bounded to the render cap (`A1:<lastCol><maxRows+2>`, `lastCol` from the tab's `columnCount`) rather than the whole sheet — keeps the read context-sized and fast on tall sheets. `--full` fetches the whole tab; an explicit `--range` is honored verbatim. Trailing fully-empty rows padded by the bounded window are trimmed.

## Display Rules

Output order: account header, `spreadsheet{}` header, `sheets[N]` tabs listing, then either the grid (`cells`/`rows`) or nothing (multi-tab disambiguation).

### `spreadsheet{}` header

`spreadsheet{id,title,tab?,tab_count?}`. `tab` (the rendered tab's title) when a single tab is rendered; `tab_count` when multi-tab and no `--tab`/`--range`.

### `sheets[N]{gid,title,index,rows,cols}`

Always shown when the file has tabs. `gid` is the numeric `sheetId` (first-class, never truncated — it is the stable handle `--tab` accepts and the value a future write targets). `rows`/`cols` are the tab's grid dimensions from `gridProperties` (allocation, not necessarily populated extent). Multi-tab spreadsheets with neither `--tab` nor a tab-qualified `--range` render **only** this listing (no grid) so the agent can pick one.

### Grid content

Rendered only when a tab is selected. Two shapes:

- **Default (column-letter grid)** — `cells[N]{row,A,B,…}`: each row carries its real sheet row number in `row`, and every column is keyed by its true A1 letter, both derived from the *origin of the returned range* (parsed from the `values.get` `range` field, so a `--range C5:E9` renders `cells[N]{row,C,D,E}` starting at `row: 5`). Ragged rows pad to the widest row in the range. This is the honest, addressable default: it never assumes the data is headered, and every cell stays A1-addressable for a later write. See [principles.md#ids-are-first-class](../principles.md#ids-are-first-class) — the A1 coordinate is the cell's identifier.
- **Header promotion** — `rows[N]{<h1>,<h2>,…}`: the first fetched row becomes the column names and is consumed as the header; the `row` column is dropped. Empty/duplicate header cells fall back to (or disambiguate with) their column letter. Convenience for tidy tables at the cost of addressing; disclosed in help.
  - **Auto-detection**: when neither `--header-row` nor `--raw` is given, a **single frozen top row** (`frozenRowCount === 1`) whose row is inside the fetched window (origin row 1) is auto-promoted — a frozen top row is a user-declared header. Multi-row frozen headers are left as the column-letter grid (promoting only the first would misrepresent them). When auto-promotion fires, the header carries `header_source: frozen-row` and help points at `--raw` to override. `--header-row` forces promotion regardless of freezing; `--raw` forces the column-letter grid.

### Embedded links (inline markdown)

Links embedded in cells are resolved and rendered **inline as markdown** in the grid values, not dropped:

- A **whole-cell hyperlink** wraps the value: `[Transit Data Process](https://drive.google.com/…)`.
- A **rich-text cell** with one or more partial links is reconstructed span-by-span from `textFormatRuns`, so `…seen here or downloaded from here` becomes `…seen [here](u1) or downloaded from [here](u2)`.

When any links were resolved, the header carries `links_resolved: <n>` and a help line notes it. Cells carrying a markdown link are **exempt from the per-cell truncation cap** — cutting a URL mid-string would yield a broken link, and the resolved link is the high-value content this render exists to surface ([principles.md#provenance-by-default](../principles.md#provenance-by-default) in spirit: the linked source travels with the content).

### Cell notes

Cell notes (the Sheets per-cell notes, distinct from Drive **comments** — see help funnel) come back in a `notes[N]{cell,note}` block, each keyed by its A1 cell, shown only when present. The header carries `notes: <n>` when any exist.

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
- Version history / provenance funnel → `drive revisions <id>` and `drive activity <id>` (Sheets' `spreadsheets.get` exposes no per-read revision id, so provenance is funnelled to Drive rather than inlined — see Follow-ups in the plan).
- Formatted-values caveat line (see Errors/fidelity).

## Errors & fidelity

- Not found / no access / non-native file → `SPREADSHEET_NOT_FOUND` with access-check suggestions, including a redirect to `drive download` / `drive upload --convert` for the uploaded-`.xlsx` case. (A distinct `NON_NATIVE_SPREADSHEET` code is a follow-up.)
- `--tab` not present → `TAB_NOT_FOUND` listing available tab titles + gids.
- **Fidelity disclosure** ([principles.md#surface-completeness-limits](../principles.md#surface-completeness-limits)): cell values are the displayed strings (`formattedValue`) — **not** underlying formulas or unformatted numbers. A `help[]` line states this so an agent doesn't mistake a formatted cell for its formula. (A `--formula` render option is a documented follow-up.) Embedded links and cell notes are **not** dropped — links inline as markdown, notes in the `notes[]` block.

## Principles

**Inherited:**

- [ids-are-first-class](../principles.md#ids-are-first-class) — the tab `gid` and every cell's A1 coordinate (`row` + column letter) are first-class and never truncated; they are the handles `--tab`/`--range` and future writes consume.
- [minimal-default-schemas](../principles.md#minimal-default-schemas) — tabs listing is 5 columns; the grid is capped at 50 rows with a truncation marker and `--full` escape hatch.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — the formatted-values caveat and the grid-dimensions-are-allocation note keep the render honest about what it is and isn't.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — help names the concrete `--tab`/`--range`/`drive revisions` next steps with real ids.
- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — both `spreadsheets.get` and `values.get` are pure reads.
- [canonical-empty-list-shape](../principles.md#canonical-empty-list-shape) — an empty grid is a scalar under the grid's field name.
