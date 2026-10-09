# Command: docs edit-cell

## Summary

Replace the content of **one table cell**, addressed by the row's label, leaving the table and
every other cell exactly as they are. The second half of #108: a status table on a tab that
humans also edit and format can be updated one cell at a time ("mark me done on v3") without
`docs write` rewriting the tab and discarding their column widths, styles and recent edits.
Sibling of [docs replace-text](docs-replace-text.md), for the case where the new value is not a
substring swap.

No new scope: `documents.get` + `documents.batchUpdate` under the existing `documents` grant.

## Invocation

```
gws-axi docs edit-cell <documentId> --row <label | #n> --text <markdown> [--tab <id>] [--table <n>] [--col <n>] [--account <email>]
```

- `--row <label>` — REQUIRED. The row whose **first cell's text** equals the label (trimmed,
  case-sensitive, emphasis ignored — `**State**` matches `State`). `#n` addresses the n-th row
  (1-based, the header row is 1) for a table without labels or with duplicate ones.
- `--text <markdown>` — REQUIRED. The cell's new content, in the cell Markdown
  [docs write](docs-write.md) accepts inside a table: inline styles, links, `<br>` lines,
  `- `/`1. `/`- [ ] ` items ([markdown-to-doc](../behaviors/markdown-to-doc.md)). `""`
  empties the cell.
- `--tab <id>` — the same rule as `docs write`: omitted on a single-tab Doc → that tab;
  omitted on a multi-tab Doc → `TAB_REQUIRED`.
- `--table <n>` — which table in the tab, 1-based in document order. Default `1`.
- `--col <n>` — which cell in the row, 1-based. Default `2` (the value column of a
  label/value table).

## Behavior

1. **Read**: one `documents.get` with `includeTabsContent: true`.
2. **Locate**: the tab; its n-th table (`TABLE_NOT_FOUND` names how many the tab has); the row
   by label (`ROW_NOT_FOUND` lists the labels; `ROW_AMBIGUOUS` lists the matching row numbers
   and says to use `#n`); the cell by column (`VALIDATION_ERROR` names the row's width).
3. **Compare**: the cell's current text (paragraphs joined by newlines, hard breaks as
   newlines) against the new text's. Equal → `action: unchanged`, nothing written, exit 0.
   Styles are not compared — restyling identical text is not an edit this command makes.
4. **Write**: one `batchUpdate` under `writeControl.requiredRevisionId`: delete the cell's
   content (keeping its final paragraph), clear any bullet on it, then the same fill the
   converter gives a new cell — insert, style reset, the Markdown's own styles, bullets.
   The cell's paragraph alignment and the table's column widths, borders and other cells
   are untouched.

The new content gets exactly the style its Markdown asks for, not the style the cell had:
the rule [docs write](docs-write.md) applies to every cell (#105). To keep a bold value
bold, write `**bold**`.

## Output

```
account: alice@example.com
action: edited
document:
  id: 1BxAbc…
  title: Roadmap
  tab: t.k3j2
  tab_title: Status
  revision_id: ALBJ4Lu…
table:
  index: 1
  rows: 5
  columns: 2
cell:
  row: 3
  col: 2
  label: State
  before: Generating (round 3)
  after: "**Refining** (round 4)"
lossy: none
help[3]:
  Verify: `gws-axi docs read 1BxAbc… --tab t.k3j2`
  Compare with the version before: `gws-axi docs diff 1BxAbc… ALBJ4Lt…`
  Undo: `gws-axi docs edit-cell 1BxAbc… --row "State" --text "Generating (round 3)" --tab t.k3j2 --account alice@example.com`
```

- `action` — `edited` or `unchanged`.
- `cell.before` — the cell's content **as Markdown**, the way `docs read` renders that cell;
  `after` is the `--text` as given. The undo line writes `before` back.
- `lossy[]` / `lossy: none` — as `docs write`, for the new content.
- `revision_id` — the head revision after the write; on `unchanged`, the one read.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | Missing id, `--row` or `--text`; `--table`/`--col` not a positive whole number; `--col` beyond the row's cells; unknown flag |
| `DOCUMENT_NOT_FOUND`, `NON_NATIVE_DOCUMENT` | As `docs write` |
| `TAB_REQUIRED`, `TAB_NOT_FOUND` | As `docs write` |
| `TABLE_NOT_FOUND` | The tab has no table, or fewer than `--table` |
| `ROW_NOT_FOUND` | No row's first cell equals the label; lists the labels |
| `ROW_AMBIGUOUS` | Two or more rows match the label; lists their numbers for `#n` |
| `DOCUMENT_CHANGED` | The Doc's revision moved between the read and the write; nothing written |

## Dispatcher

The scaffolded `edit-cell` stub becomes a real `{ mutation: true }` entry with its own flag
declaration; `insert-text`/`delete-range` `instead[]` lines gain it beside `replace-text`.

## Out of scope

- Editing a header cell's **bold**: the header row is written bold by the converter; an edit
  to row 1 gets the Markdown's styles like any cell. Write `**label**`.
- Adding or removing rows and columns; merging cells.
- Addressing by column label (a column header) — `--col <n>` for now.

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
- [ids-are-first-class](../principles.md#ids-are-first-class) — the tab by id; the row by its
  own text, which is what a human calls it, with `#n` as the unambiguous fallback.
- [provenance-by-default](../principles.md#provenance-by-default) — `revision_id`, the
  `docs diff` line.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — the undo line
  carries the exact previous content.
- [fail-loud-on-unknown-flags](../principles.md#fail-loud-on-unknown-flags)

**Local:**

- **One cell, nothing else.** The write touches the addressed cell's content and its own
  paragraph styles; it never reaches the table's structure, other cells, or the tab.

  > **Why:** this command exists so humans' hand-formatting survives an agent's update. A
  > wider write would recreate the problem `docs write` already has.
