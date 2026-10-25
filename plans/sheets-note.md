---
status: done
pr: 140
depends: []
specs:
  - specs/commands/sheets-note.md
---

# Plan: Sheets cell notes (sheets note)

## Scope

`sheets note <id> <A1> (--text | --clear)`: one cell's note set, replaced or cleared through
`updateCells` with the `note` mask, idempotent from a pre-read, previous text in the response.

**Out of scope:** batch notes, comments.

## Implements

- `specs/commands/sheets-note.md` — the whole command.

## Approach

1. **Probe first**: the clear form (`note: ""` vs unset with the mask), that value and format
   survive the write, a long note (find the limit or record "none hit at N"), a protected
   cell. Record; amend if contradicted.
2. **Command** (`src/commands/sheets/note.ts`): `parseArgs` with `--text`, `--clear`, `--tab`;
   cell resolution shared with `sheets cell` (`splitQualifiedRange` + `parseA1` kind `cell`,
   `tabFromFlags`); `fetchGrid` with `note,formattedValue`; compare; one `batchUpdate`
   `updateCells` (`start: {sheetId,rowIndex,columnIndex}`, `rows[0].values[0].note`,
   `fields: "note"`); render per § Output with the undo line.
3. Dispatcher entry (`mutation: true`), help text, `flag-declarations` test, README § Sheets,
   CLAUDE.md status.

**Concurrency note:** lands in the same wave as `sheets-tabs` and `sheets-dimensions`, which
also touch `src/commands/sheets.ts`, README § Sheets and CLAUDE.md. Keep additions grouped.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit: flag rules (neither/both, empty `--text`, a range); the compare for set/clear/
      unchanged.
- [x] Every "To verify live" row Observed (or amended) with a date.
- [x] Live: set a note → `sheets read` lists it in `notes[]` and `sheets cell` shows it;
      re-running is `unchanged`; `--text` with new text reports `before`; `--clear` clears and
      the undo line restores; the cell's value and number format are unchanged after.

## Risks / unknowns

- **Clear form**: if `note: ""` leaves an empty note object visible in the editor, use the
  unset-with-mask form; the probe decides.

## Notes

- **Clear form**: both `note: ""` and the unset-with-mask form clear, and both leave no `note`
  key on read-back. The command sends the unset form. The risk above is closed on API evidence;
  how the editor shows a cleared note was not inspected.
- **No length cap**: 50,000 to 2,000,000 characters all stored and read back whole, so there is
  no local limit.
- **Spec amendment**: a cell outside the tab's grid is `RANGE_INVALID`, checked locally from
  the tab's size before the cell read (after the tab metadata, which supplies the size).
- **Undo quoting**: a help line can't hold a newline, so a multi-line note's undo uses `$'…'`.
  Running the printed line restored a two-line note exactly.
- **Review round**: a note starting with `--` (`--- draft ---`) couldn't be set, and its undo
  line was a broken command. Fixed in the shared `parseArgs`: after a value flag only a
  flag-shaped token is a missing value (spec: `specs/api/conventions.md` § Unknown flags).
  Live-checked: `--- draft ---` set, cleared and restored by its undo line; `--text --txet` is
  still refused. Also added a handler test against a mocked client (request shape, nothing sent
  on `unchanged`, grid bounds) and capped the undo line at 2,000 characters of previous note.
- `PROTECTED_RANGE` needed no new code: the note write's 400 carries the same "protected cell
  or object" phrase `translateWriteError` already matches.

## Follow-ups

None.
