---
status: in-progress
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

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Unit: flag rules (neither/both, empty `--text`, a range); the compare for set/clear/
      unchanged.
- [ ] Every "To verify live" row Observed (or amended) with a date.
- [ ] Live: set a note → `sheets read` lists it in `notes[]` and `sheets cell` shows it;
      re-running is `unchanged`; `--text` with new text reports `before`; `--clear` clears and
      the undo line restores; the cell's value and number format are unchanged after.

## Risks / unknowns

- **Clear form**: if `note: ""` leaves an empty note object visible in the editor, use the
  unset-with-mask form; the probe decides.

## Notes

(At closeout.)

## Follow-ups

(At closeout.)
