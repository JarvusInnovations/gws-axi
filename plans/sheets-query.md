---
status: done
pr: 144
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

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Every "To verify live" row Observed (or amended) with a date.
- [x] Unit: `parseArgs` optional-value flags (`--csv-out`, `--csv-out=./x.csv`,
      `--range=B2` refused, a following path token not consumed); export helper (one flag
      only, auto path + `0600`, explicit path + `~/`, missing parent for explicit path);
      `formatCsv` round-trips `parseCsv` fixtures; query preview rendering (label fallback,
      duplicate labels, `f`/`v`, dates, empty result scalar, the three `rows:` forms).
- [ ] Live: `sheets query` with a `group by` on a scratch tab returns the aggregate;
      `--headers 0` names columns by letter; a syntax error is `QUERY_ERROR` with Google's
      message; an unknown tab is `TAB_NOT_FOUND` (not a wrong-tab read); a tall tab reports
      Google's truncation.
- [x] Live: `--csv-out` writes Google's CSV and `--json-out` the full rows for a query whose
      preview was capped by `--limit`; `wrote:`, `columns:` and the help line appear; the
      auto file is `0600` under the temp dir; `--csv-out=~/…` lands there.
- [x] Live: `sheets read --csv-out` on a 200-row tab writes all 200 rows while stdout shows
      the usual 50; the file opens as a spreadsheet with the header row first.
- [x] `sheets query --help` and `sheets read --help` document the flags; the declaration test
      passes.

## Risks / unknowns

- **Bearer auth on `gviz/tq`** is the whole premise; if the endpoint wants the
  `drive.readonly` scope specifically or refuses bearer tokens, the fallback is the
  `access_token=` query parameter (documented) — probe both before deciding.
- **The response wrapper** may change shape; parse defensively (find the first `{` after
  the handler name, last `}`), and fail loud with the raw head of the body on a miss.
- **Server-side truncation** cap is undocumented; record whatever is observed.

## Notes

- **Auth that works**: `Authorization: Bearer <token>` from the account's token store
  (`getValidAccessToken`, the same refresh path as the API clients). Probed 2026-10-25 by
  down-scoping a refresh to one scope at a time: `spreadsheets` alone → 200, `drive` alone →
  200, `documents` alone or `openid email` → 401. No new scope. The `access_token=` query
  parameter also works and is deliberately not used (token in a URL).
- **The live box left unchecked** is the compound "Live: `sheets query` …" one: group by,
  `--headers 0`, a syntax error (`QUERY_ERROR` with Google's text), an unknown column, and an
  unknown tab (`TAB_NOT_FOUND`, no request sent) all ran live, but **"a tall tab reports
  Google's truncation" could not be produced**. Server-side row cap measured: **none reached**
  — 300,000 rows × 1 column (10.6 MB body) and 50,000 rows × 26 columns (1.3 M cells, 36 MB)
  came back whole with `status: "ok"`. The `data_truncated` path is covered by a mocked test
  only.
- **API surprises** (all recorded in the spec's upstream table, spec amended before code):
  an unknown `sheet=` title *and* an unknown `gid=` silently read the first sheet — so the tab
  is resolved from metadata and only its `gid` is sent; `message` is the constant
  `INVALID_QUERY` and the text is `detailed_message`; `f` is present even when it equals `v`
  for sheet values and absent for computed ones; `Date(y,m,d)` months are zero-based;
  refusals are HTML pages with 401/403/404; `out:csv` returns a query error as bare JSON under
  `text/csv` with HTTP 200, drops the header line when every label is empty, and writes an
  f-less date (out of a `group by`) unpadded (`2026-1-15`); a `format` clause changed the
  column's `pattern` but not `f`.
- **Decisions beyond the plan**: the error position is marked inline with `»` (the SDK
  renders an error's `help[]` on one line, so a caret below cannot line up — spec amended);
  Google's multi-line `detailed_message` is folded onto one line; the letters line adds
  `--raw` (on a frozen-header tab `--range 1:1` alone renders no rows — spec amended); the
  JSON export writes dates as ISO strings rather than `Date(…)`; a failed export renders
  `export_error` beside the preview and exits 1 (conventions amended — the partial-failure
  rule); `sheets read` moved to the shared `parseArgs` with a `READ_FLAGS` declaration, so an
  extra positional is now refused; `requireTab` gained `{ read: true }` so a read's
  `TAB_REQUIRED` no longer says "Nothing was written" (applied to `sheets query` and
  `sheets cell`).
- **Live evidence** (scratch spreadsheets in the owner's safe-to-delete folder): a `limit`-
  capped preview of 3 of 7,143 rows wrote all 7,143 to an auto JSON file at `0600` under
  the temp dir (then `<tmp>/gws-axi/`; per-user since the review round, below); `--csv-out` on a `--limit 2` preview of 5 wrote Google's 5-row CSV;
  `--csv-out=~/…` landed in the home directory; an explicit path in a missing directory gave
  `export_error` with the preview intact and exit 1; `sheets read --csv-out` on a 200-row
  frozen-header tab rendered 50 rows and wrote 201 lines (header first, quoted commas), and
  that file imported through `drive upload --convert` as a spreadsheet whose `count(A)` is
  200. The built binary ran the same under Node.
- **Review round** (spec amended first, then code):
  - **Blocker: auto exports were not owner-only.** `mkdir`'s `0700` does nothing to an
    existing directory, and `writeFileSync` follows symlinks and truncates, so on a shared
    `/tmp` another user's pre-created `0777` `gws-axi/` with symlinks at the predictable names
    would receive the data. Now the auto dir is per-user (`<tmp>/gws-axi-<uid>`, `gws-axi`
    without a uid); it is `lstat`ed after `mkdir` and refused (`EXPORT_WRITE_FAILED`, nothing
    written) unless it is a real directory owned by this uid with no group/other bits; files
    are created `wx` (O_EXCL, which also refuses a symlink at the name), taking `-2`, `-3`, …
    on a collision. Unit tests cover a pre-existing `0777` dir, a symlinked dir, a symlink at
    the target name (the victim file stays untouched) and suffixing. Live: the dir came out
    `0700`, the file `0600`.
  - Parser: a value flag followed by `--<declared flag>=…` is now `needs a value` (`--tab
    --csv-out=x.csv` used to set the tab to that token); `--find '--a=b'` still passes. A
    bare `--csv-out out.csv` is refused as `--csv-out takes its path with =:
    --csv-out=out.csv` (`extraArgumentError`, used by `sheets read` and `sheets query`).
  - Spec: with an export flag `sheets read` counts notes/formulas/errors over the whole tab;
    the conventions now say the rendered rows do not change (counts may become exact).
  - Nits: an explicit path that replaced a file says `overwrote` on `wrote:`;
    `export_error.path` is filled when Google's CSV fetch fails; the read export's
    duplicate-header renaming loops to uniqueness.

## Follow-ups

- Tracked as: export flags on other commands whose payload can outrun its cap (`drive ls`,
  `gmail search`, `chat messages`, `calendar events`) — the plan's out-of-scope list; the
  helper is ready for them.
- Tracked as: Google's `data_truncated` warning has not been observed; if a real cap is ever hit,
  record it on the spec's upstream row and add a live check.
