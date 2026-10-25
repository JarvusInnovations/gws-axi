---
status: done
pr: 146
depends: []
specs:
  - specs/commands/sheets-read.md
  - specs/commands/sheets-write.md
---

# Plan: row1 on the tab listing an agent chooses from

## Scope

Each tab's first-row text as a `row1` column wherever an agent picks a tab before reading
one: the multi-tab listing from `sheets read <id>`, and the listing inside every
`TAB_REQUIRED` error (writes, `query`, `cell`, `note`, dimensions). One batched fetch for
all tabs; best-effort.

**Out of scope:** `sheets tabs` (the properties-only structural view stays cheap); the
listing on a rendered-tab response (its grid shows row 1).

## Implements

- `specs/commands/sheets-read.md` — § `sheets[N]` `row1`.
- `specs/commands/sheets-write.md` — § Choosing the tab, the `TAB_REQUIRED` listing.

## Approach

1. `shared.ts`: `fetchRow1(api, account, id, tabs)` → `Map<gid, string>` or
   `{unavailable}`, one `spreadsheets.get` (`ranges` per tab, `sheets(properties(sheetId),
   data(rowData(values(formattedValue))))`); `row1Text(cells)` (join non-empty with `, `,
   cap 120); `renderTabs(tabs, row1?)` adds the column.
2. `read.ts`: the disambiguation path fetches and renders `row1`.
3. `TAB_REQUIRED`: `requireTab` stays synchronous and attaches the spreadsheet context to the
   error; the `sheets` dispatcher catches `TAB_REQUIRED` with that context, fetches `row1`
   once, and rethrows with the listing re-rendered. One place, every command.
4. Tests: `row1Text` (join, empty cells, cap), `fetchRow1` mapping by sheetId, the read
   listing with and without a failed fetch, the dispatcher enrichment. README line,
   CLAUDE.md note.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit tests above.
- [x] Live: `sheets read <multi-tab id>` shows `row1` per tab; `sheets query <id> "select A"`
      without `--tab` shows the `TAB_REQUIRED` listing with `row1`.

## Risks / unknowns

- A spreadsheet with very many tabs makes the one request long; `ranges` is a query
  parameter. Cap at 100 tabs (the rest get no `row1`, disclosed).

## Notes

- Built inline (small change). The dispatcher re-render keeps `requireTab` synchronous for its eight callers; the error carries its spreadsheet under a symbol, so nothing else sees it.
- Live on a scratch spreadsheet in the owner's safe-to-delete folder: a 5-tab listing and a `sheets query` `TAB_REQUIRED` both showed every tab's row 1, including a title with an apostrophe (the range is always quoted).

## Follow-ups

None.
