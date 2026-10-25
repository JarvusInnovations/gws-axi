# Command group: sheets tabs, sheets tabs update, sheets tabs delete

## Summary

Manage a spreadsheet's sheets as objects — the tabs `sheets read` lists: list them (chart
sheets included), rename one, move it, hide or show it, freeze its header rows or columns, or
delete it. The placement flags are the ones `sheets add-tab` takes
([sheets-write.md](sheets-write.md) § add-tab), and the whole group is modeled on
[docs tabs](docs-tabs.md) so an agent learns one vocabulary for "where does this tab go"
across both services.

No new scope: `spreadsheets.get` and `spreadsheets.batchUpdate` under the `spreadsheets`
grant.

## Invocation

```
gws-axi sheets tabs <spreadsheetId>
gws-axi sheets tabs update <spreadsheetId> <tab> [--title <title>]
                                                 [--first | --last | --before <tab> | --after <tab>]
                                                 [--hide | --show]
                                                 [--freeze-rows <n>] [--freeze-cols <n>]
gws-axi sheets tabs delete <spreadsheetId> <tab>
```

A tab is addressed by **title or numeric gid**, as every `sheets` command resolves it
(title first, then gid; titles are unique within a spreadsheet, case-insensitively). Chart
sheets are addressable here (to move, hide, rename or delete them) though not in
`sheets read`, which has no cells to show for them.

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| `updateSheetProperties` with a `fields` mask updates `title`, `index`, `hidden`, `gridProperties.frozenRowCount`, `gridProperties.frozenColumnCount`, and touches nothing else | **Observed 2026-10-25**: a `title`-only mask left the freeze counts and visibility as they were; a `hidden`-only mask left the freeze counts |
| `index` on update is interpreted in **before-the-move** positions: on `[S1,S2,S3]`, moving S1 after S2 takes `index: 2`; `--first` → 0, `--last` → the sheet count, `--before X` → `X.index`, `--after X` → `X.index + 1` | **Observed 2026-10-25**: S1 with `index: 2` on `[S1,S2,S3]` gave `[S2,S1,S3]`; `index: 3` (the count) moved it last; `index: 0` first; S3 at 2 with S2's index (1) landed before S2. A sheet sent its own index **or its own index + 1** stays put (200). An index past the count is a 400 ("The new sheet index is too high") |
| Hiding the only visible sheet is refused (400) | **Observed 2026-10-25**: "You can't hide all the sheets in a document." Chart sheets count as visible: with every grid hidden, hiding the one visible chart sheet was refused the same way |
| `frozenRowCount` ≥ `rowCount` (or `frozenColumnCount` ≥ `columnCount`) is refused (400); `0` unfreezes | **Observed 2026-10-25**: 1000 frozen rows on a 1000-row tab → "You can't freeze all visible rows on the sheet." (columns: "…all visible columns…"); 999 and 25 of 26 were accepted; `0`/`0` unfroze both |
| A freeze count on a chart sheet is refused (400) | **Observed 2026-10-25**: "Sheet id: N is not a grid". Chart sheets come back as `sheetType: OBJECT` (not `CHART`), with no `gridProperties` |
| A duplicate title (case-insensitive, chart sheets included) is refused (400) | **Observed 2026-10-24** (`sheets-write.md`); **2026-10-25** for a rename: `s1` beside `S1`, and `chartx` beside a chart sheet `ChartX`, were refused ("A sheet with the name … already exists"). Renaming a sheet to a different case of **its own** title is accepted. An empty title is a 400 ("The sheet name cannot be empty.") |
| `deleteSheet` removes a grid or chart sheet; deleting the only sheet is refused (400) | **Observed 2026-10-25**: grid, hidden grid and chart sheets deleted; the only sheet → "You can't remove all the sheets in a document." **Also refused: deleting the only *visible* sheet** while others are hidden ("You can't remove all the visible sheets in a document.") — chart sheets count as visible here too |
| Formulas on other tabs that referenced a deleted sheet evaluate to `#REF!` | **Observed 2026-10-25**, in the read straight after the delete: `errorValue {type: REF, message: "Unresolved sheet name 'S2x'."}`, and the formula text keeps the old sheet name (`=S2x!A2`), so a fix line can carry it |
| Nothing upstream reports "unchanged"; a no-op property update is a 200 | **Observed 2026-10-25**: same index, same title, same `hidden` — each a 200 with an empty reply |
| An errors-only `spreadsheets.get` with `ranges` unset returns every grid sheet's data, and none for a chart sheet | **Observed 2026-10-25**: mask `sheets(properties(title,sheetType),data(…effectiveValue/errorValue…))`; the `OBJECT` sheet came back with no `data` |

