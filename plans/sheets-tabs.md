---
status: in-progress
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

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Unit: placement index for every flag incl. same-position no-op; `diffTabProps` on each
      property; `LAST_VISIBLE_TAB`; freeze bounds; title collision case-insensitive.
- [ ] Every "To verify live" row Observed (or amended) with a date.
- [ ] Live: `sheets tabs` lists a hidden tab and a chart sheet with `kind: chart`.
- [ ] Live: `--after X` lands after X, `--first` first, `--last` last; re-running is
      `unchanged`; the undo line restores the previous position.
- [ ] Live: `--hide` then `--show`; hiding the last visible tab is `LAST_VISIBLE_TAB`;
      `--freeze-rows 1` makes `sheets read` auto-promote; `--freeze-rows 0` undoes it.
- [ ] Live: deleting a tab referenced from another tab reports the `#REF!` cells with fix
      lines; deleting the only tab is `LAST_TAB`; `cells` matches the populated count.
- [ ] `sheets read` on a spreadsheet with a chart sheet shows the help line.

## Risks / unknowns

- **Index semantics** on `updateSheetProperties` are documented loosely; the probe decides
  the arithmetic, exactly as for Docs.
- **Whole-spreadsheet errors-only scan** on a many-tab file may be slow; the 200k total bound
  is a guess until measured — record the measurement.

## Notes

(At closeout.)

## Follow-ups

(At closeout.)
