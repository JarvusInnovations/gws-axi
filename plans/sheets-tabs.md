---
status: done
pr: 142
depends: []
specs:
  - specs/commands/sheets-tabs.md
  - specs/commands/sheets-read.md
---

# Plan: Sheets tab management (tabs, tabs update, tabs delete)

## Scope

`sheets tabs <id>` (every sheet, chart sheets included), `sheets tabs update` (title,
placement, hidden, freeze rows/cols; idempotent from a pre-read; undo line), and
`sheets tabs delete` (populated-cell count as the record, whole-spreadsheet formula-error
diff). `sheets read` gains the one help line naming unlisted chart sheets.

**Out of scope:** tab color / RTL / gridlines, `copyTo`, protection.

## Implements

- `specs/commands/sheets-tabs.md` — the whole group.
- `specs/commands/sheets-read.md` — the `help[]` line for non-grid sheets (one sentence to
  add to § help[] suggestions, in this PR).

## Approach

1. **Probe first** every "To verify live" row of the spec's upstream table on a scratch
   spreadsheet in the owner's safe-to-delete folder (index semantics on update, hide-last,
   freeze bounds, delete-only, `#REF!` on other tabs, no-op 200). Record each as Observed;
   a contradiction amends the spec in its own `docs(specs):` commit first.
2. **Listing** (`src/commands/sheets/tabs.ts` — replace the stub-era helper there, keeping
   `listSpreadsheetSheets` for `drive upload`): extend `fetchMeta` with `hidden`,
   `frozenColumnCount` and non-grid sheets as `TabInfo`-like rows with `kind`; `renderAllTabs`.
3. **update**: pure `resolveTabPlacement(meta, target, placement)` (index arithmetic per the
   table) and `diffTabProps(current, desired)` → the field mask + `changed[]`; local
   `LAST_VISIBLE_TAB`, title-collision (reuse the case-insensitive helper from `add-tab`),
   freeze bounds; one `updateSheetProperties`; re-read; undo line from the pre-read.
4. **delete**: `values.get` cell count for a grid tab; whole-spreadsheet errors-only scan
   (no `ranges`, mask as `write.ts` `ERROR_FIELDS` plus `properties.title` so cells are
   tab-qualified) before and after when total allocation ≤ 200k; reuse `diffErrors` /
   `fixLines` with tab-qualified cells; `LAST_TAB`.
5. **Dispatcher**: two-word subcommands (`tabs`, `tabs update`, `tabs delete`) following
   `docs.ts`'s pattern; `FlagSpec`s; help text; `flag-declarations` test.
6. README § Sheets + status table, CLAUDE.md status bullet.

**Concurrency note:** `sheets-dimensions` and `sheets-note` land in the same wave and also
append to `src/commands/sheets.ts`, `shared.ts`, README § Sheets and CLAUDE.md. Keep this
plan's additions grouped (one contiguous block per file) so the rebase conflicts are
keep-both.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit: placement index for every flag incl. same-position no-op; `diffTabProps` on each
      property; `LAST_VISIBLE_TAB`; freeze bounds; title collision case-insensitive.
- [x] Every "To verify live" row Observed (or amended) with a date.
- [x] Live: `sheets tabs` lists a hidden tab and a chart sheet with `kind: chart`.
- [x] Live: `--after X` lands after X, `--first` first, `--last` last; re-running is
      `unchanged`; the undo line restores the previous position.
- [x] Live: `--hide` then `--show`; hiding the last visible tab is `LAST_VISIBLE_TAB`;
      `--freeze-rows 1` makes `sheets read` auto-promote; `--freeze-rows 0` undoes it.
- [x] Live: deleting a tab referenced from another tab reports the `#REF!` cells with fix
      lines; deleting the only tab is `LAST_TAB`; `cells` matches the populated count.
- [x] `sheets read` on a spreadsheet with a chart sheet shows the help line.

## Risks / unknowns

- **Index semantics** on `updateSheetProperties` are documented loosely; the probe decides
  the arithmetic, exactly as for Docs.
- **Whole-spreadsheet errors-only scan** on a many-tab file may be slow; the 200k total bound
  is a guess until measured — record the measurement.

## Notes

- **Probes (2026-10-25)** on a scratch spreadsheet in the owner's safe-to-delete folder confirmed every upstream row, with two surprises amended into the spec before the code: deleting the only *visible* sheet while others are hidden is a 400 of its own ("You can't remove all the visible sheets"), now `LAST_VISIBLE_TAB` on delete as well as on `--hide`; and chart sheets are `sheetType: OBJECT`. Chart sheets count as visible for both refusals.
- **Index semantics**: before-the-move positions, exactly as the spec guessed and as Docs behaves. A sheet sent its own index *or* its own index + 1 stays put; an index past the count is a 400. The unchanged check is local, so the no-op never goes upstream.
- **Rename**: a case change of a sheet's own title is accepted upstream, so the collision check skips the target. Upstream's freeze refusal speaks of *visible* rows/columns; the local check uses the allocation and upstream's message passes through for the rest.
- **`#REF!` after a delete**: present in the very next read; the formula text keeps the dead sheet name (`=Archive!B2`), which is what the fix line carries.
- **Scan measurement** (the plan's 200k guess): ~199k allocated cells with 76k populated → 1.8 MB, 0.3–0.6 s for the errors-only whole-spreadsheet read. The bound stays at 200,000, shared with the write side's `ERROR_SCAN_BOUND`. A delete that broke 7,600 formulas reported them all (`errors_total`, 50 rows rendered).
- **Deviation from Approach step 2**: `fetchMeta` was not extended. `tabs.ts` has its own `fetchSheets` that builds the same `SpreadsheetMeta` plus full sheet rows from one call, so `shared.ts` stays untouched while sibling plans edit it. `fixLines` is reused per error with the cell re-qualified.
- **Review round** (PR #142): a sheet titled with digits can shadow another sheet's gid under title-first resolution — writes now refuse such a selector and generated commands name that sheet by title; delete errors carry `title`/`a1` instead of re-parsing a qualified cell (a `'!` title broke it); a tab over 200k cells is no longer fetched to count its cells; `sheets read` repeats the chart line on `TAB_NOT_FOUND` and calls only `OBJECT` sheets charts. Mocked-client handler tests were added (`tabs.handler.test.ts`).
- **Not verified live**: `PROTECTED_RANGE` on update/delete (the owner account can always edit its scratch sheets; classified by the existing "protected cell or object" 400), a freeze refused because of hidden rows, and data-source sheets (`kind: other`).

## Follow-ups

None.
