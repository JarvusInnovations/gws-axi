# Command: sheets note

## Summary

Set, replace or clear the **note** on one cell — the per-cell annotation `sheets read` lists in
`notes[N]{cell,note}` and `sheets cell` shows as `note`. Notes are where a human or an agent
leaves a "why" beside a value (`source: Q3 invoice`, `estimate — confirm with vendor`); until
now gws-axi could read them but not write them. Distinct from **comments**, which are Drive
comment threads (`sheets comments`), and from the cell's value.

No new scope: one `updateCells` request under the `spreadsheets` grant.

## Invocation

```
gws-axi sheets note <spreadsheetId> <A1> (--text <note> | --clear) [--tab <name|gid>] [--account <email>]
```

- `<A1>` — one cell, optionally tab-qualified (`Costs!B2`). A range is a `VALIDATION_ERROR`:
  one note per call, by design — notes are prose, not a block.
- `--text <note>` — the note's full text; replaces any existing note. Newlines are kept. An
  empty string is a `VALIDATION_ERROR` pointing at `--clear` (so an empty variable never
  silently clears a note).
- `--clear` — remove the note. With `--text` is a `VALIDATION_ERROR`.
- `--tab` — as every `sheets` write (`TAB_REQUIRED` on a multi-tab spreadsheet unless the cell
  is qualified).

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| `updateCells` with `rows[0].values[0].note` and `fields: "note"` sets the note and changes nothing else about the cell (value, format) | **Observed 2026-10-25**: a cell holding `4200` with a currency format (`"$"#,##0`, showing `$4,200`) kept its value, format and display through a set, a replace and both clear forms. A two-line note came back with its `\n` intact |
| `note: ""` (or an unset `note` with `fields: "note"`) clears it | **Observed 2026-10-25**: both forms clear — afterwards the cell carries no `note` key at all, not an empty one. `--clear` sends the cell with no `note` under the `note` mask (the mask's documented "listed but absent means cleared") |
| A note's length limit, if any, and what the refusal looks like | **Observed 2026-10-25**: none hit at 2,000,000 characters — 50,000, 100,000, 1,000,000 and 2,000,000 each stored and read back at full length. The 50,000-character cell limit is for values only. No local cap |
| A note on a cell in a protected range is refused for a non-editor (400 "protected cell or object") | **Observed 2026-10-25**: an editor of the file outside the range's editors got 400 `INVALID_ARGUMENT` "Invalid requests[0].updateCells: You are trying to edit a protected cell or object…" — the same phrase `translateWriteError` maps to `PROTECTED_RANGE` |

## Behavior

1. **Read**: the tabs, then the cell with `fields=…note,formattedValue` — the current note and
   the cell's displayed value (for the response and the `help[]` read-back line).
2. **Compare**: the same text already there → `action: unchanged`, nothing sent, exit 0.
   `--clear` on a cell with no note → `unchanged`.
3. **Write**: one `batchUpdate` `updateCells` with the single cell's `note` and the field mask
   `note`. `--clear` sends the cell with no `note` under the same mask.
4. No read-back is needed: a note has no evaluation. The response echoes the text as sent.

## Output

```
account: alice@example.com
action: set
spreadsheet:
  id: 1AbC…
  title: Q4 Tracker
  tab: Costs
  gid: 0
  web_view_link: https://docs.google.com/spreadsheets/d/1AbC…/edit#gid=0
cell: Costs!B2
value: "$4,200"
note:
  before: estimate
  after: source: Q3 invoice #1182
help[2]:
  Run `gws-axi sheets cell 1AbC… B2 --tab Costs` to see the cell with its note
  Run `gws-axi sheets note 1AbC… B2 --tab Costs --text 'estimate' --account alice@example.com` to undo
```

- `action` — `set`, `cleared`, or `unchanged`.
- `cell`, `value` — the cell and what it displays, so the note is seen beside what it
  annotates.
- `note{before,after}` — the previous and new text; `before` empty when there was none,
  `after` empty on `cleared`. The undo line restores `before` (`--clear` when it was empty).

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | Missing id or cell; a range; neither or both of `--text`/`--clear`; empty `--text`; `--tab` disagreeing with a qualified cell |
| `SPREADSHEET_NOT_FOUND`, `TAB_REQUIRED`, `TAB_NOT_FOUND` | As `sheets update` |
| `RANGE_INVALID` | Not an A1 cell; a cell outside the tab's grid (checked locally from the tab's row and column counts, before any read) |
| `PROTECTED_RANGE` | Upstream refused |

## Out of scope

- **Several cells in one call** — the note is prose; a batch form can follow if a use
  appears.
- **Reading notes** — already `sheets read` (`notes[]`) and `sheets cell` (`note`).
- **Comments** — `sheets comments` (Drive); writing comments is its own deferred surface.

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
- [provenance-by-default](../principles.md#provenance-by-default) — the previous note rides
  with the write.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions)

**Local:** none beyond the group's — a note write touches the note and nothing else
([sheets-write.md § Principles](sheets-write.md#principles), *values, never the file*).
