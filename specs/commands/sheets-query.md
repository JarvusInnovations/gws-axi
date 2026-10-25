# Command: sheets query

## Summary

Run a SQL-like query against one tab and get the result set — without writing a `=QUERY()`
formula into the sheet. The language is Google's Visualization Query Language, the same one
the `QUERY` function evaluates: `select`, `where`, `group by`, `pivot`, `order by`, `limit`,
`offset`, `label`, `format`, with the aggregates `sum`, `avg`, `count`, `min`, `max` and the
scalar functions for dates, strings and arithmetic. Columns are addressed by letter
(`select A, sum(C) where D = 'open' group by A`). There is no join; one tab per query.

Read-only ([read-only-stays-read-only](../principles.md#read-only-stays-read-only)): the
query runs on Google's side and nothing is written to the spreadsheet. The result is a
capped preview on stdout and, on request, the full result in a file
([preview-to-stdout-full-data-to-a-file](../principles.md#preview-to-stdout-full-data-to-a-file)).

No new scope: the endpoint accepts the account's existing OAuth token.

## Invocation

```
gws-axi sheets query <spreadsheetId> "<query>" [--tab <name|gid>] [--headers <n>] [--limit <n>] [--json-out[=<path>] | --csv-out[=<path>]] [--account <email>]
```

- `<query>` — the query text, one argument. Empty is a `VALIDATION_ERROR`. It is passed to
  Google verbatim; gws-axi does not parse it.
- `--tab <name|gid>` — the tab to query, resolved as every `sheets` command does; a
  single-tab spreadsheet needs none, a multi-tab one is `TAB_REQUIRED` without it. (Sent as
  the resolved tab's `gid=` upstream; the query itself never names a tab.)
- `--headers <n>` — how many top rows are column headers. Default: `1` when the tab's top row
  is frozen (the same rule `sheets read` promotes by), otherwise Google's own detection
  (`headers` unset). `0` means none.
- `--limit <n>` — preview row cap (default 50). Never injected into the query; the full
  result is fetched and the preview capped locally, so `--limit` and a `limit` clause in the
  query are independent.
- `--json-out[=<path>]`, `--csv-out[=<path>]` — the full result to a file
  ([conventions.md § Export files](../api/conventions.md#export-files)).

## Data Requirements

First the spreadsheet's metadata (Sheets `spreadsheets.get`, no cell data — the same call every
`sheets` command makes): the tab is resolved **locally** (`--tab` by title, then gid) and its
`frozenRowCount` read for the `headers` default. Then
`GET https://docs.google.com/spreadsheets/d/<id>/gviz/tq` with `tq=<query>`, **`gid=<gid>` of
the resolved tab, always** (never `sheet=<title>`: an unknown title or gid upstream silently
reads the first sheet, below), `headers=<n>` when set, `tqx=out:json;responseHandler:gwsAxi`
(so the wrapper is known), header `Authorization: Bearer <access token>` from the account's
token store (refreshed as every other call is). The response is a JavaScript wrapper around a
JSON object; the object is extracted and read:

- `status: "ok"` → `table{cols[{id,label,type,pattern}], rows[{c[{v,f}]}]}`. A cell may be
  `null` or `{v: null}`; both are empty.
- `status: "error"` → `errors[{reason, message, detailed_message}]`. `message` is a constant
  (`INVALID_QUERY`); the text a person reads is `detailed_message`.
- `status: "warning"` → data plus `warnings[{reason, message}]` (`data_truncated` is the
  one that matters: Google capped the result).

A refused request is not a JSON error: the endpoint answers with an HTML page and an HTTP
status — 401 (no usable token), 403 (the account cannot read the file), 404 (no such file).

For `--csv-out`, a second request with `tqx=out:csv` fetches Google's own CSV of the same
query, so the file is the source's real output. A failing query there comes back as the bare
JSON error object (no wrapper) under `Content-Type: text/csv` and HTTP 200, so a CSV body that
parses as `{"version":…,"status":"error"…}` is the error, not data.

## Upstream behavior relied on

Probed 2026-10-25 against a scratch spreadsheet in the owner's safe-to-delete folder, with
gws-axi's stored token (scopes: `spreadsheets`, `drive`, and the rest of the grant) and with
tokens down-scoped by refresh to one scope each.

| Fact | Status |
| --- | --- |
| The `gviz/tq` endpoint serves a private spreadsheet to a request carrying a valid OAuth bearer token for an account with read access, with no further scope than the token already has | **Observed 2026-10-25.** `Authorization: Bearer` works (200); the documented `access_token=` query parameter works too and is not used (it puts the token in a URL). A token down-scoped to `spreadsheets` alone works, as does `drive` alone; `documents` alone or `openid email` → 401. No token or a bogus one → 401 HTML; another account without access → 403 HTML; a nonexistent id → 404 HTML |
| The JSON response is wrapped (`/*O_o*/\ngoogle.visualization.Query.setResponse({…});`); `tqx=responseHandler:<name>` sets the wrapper's function name | **Observed 2026-10-25.** `responseHandler:gwsAxi` gives `/*O_o*/\ngwsAxi({…});`, with or without `out:json` beside it. HTTP 200, `application/javascript` |
| A syntax error returns `status: "error"` with `reason: "invalid_query"` and a message that names the position; an unknown column letter is reported the same way | **Amended 2026-10-25.** HTTP 200, `reason: "invalid_query"`, but `message` is the constant `INVALID_QUERY`; the text is `detailed_message`: `Invalid query: PARSE_ERROR: Encountered " <ID> "selec "" at line 1, column 1.` followed by the `Was expecting one of:` list; an unknown letter is `Invalid query: NO_COLUMN: Z`. `QUERY_ERROR` passes `detailed_message` (else `message`) through |
| `headers=1` names the columns by the first row's text; without `headers`, Google detects a header row by type and the label may be empty, leaving only the letter id | **Observed 2026-10-25.** `headers=1` labels by row 1. `headers=0` leaves every label empty and returns row 1 as data — and a header word in a numeric column comes back `null` (the column is typed by its majority). Unset: on a tab of all-text columns the labels are empty and the header row is data; on a tab with typed columns under a text row, row 1 becomes the labels |
| Cell values carry `v` (raw: number, string, boolean, `"Date(y,m,d)"`) and `f` (formatted, as the sheet displays) | **Amended 2026-10-25.** `f` is **not** absent when it equals `v`: sheet numbers, booleans and formatted dates always carry `f` (`v: 40.0, f: "40"`; `f: "TRUE"`); strings never do; computed values (aggregates, `toDate()`, `now()`) carry no `f` at all. Dates are `"Date(y,m,d)"` with a **zero-based month** (`Date(2026,0,15)` is 15 January); datetimes `"Date(y,m,d,h,mi,s)"`. A `format` clause changed the column's `pattern` but not `f` (observed: `format B '#,##0.00'` kept `f: "40"`) |
| The result is capped server-side at some row count, signalled by a `data_truncated` warning | **Not reached 2026-10-25.** 300,000 rows × 1 column (10.6 MB body) and 50,000 rows × 26 columns (1.3 M cells, 36 MB body) both came back whole, `status: "ok"`, no warning. The cap, if any, is above that; the `data_truncated` handling stays, unexercised |
| `tqx=out:csv` returns the same query as CSV with the labels as the header row | **Observed 2026-10-25.** `text/csv`, every field quoted, **formatted** values (`$0.05`, `2026-01-15`, `TRUE`) — a value the JSON sends without `f` is Google's own text, so a date out of a `group by` reads `2026-1-15`, unpadded — labels (including `label` clauses with commas) as the first line. When every label is empty (`headers=0`) there is **no** header line. A query error is the bare JSON error object under `text/csv` with HTTP 200 |
| `sheet=<title>` selects a tab by title; `gid=<n>` by id; a title that is not found is an error, not a fallback to the first sheet | **Contradicted 2026-10-25.** An unknown `sheet=` title **and** an unknown `gid=` both silently return the first sheet's data with `status: "ok"`. A title with an apostrophe selects correctly. Hence gws-axi resolves the tab from the spreadsheet's metadata first (`TAB_NOT_FOUND` locally) and sends only the resolved `gid` |


## Display Rules

```
account: alice@example.com
spreadsheet:
  id: 1AbC…
  title: Q4 Tracker
  tab: Costs
  gid: 0
query: select A, sum(C) where D = 'open' group by A
rows: 12
columns: A:Item(string), sum-C:sum Qty(number)
rows[12]{Item,sum Qty}:
  bolts,140
  nuts,80
  …
headers[4]{letter,header}:
  A,Item
  B,Unit
  C,Qty
  D,Status
help[2]:
  Save the full result: --csv-out or --json-out
  The same query inside the sheet: =QUERY(Costs!A:D, "select A, sum(C) where D = 'open' group by A", 1)
```

- `query` — echoed verbatim.
- `rows` — `<n>` when the preview holds every row; `<shown> of <total>` when capped by
  `--limit`; `<shown> of <total> (Google truncated the result)` when the `data_truncated`
  warning came back, with a `help[]` line saying to add `limit`/`offset` or `where` to the
  query ([surface-completeness-limits](../principles.md#surface-completeness-limits)).
- `columns` — one entry per result column: `<id>:<label>(<type>)`; `id` is the letter (or
  Google's derived id such as `sum-C`), `label` the header text or the aggregate's label,
  `type` one of `string`, `number`, `boolean`, `date`, `datetime`, `timeofday`.
- `rows[N]{…}` — column names are the labels; an empty label falls back to the id;
  duplicates are disambiguated with the id. Cells render the **formatted** value (`f`) when
  Google sends one, else the raw `v`; a date without a format renders as `YYYY-MM-DD`, a
  datetime as `YYYY-MM-DD HH:MM:SS`, a time of day as `HH:MM:SS` (the zero-based month of
  `Date(y,m,d)` corrected), a number as JavaScript prints it (`40`, not `40.0`). This
  matches `sheets read`'s displayed-strings rule. Cells are truncated at 200 characters as
  `sheets read`'s are. An empty result is the canonical scalar:
  `rows: no rows matched` ([canonical-empty-list-shape](../principles.md#canonical-empty-list-shape)).
- With an export flag: `wrote:`, `columns:` (already present), and the `jq`/CSV help line
  per the conventions. The JSON file is `{query, columns[{id,label,type}], rows[[v…]]}` —
  the raw `v` values, every row, except that dates, datetimes and times of day are written as
  ISO strings (`2026-01-15`, `2026-10-25T12:30:04`, `12:30:00`) rather than Google's
  `Date(2026,0,15)` with its zero-based month; the CSV file is Google's.
- `wrote:` counts the rows of the JSON result (the CSV's own line count differs by its
  header line, and has none when every label is empty).

### Header legend

Every successful response carries `headers[N]{letter,header}` — the tab's **row 1**, one row
per column whose row-1 cell has text, by its A1 letter. The query addresses columns by
letter; the agent usually knows them by name (from `sheets read`'s `rows[N]{…}`), and the
legend is the map between the two, in the response that needs it. It is fetched in parallel
with the query (one `spreadsheets.get`, row 1, display text only) and costs no round trip.

- Rendered after the result rows. Capped at 100 entries; past the cap the header carries
  `headers_total`.
- Omitted when row 1 has no text, or under `--headers 0` (the caller declared there is no
  header). Row 1 is used even when `--headers` is greater than 1: it is the row a human reads
  as the column's name.
- Best-effort: a failed legend read never fails the query; the response says
  `headers: unavailable (<reason>)` and keeps the `sheets read --range 1:1 --raw` help line.
- **On `QUERY_ERROR`** the legend is the second suggestion, compact:
  `Columns in row 1: A=Item, B=Qty, D=Status` (first 30, then `… N more`) — the usual
  mistake is a wrong letter, and the fix is in the same response.
- With the legend present, the letters help line (`run sheets read --range 1:1 --raw …`) is
  dropped: it would send the agent for what is already above.

The legend never changes the query: gws-axi still passes the text through verbatim
(§ Principles). It tells the agent the letters; the agent writes them.

### help[] suggestions

- The letters line (`run sheets read --range 1:1 --raw`) only when the legend is absent;
  with the legend present it is redundant (§ Header legend). It carries `--raw`: without it, a tab whose top row is
  frozen promotes row 1 to the header and `--range 1:1` renders no rows at all (observed).
- The export line when no export flag was given; the `jq`/`head` line when one was.
- The `=QUERY()` equivalent, always: the formula an agent would write to keep the result in
  the sheet, over the tab's whole column span (`Costs!A:Z` for a 26-column tab) and with the
  `headers` count as its third argument when one was sent (omitted otherwise: `QUERY`'s own
  default detects, as the endpoint does).
- On `QUERY_ERROR`: Google's message verbatim (its line breaks folded to spaces), the query
  with `»` inserted at the position when the message names one (`line L, column C`) — an
  error's `help[]` renders on one line, so a caret on a line below cannot line up — and a link
  line to the query-language reference.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | Missing id or query; empty query; two export flags; `--headers`/`--limit` not a non-negative integer; `--tab` disagreeing with nothing (there is no qualified form here) |
| `SPREADSHEET_NOT_FOUND`, `TAB_REQUIRED`, `TAB_NOT_FOUND` | As `sheets read` |
| `QUERY_ERROR` | `status: "error"`: the query itself is wrong (`invalid_query`) — Google's message verbatim, the query echoed, and the reference link |
| `ACCESS_DENIED` | The endpoint answered 401 or 403 (an HTML page, not a JSON error) — or `reason: "access_denied"`; suggests `auth login` and that the spreadsheet must be readable by the account. (The metadata read runs first, so an account without access is normally `SPREADSHEET_NOT_FOUND` before the endpoint is reached; a 404 from the endpoint is translated the same way) |
| `EXPORT_WRITE_FAILED` | The export file could not be written. The query result is still shown: the preview renders as usual, `export_error: {code, message, path}` replaces `wrote:`, and the command exits 1 |

Unknown `reason` values are passed through as `QUERY_ERROR` with the reason named. HTTP
failures from the endpoint (not the API) go through the same translation as other calls
with the endpoint named in the operation.

## Out of scope

- **Joins across tabs or spreadsheets** — the language has none. An agent wanting one reads
  both tabs and joins locally, or writes an `IMPORTRANGE`+`QUERY` formula by hand.
- **Parameter binding** — the query is a string; quoting is the caller's. (A `--param`
  form can follow if injection-style mistakes show up in use.)
- **Writing a `=QUERY()` cell** — `sheets update --cell` already does that; the help line
  shows the formula.
- **BigQuery / Connected Sheets** — a different tool.

## Principles

**Inherited:**

- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — the query is
  computed upstream; the sheet is untouched.
- [preview-to-stdout-full-data-to-a-file](../principles.md#preview-to-stdout-full-data-to-a-file)
  — the first command built on the export contract.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — Google's
  truncation is surfaced, never hidden behind `rows:`.
- [structured-errors-to-stdout](../principles.md#structured-errors-to-stdout) — the
  endpoint's error block becomes `QUERY_ERROR` with the message intact.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — the
  letters line and the `=QUERY()` equivalent.

**Local:**

- **The query is Google's to parse.** gws-axi passes the text through and reports Google's
  verdict; it never rewrites, validates or augments the query (no injected `limit`, no
  letter-to-header translation). The one thing it adds is context around the error.

  > **Why:** a tool that "helps" with a query language it does not own produces errors the
  > reference does not describe, and an agent debugging against the reference is then lost.
  > The preview cap is applied to the result, not the query, for the same reason.
