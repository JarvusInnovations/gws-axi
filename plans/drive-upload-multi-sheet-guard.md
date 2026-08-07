---
status: done
depends: [drive-upload-multi-tab-guard]
specs:
  - specs/commands/drive-upload.md
issues: []
pr: 48
---

# Plan: extend the wholesale-replace guard to multi-sheet Spreadsheets

## Scope

[`drive-upload-multi-tab-guard`](drive-upload-multi-tab-guard.md) closed the Docs
half of a hazard and explicitly left the Sheets half open: `drive upload --update`
against a Spreadsheet collapses it to a single sheet, destroying the rest, with no
signal in the output. This closes it on the same terms.

In scope: counting a Spreadsheet target's sheets in the existing `--update`
preflight, reusing `--replace-all-tabs` / `MULTI_TAB_TARGET`, per-type wording, and
the spec amendment. Out: per-sheet writes (that's Sheets `values.update`, i.e. the
deferred `sheets` write surface).

## Verified behavior (live, before implementing)

Against a scratch 3-sheet Spreadsheet (`Sheet1`, `Second`, `Third`, each with
distinct A1 content):

- `drive upload repl.csv --convert --update <id>` → `sheets read` afterwards
  reported **`sheets[1]`**; `Second` and `Third` were gone, and the surviving
  sheet had been renamed to the file's title.
- Identical to the Docs case, and — also identical — it does **not** require
  `--convert`.
- `spreadsheets.get` with a `sheets.properties(sheetId,title)` mask returns the
  sheet list without any cell data, so the preflight stays cheap.

## Implements

- **specs/commands/drive-upload.md** — "Multi-tab Doc targets" generalized to
  "Multi-tab targets" with a per-type table; the Sheets out-of-scope note removed
  (now implemented); Errors and Data Requirements updated.

## Approach

1. `src/commands/sheets/tabs.ts` — `listSpreadsheetSheets(account, id)` returning
   the same `TabSummary` shape the Docs helper uses.
2. `drive/upload.ts` — replace the Doc-only `if` with a `TAB_CONTAINERS` map keyed
   by mimeType, carrying the noun/singular/plural/read-command and the list fn.
   One code path, per-type wording.
3. `--replace-all-tabs` and `MULTI_TAB_TARGET` are **reused, not duplicated**: it
   is one hazard with one remedy, and the repo already frames a spreadsheet's
   sheets as its tabs (`sheets read` uses `--tab`). Avoids a near-identical
   `--replace-all-sheets` an agent would have to guess between.
4. The success disclosure carries the right noun ("Replaced 3 sheets with a single
   imported sheet").

## Validation

- [x] Multi-sheet Spreadsheet + `--update` (with and without `--convert`) →
      `MULTI_TAB_TARGET` naming the sheets; file unmodified (`tab_count: 3` after).
- [x] Same call + `--replace-all-tabs` → succeeds, discloses "Replaced 3 sheets".
- [x] Docs regression: multi-tab Doc still blocks with Document/tab wording, and
      the opt-in still discloses "Replaced 3 tabs".
- [x] Single-sheet Spreadsheet `--update` → no friction.
- [x] Non-native (`text/plain`) target → no preflight, unchanged.
- [x] `bun run build`, `lint`, `format:check`, `typecheck`, `test` all clean (211 tests).

## Risks / unknowns

- Reusing `MULTI_TAB_TARGET` for sheets means the code alone doesn't tell an agent
  which type it hit; the message and `help[]` do. Judged better than two codes for
  one hazard, but it is a deliberate trade.
- Slides is the third native type with sub-surfaces (pages), but a Slides target
  can only be updated from a `.pptx` that carries its own slides, so there is no
  equivalent silent flattening. Left unguarded deliberately.

## Follow-ups

- **None.** With Docs and Sheets both guarded, the wholesale-replace hazard is
  closed for every native type `--convert` can target.
