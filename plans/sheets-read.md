---
status: in-progress
depends: []
specs:
  - specs/commands/sheets-read.md
  - specs/architecture.md
---

# Plan: Sheets service — read

## Scope

Stand up a new `sheets` service and ship its first read command, `sheets read`,
which mirrors `docs read`'s tab-handling semantics (a spreadsheet's sheets *are*
its tabs) and pulls one tab's cell values into an agent's context.

**In scope:**

- New service scaffold: dispatcher `src/commands/sheets.ts`, client factory
  `sheetsClient`, scope/API/probe wiring, `cli.ts` registration.
- `sheets read` — tabs listing + grid render (`--tab`, `--range`, `--header-row`,
  `--raw`, `--full`, `--max-rows`). Column-letter grid by default; frozen-row
  header auto-detection; **rich fetch via `includeGridData`** so embedded links
  inline as markdown and cell notes surface in a `notes[]` block.
- `sheets comments` — alias of the Drive-comments handler (`docs comments`),
  since Sheets comments are file-agnostic Drive comments.
- Write subcommands scaffolded as `NOT_IMPLEMENTED` stubs with `--help` text
  (`update`, `append`, `clear`, `create`, `add-tab`) — same pattern as
  `docs`/`slides` write stubs.

**Out of scope (future plans):**

- Sheets writes (`update`/`append`/`clear`/`create`/`add-tab`) — stubbed now,
  implemented later.
- Inline provenance/revisions on read (funnelled to `drive revisions` for now).
- `--formula` value-render option and a cross-sheet `sheets find`.

## Implements

- `specs/commands/sheets-read.md` — the whole command: tab model, column-letter
  grid (default) vs `--header-row`, truncation/caps, empty-grid scalar,
  `NON_NATIVE_SPREADSHEET`/`TAB_NOT_FOUND`/`SPREADSHEET_NOT_FOUND` errors,
  formatted-values fidelity caveat.
- `specs/architecture.md` — sheets added to top-level commands, client
  factories, and `SERVICE_SCOPES`.

## Approach

1. **Scopes** (`src/auth/scopes.ts`): add `sheets: "…/auth/spreadsheets"` to
   `SERVICE_SCOPES` (extends the `ServiceName` union → forces `REQUIRED_APIS`
   entry `sheets: "sheets.googleapis.com"`), append `sheets` to `SERVICES`.
   Full read-write scope (matches every other service; avoids a second re-auth
   when writes land). Pre-existing accounts re-auth once to gain it.
2. **Client** (`src/google/client.ts`): `sheetsClient(email)` →
   `google.sheets({ version: "v4", auth })`.
3. **Probe** (`src/google/probe.ts`): `probeSheets(ctx, driveOk)` — same shape as
   `probeDocs`/`probeSlides` (no cheap generic endpoint; scope-presence + drive
   proxy). Wire into `probeAccount`'s return and its token-refresh-fail fallback
   array.
4. **Read handler** (`src/commands/sheets/read.ts`):
   - Parse flags (hand-rolled loop, reject unknowns per AXI §6).
   - `spreadsheets.get` (metadata fields only) → tabs listing; filter to
     `sheetType === "GRID"`.
   - Resolve target tab: `--tab` by title→gid, or tab-qualified `--range`, or
     the sole grid tab, else disambiguation (listing only).
   - `spreadsheets.values.get` for the tab/range; parse the response `range`
     origin to derive starting column letter + row number.
   - Build row objects `{ row, <colLetter>: value, … }`, pad ragged rows,
     truncate cells to 200 chars, cap rows (default 50 / `--max-rows` / `--full`).
   - `--header-row`: promote first fetched row to column names, drop `row`.
   - Render: account header, `spreadsheet{}`, `sheets[N]` listing,
     `cells`/`rows` (or empty scalar), `help[]`.
   - Errors via `translateGoogleError` re-wrapped to domain codes.
5. **Dispatcher** (`src/commands/sheets.ts`): reads = `[read]`; writes =
   stubbed `NOT_IMPLEMENTED`. Copy the docs/slides dispatcher shape
   (account-flag parse, `--help` routing, `resolveAccount`).
6. **CLI** (`src/cli.ts`): register `sheets: sheetsCommand`, add to
   `DESCRIPTION` + `TOP_HELP` (bump command count). NOT in `COMMAND_HELP`
   (real dispatcher handles its own `--help`).
7. **Tests** (`src/commands/sheets/read.test.ts`): unit-test the pure helpers —
   A1 range-origin parsing, `values → row objects` (ragged padding, column
   lettering, cell truncation), header-row promotion, row-cap truncation
   marker, and empty-grid scalar shape.

Column-letter helpers (index→`A`/`AA`, A1 origin parse) are small and pure —
factor them into the handler module (or `src/util/`) so they're directly
unit-testable without a Google client.

## Validation

- [ ] `bun run build` (tsc) passes; `ServiceName` union change compiles with
      `REQUIRED_APIS`/`probe` updated.
- [ ] `bun run test` green, incl. new `sheets/read.test.ts`.
- [ ] `gws-axi sheets --help` lists `read` under reads and the write stubs.
- [ ] `gws-axi sheets read --help` documents flags + tab semantics.
- [ ] Multi-tab spreadsheet, no `--tab` → tabs listing only, no grid, help
      suggests `--tab <name>` per tab.
- [ ] Single-tab (or `--tab`) → `cells[N]{row,A,B,…}` with correct row numbers
      and column letters; `--range C5:E9` origins at `row: 5`, cols `C,D,E`.
- [ ] `--header-row` promotes row 1 to column names and drops `row`; a single
      frozen top row auto-promotes (`header_source: frozen-row`); `--raw` forces
      the column-letter grid.
- [ ] Row-capped render carries the truncation marker + `--full` help.
- [ ] Empty tab/range → `cells: no data in …` scalar.
- [ ] Embedded links resolve inline as markdown `[text](url)` (whole-cell +
      rich-text multi-link), `links_resolved: N` in header, link cells exempt
      from the truncation cap; cell notes surface in `notes[N]{cell,note}`.
- [ ] `sheets comments <id>` returns the same Drive comments as `docs comments`.
- [ ] Non-native file → `NON_NATIVE_SPREADSHEET`; unknown tab → `TAB_NOT_FOUND`
      listing tabs; unknown file → `SPREADSHEET_NOT_FOUND`.
- [ ] `gws-axi doctor` shows a `sheets` row (scope-presence probe).

## Risks / unknowns

- **A1 range-origin parsing** — the `values.get` `range` echo (`'Sheet 1'!C5:E9`)
  needs robust parsing (quoted titles with `!`/`'`, absolute `$` refs). Keep it
  a small pure function with direct tests; fall back to `A1` origin if a parse
  is ambiguous rather than mis-addressing.
- **Grid dimensions vs populated extent** — `gridProperties` is allocation
  (often 1000×26), not populated rows. The listing labels these as `rows`/`cols`;
  the spec notes they're allocation. `values.get` (used range) is the real data.
- **Very wide/tall sheets** — row cap handles height; extreme width (hundreds of
  columns) is left to `--range`. Acceptable for the first slice.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout — expected: Sheets writes, inline provenance, `--formula`,
`sheets find`.)
