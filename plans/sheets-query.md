---
status: planned
depends: []
specs:
  - specs/commands/sheets-query.md
  - specs/commands/sheets-read.md
  - specs/api/conventions.md
  - specs/principles.md
---

# Plan: sheets query and the export-file contract

## Scope

`sheets query <id> "<tq>"` over the Visualization Query endpoint (`gviz/tq`) with the
account's OAuth token: capped preview, `columns:` line, Google's errors as `QUERY_ERROR`,
the `=QUERY()` equivalent in help. The **export-file contract** from
[conventions § Export files](../specs/api/conventions.md#export-files) implemented once
(`src/util/export.ts`) and adopted by two commands: `sheets query` (JSON from the result,
CSV from Google's `tqx=out:csv`) and `sheets read` (`--csv-out` / `--json-out` of the
**whole tab**, uncapped). `parseArgs` gains optional-value flags (`--flag=value`).

**Out of scope:** export flags on any other command (follow-ups once the pair is in use);
query parameter binding; joins.

## Implements

- `specs/principles.md` — § preview-to-stdout-full-data-to-a-file (new).
- `specs/api/conventions.md` — § Export files (new), incl. the optional-value syntax.
- `specs/commands/sheets-query.md` — the whole command.
- `specs/commands/sheets-read.md` — § Flags gains `--json-out[=path]` / `--csv-out[=path]`
  (the whole tab: every populated row and column, display strings, header row as the CSV's
  first line / JSON `columns`), § help[] gains the export line when the render was capped.
  **Amend the read spec in this plan's first `docs(specs):` commit** — the flag lines are
  not yet in it.

## Approach

1. **Probe first**: every "To verify live" row of the query spec's upstream table, on a
   scratch spreadsheet in the owner's safe-to-delete folder, through a bun script that
   takes the token from the account's token store (`src/google/tokens.ts`) and calls
   `gviz/tq` with `fetch`. Record each as Observed; amend the spec first if contradicted.
   Specifically settle: bearer auth on a private sheet; the wrapper and `responseHandler`;
   error shapes; `headers`; `v`/`f`; the server row cap; CSV; title-not-found behavior.
2. **Flags** (`src/util/flags.ts`): `FlagSpec.optional: string[]` — flags that may carry
   `=value`; `parseArgs` splits `--x=y` only for those, records presence in `booleans` and
   the value in `values` when given; a value flag given as `--range=B2` stays the existing
   usage error. `flag-declarations.test.ts` learns the new kind. Unit tests.
3. **Export helper** (`src/util/export.ts`): `parseExportRequest(parsed)` (one of
   `--json-out`/`--csv-out`, else `VALIDATION_ERROR`), `resolveExportPath(req, kind)`
   (`os.tmpdir()/gws-axi/<stamp>-<kind>.<ext>`, `~/` expansion), `writeExport(req, kind,
   data, {rows, columns})` → `{path, wrote, columns, helpLine}`; auto paths `0600`, parent
   dirs created for auto paths only. Port the shape from the owner's metabase-axi
   (`src/output.ts` there) without its Metabase specifics. Unit tests with a temp dir.
4. **Endpoint client** (`src/google/gviz.ts`): build the URL, send with the bearer token
   (reusing the token refresh path the API clients use), unwrap the response, map
   `status`/`errors`/`warnings` to a typed result; `ACCESS_DENIED`/`QUERY_ERROR`
   translation. Keep it separate from `client.ts`'s googleapis factories — it is not a
   Google API client.
5. **Command** (`src/commands/sheets/query.ts`): flags, tab resolution (`requireTab`),
   `headers` default from `frozenRows`, the preview (`rows[N]{…}` with label/id fallback,
   `f` else `v`, date rendering), `rows:` with the three forms, `columns:`, help lines
   (letters, export, `=QUERY()`), exports. Mocked-client handler tests.
6. **`sheets read` exports**: with a `*-out` flag the read fetches the whole tab (as
   `--full` does) regardless of the render cap, renders the usual capped preview, and writes
   the file: CSV via gws-axi's own RFC 4180 writer (the inverse of `parseCsv` — add
   `formatCsv` beside it), JSON as `{columns[letters or headers], rows[…]}`. `wrote:` and the
   help line per the contract.
7. Dispatcher entry (`mutation: false`), help texts, README § Sheets (query + the export
   flags on read), CLAUDE.md status bullet, a one-line mention in the top-level `--help`
   notes that `*-out` exists.

## Validation

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Every "To verify live" row Observed (or amended) with a date.
- [ ] Unit: `parseArgs` optional-value flags (`--csv-out`, `--csv-out=./x.csv`,
      `--range=B2` refused, a following path token not consumed); export helper (one flag
      only, auto path + `0600`, explicit path + `~/`, missing parent for explicit path);
      `formatCsv` round-trips `parseCsv` fixtures; query preview rendering (label fallback,
      duplicate labels, `f`/`v`, dates, empty result scalar, the three `rows:` forms).
- [ ] Live: `sheets query` with a `group by` on a scratch tab returns the aggregate;
      `--headers 0` names columns by letter; a syntax error is `QUERY_ERROR` with Google's
      message; an unknown tab is `TAB_NOT_FOUND` (not a wrong-tab read); a tall tab reports
      Google's truncation.
- [ ] Live: `--csv-out` writes Google's CSV and `--json-out` the full rows for a query whose
      preview was capped by `--limit`; `wrote:`, `columns:` and the help line appear; the
      auto file is `0600` under the temp dir; `--csv-out=~/…` lands there.
- [ ] Live: `sheets read --csv-out` on a 200-row tab writes all 200 rows while stdout shows
      the usual 50; the file opens as a spreadsheet with the header row first.
- [ ] `sheets query --help` and `sheets read --help` document the flags; the declaration test
      passes.

## Risks / unknowns

- **Bearer auth on `gviz/tq`** is the whole premise; if the endpoint wants the
  `drive.readonly` scope specifically or refuses bearer tokens, the fallback is the
  `access_token=` query parameter (documented) — probe both before deciding.
- **The response wrapper** may change shape; parse defensively (find the first `{` after
  the handler name, last `}`), and fail loud with the raw head of the body on a miss.
- **Server-side truncation** cap is undocumented; record whatever is observed.

## Notes

(At closeout.)

## Follow-ups

(At closeout.)