## Behavior

### `sheets tabs <spreadsheetId>` (read)

One `spreadsheets.get` (properties only; no cell data). Lists **every** sheet in index order,
grid and chart alike, with the properties this group can change. Cheap on any spreadsheet.

### `sheets tabs update` (write)

One `spreadsheets.get` for the current properties, then one `updateSheetProperties` whose
field mask is exactly the properties the flags name.

- **Placement** — at most one of `--first`, `--last`, `--before <tab>`, `--after <tab>`.
  The index sent follows the upstream table; the anchor is resolved like the target
  (`TAB_NOT_FOUND` otherwise); an anchor that is the tab itself is a `VALIDATION_ERROR`.
- **Title** — `--title <title>`; empty is a `VALIDATION_ERROR` before any call; a title another
  sheet already holds (case-insensitive, chart sheets included) is a `VALIDATION_ERROR`
  naming it, before any call. The tab's own title in another case is a rename, not a
  collision (upstream accepts it — observed).
- **Visibility** — `--hide` / `--show`; both is a `VALIDATION_ERROR`. Hiding the last visible
  sheet is refused locally with `LAST_VISIBLE_TAB` (computed from the read), naming the
  hidden ones that could be shown.
- **Freezing** — `--freeze-rows <n>` / `--freeze-cols <n>`, non-negative integers; `0`
  unfreezes. A count at or past the tab's allocation is a `VALIDATION_ERROR` naming the
  allocation, before any call; a freeze upstream still refuses (its message speaks of
  *visible* rows, so hidden rows can tip it) is a `VALIDATION_ERROR` carrying upstream's
  message. `--freeze-rows 1` is what `sheets update --header` sets; this
  is the general form, and the only formatting-adjacent property the group touches.
  Chart sheets have no grid: `--freeze-*` on one is a `VALIDATION_ERROR`.
- **Idempotent**: the desired state is compared with the read state. When every named property
  already holds (same title, same hidden state, same freeze counts, and the placement
  already describes the tab's current position), nothing is sent, `action: unchanged`,
  exit 0. Otherwise only the differing properties go in the mask. No property flags at all
  is a `VALIDATION_ERROR` listing them.

### `sheets tabs delete` (write)

One `spreadsheets.get`, then one `deleteSheet`.

- The only sheet is `LAST_TAB`; the suggestion is `sheets clear <id> --tab <t> --all` to
  empty it, or `drive trash <id>` for the whole spreadsheet.
- The only **visible** sheet, while others are hidden, is `LAST_VISIBLE_TAB` (upstream refuses
  it — observed), naming the hidden ones to `sheets tabs update <id> <tab> --show` first.
- An unknown tab is `TAB_NOT_FOUND`, naming the available ones. It is **not** a no-op — a
  deleted tab and a mistyped title look the same, and the mistyped one is likelier.
- A grid tab's **populated cells are counted before the delete** (`values.get` over the tab,
  fast — display text only) and reported as `cells`; the content is gone from the live
  spreadsheet but remains in version history, and the response says so.
