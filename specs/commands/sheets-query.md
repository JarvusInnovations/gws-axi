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
  single-tab spreadsheet needs none, a multi-tab one is `TAB_REQUIRED` without it. (A
  `sheet=` / `gid=` parameter upstream; the query itself never names a tab.)
- `--headers <n>` — how many top rows are column headers. Default: `1` when the tab's top row
  is frozen (the same rule `sheets read` promotes by), otherwise Google's own detection
  (`headers` unset). `0` means none.
- `--limit <n>` — preview row cap (default 50). Never injected into the query; the full
  result is fetched and the preview capped locally, so `--limit` and a `limit` clause in the
  query are independent.
- `--json-out[=<path>]`, `--csv-out[=<path>]` — the full result to a file
  ([conventions.md § Export files](../api/conventions.md#export-files)).

## Data Requirements

`GET https://docs.google.com/spreadsheets/d/<id>/gviz/tq` with `tq=<query>`, `sheet=<title>`
(or `gid=<gid>`), `headers=<n>` when set, `tqx=out:json` (and `responseHandler` fixed so the
wrapper is known), header `Authorization: Bearer <access token>` from the account's token
store (refreshed as every other call is). The response is a JavaScript wrapper around a JSON
object; the object is extracted and read:

- `status: "ok"` → `table{cols[{id,label,type,pattern}], rows[{c[{v,f}]}]}`.
- `status: "error"` → `errors[{reason, message, detailed_message}]`.
- `status: "warning"` → data plus `warnings[{reason, message}]` (`data_truncated` is the
  one that matters: Google capped the result).

For `--csv-out`, a second request with `tqx=out:csv` fetches Google's own CSV of the same
query, so the file is the source's real output.

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| The `gviz/tq` endpoint serves a private spreadsheet to a request carrying a valid OAuth bearer token for an account with read access, with no further scope than the token already has | Documented (Visualization API: OAuth 2.0 for private data). **To verify live** with the `spreadsheets`-scoped token gws-axi holds |
| The JSON response is wrapped (`/*O_o*/\ngoogle.visualization.Query.setResponse({…});`); `tqx=responseHandler:<name>` sets the wrapper's function name | Documented. **To verify live** |
| A syntax error returns `status: "error"` with `reason: "invalid_query"` and a message that names the position; an unknown column letter is reported the same way | Documented. **To verify live** for the message shapes `QUERY_ERROR` passes through |
| `headers=1` names the columns by the first row's text; without `headers`, Google detects a header row by type and the label may be empty, leaving only the letter id | Documented. **To verify live** |
| Cell values carry `v` (raw: number, string, boolean, `"Date(y,m,d)"`) and `f` (formatted, as the sheet displays) | Documented. **To verify live**, including that `f` is absent when it equals `v` |
| The result is capped server-side at some row count, signalled by a `data_truncated` warning | Documented loosely. **To verify live** on a tall tab, and record the cap |
| `tqx=out:csv` returns the same query as CSV with the labels as the header row | Documented. **To verify live** |
| `sheet=<title>` selects a tab by title; `gid=<n>` by id; a title that is not found is an error, not a fallback to the first sheet | **To verify live** — a silent fallback would be a wrong-tab read |

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
help[3]:
  Columns are letters in the query (A, B, …); run `gws-axi sheets read 1AbC… --tab Costs --range 1:1` to see what each letter holds
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
  Google sends one, else the raw `v`; a date without a format renders as `YYYY-MM-DD`. This
  matches `sheets read`'s displayed-strings rule. An empty result is the canonical scalar:
  `rows: no rows matched` ([canonical-empty-list-shape](../principles.md#canonical-empty-list-shape)).
- With an export flag: `wrote:`, `columns:` (already present), and the `jq`/CSV help line
  per the conventions. The JSON file is `{query, columns[{id,label,type}], rows[[v…]]}` —
  the raw `v` values, every row; the CSV file is Google's.

### help[] suggestions

- The letters line (above), always — the query addresses columns by letter and the agent
  usually read the tab by header names.
- The export line when no export flag was given; the `jq`/`head` line when one was.
- The `=QUERY()` equivalent, always: the formula an agent would write to keep the result in
  the sheet, with the tab-qualified range and the `headers` count.
- On `QUERY_ERROR`: Google's message verbatim, the query with a caret under the position
  when the message names one, and a link line to the query-language reference.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | Missing id or query; empty query; two export flags; `--headers`/`--limit` not a non-negative integer; `--tab` disagreeing with nothing (there is no qualified form here) |
| `SPREADSHEET_NOT_FOUND`, `TAB_REQUIRED`, `TAB_NOT_FOUND` | As `sheets read` |
| `QUERY_ERROR` | `status: "error"`: the query itself is wrong (`invalid_query`) — Google's message verbatim, the query echoed, and the reference link |
| `ACCESS_DENIED` | The endpoint refused the token (`access_denied`); suggests `auth login` and that the spreadsheet must be readable by the account |
| `EXPORT_WRITE_FAILED` | The export file could not be written; the query result is still shown |

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