- **Formula errors the delete causes elsewhere** are reported: an errors-only scan of the
  whole spreadsheet (every grid sheet; `ranges` unset) before and after, diffed as in
  [sheets-write.md § Formula errors](sheets-write.md#formula-errors-the-feedback-loop), when
  the spreadsheet's total allocation is ≤ 200,000 cells; above it the scan is skipped and
  the header says `error_scan: skipped (spreadsheet is N cells)`. A tab referenced from
  elsewhere turns those formulas `#REF!`, and that is the one way a delete is wrong after the
  fact.

## Output

### `sheets tabs`

```
account: alice@example.com
spreadsheet:
  id: 1AbC…
  title: Q4 Tracker
tabs[4]{gid,title,index,kind,hidden,frozen_rows,frozen_cols}:
  0,Costs,0,grid,no,1,0
  1374928,Notes,1,grid,no,0,0
  882013,Archive,2,grid,yes,0,0
  1190021,Chart1,3,chart,no,,
help[3]:
  Run `gws-axi sheets read 1AbC… --tab <title>` to read one
  Run `gws-axi sheets tabs update 1AbC… <tab> --first|--title "<title>"|--hide|--freeze-rows 1 --account <email>` to move, rename, hide or freeze a tab
  Run `gws-axi sheets tabs delete 1AbC… <tab> --account <email>` to delete one
```

`kind` is `grid` or `chart` (upstream's `sheetType: OBJECT` — a sheet that holds one chart;
data-source sheets, if ever seen, are `other`); `frozen_*` are
empty for a non-grid sheet. The listing never collapses to the empty shape: a spreadsheet
always has at least one sheet.

### `sheets tabs update`

```
account: alice@example.com
action: updated
changed[2]: index, title
tab:
  gid: 882013
  title: Archive 2025
  index: 0
  kind: grid
  hidden: no
  frozen_rows: 0
  frozen_cols: 0
tabs[4]{gid,title,index,kind,hidden,frozen_rows,frozen_cols}:
  …
help[2]:
  Run `gws-axi sheets read 1AbC… --tab 'Archive 2025'` to read it
  Run `gws-axi sheets tabs update 1AbC… 882013 --after Notes --title Archive --account alice@example.com` to undo
```

`changed[]` names the properties written (`index`, `title`, `hidden`, `frozen_rows`,
`frozen_cols`); omitted when unchanged. `tab{}` is the state after the call and `tabs[N]` the
whole listing, so a move is confirmed without a second read. The undo line restores exactly
what this call changed: the previous title, visibility, freeze counts, and the previous
position as `--after <previous predecessor>` or `--first`.

### `sheets tabs delete`

```
account: alice@example.com
action: deleted
deleted:
  gid: 882013
  title: Archive
  kind: grid
  cells: 412
errors: 2
errors[2]{cell,error,message,written}:
  Costs!D2,REF,Unresolved sheet name 'Archive',no
  Costs!D3,REF,Unresolved sheet name 'Archive',no
tabs[3]{gid,title,index,kind,hidden,frozen_rows,frozen_cols}:
  …
help[4]:
  2 formula errors after this delete — see errors[]
  Fix Costs!D2 (#REF!, Unresolved sheet name 'Archive'): gws-axi sheets update 1AbC… --tab Costs --cell D2='=Archive!B2' --account alice@example.com
  The content is out of the live spreadsheet but stays in version history: `gws-axi drive revisions 1AbC…`
  Run `gws-axi sheets tabs 1AbC…` to list what remains
```

`errors[]` cells are tab-qualified here because the errors are, by construction, on other
tabs. `cells` is omitted for a chart sheet.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | Missing id or tab; two placement flags; `--hide` with `--show`; empty or colliding `--title`; a freeze count that isn't a non-negative integer or is at/past the allocation; `--freeze-*` on a chart sheet; an anchor that is the tab itself; `update` with no property flags |
| `SPREADSHEET_NOT_FOUND` | As `sheets read` |
| `TAB_NOT_FOUND` | The target or an anchor names no sheet; lists the available ones (grid and chart). Nothing is written |
| `LAST_VISIBLE_TAB` | `--hide` on the only visible sheet, or `delete` of the only visible sheet while others are hidden (chart sheets count as visible) |
| `LAST_TAB` | `delete` of the only sheet |
| `PROTECTED_RANGE` | Upstream refused the delete because the sheet is protected for this account |

All Google failures pass through `translateGoogleError`. There is no revision guard (Sheets
has none); the listing in every response is the state after the call.

## Dispatcher

Two-word subcommands in the `sheets` dispatcher, as `docs tabs update` / `docs tabs delete`
are in `docs`. `sheets read` gains one `help[]` line when the spreadsheet has non-grid sheets:
`N chart sheet(s) not listed here; run sheets tabs <id> for every sheet`.

## Out of scope

- **Tab color, right-to-left, gridlines** — formatting; not set here.
- **Copying a sheet** (`copyTo`, within or across spreadsheets) — a later verb.
- **Protecting / unprotecting** a sheet — a separate surface.

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
- [ids-are-first-class](../principles.md#ids-are-first-class) — `gid` is in every row and
  every response; a title is accepted because Sheets makes it unique.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — the undo line
  and the listing after every change.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — the delete's
  scan bound is disclosed, never silent.

**Local:**

- **A delete is judged by the spreadsheet it leaves.** The one thing a deleted tab can break is
  a formula on another tab, so the delete reports those, with fixes, the way a value write
  reports the errors it caused in its own tab ([sheets-write.md § Principles](sheets-write.md#principles)).
