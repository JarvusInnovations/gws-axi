---
status: done
depends: []
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-write.md
issues: [104, 105, 109]
pr: 112
---

# Plan: Table writes — no stray paragraphs, clean cells, no leaked tab

## Scope

Three table-insertion defects in the Markdown converter, reported together from the first
real use of status tables (#104, #105, #109), plus the spacing principle they share: **space
is a paragraph property, never an empty paragraph.**

- #104 — a table-only body sends an empty `insertText` (400); a failed `--new-tab` write
  leaves the new tab behind.
- #105 — table cells inherit the text and paragraph style of the paragraph the table split.
- #109 — an empty paragraph is left above every table; the paragraph below one sits flush.

**Out of scope:** multi-line cells (#106), column widths (#107), cell/text edits (#108), house
spacing values on named styles (the principle is encoded; the values stay Docs' defaults until
decided).

## Implements

- `specs/behaviors/markdown-to-doc.md` — § Spacing is a paragraph property, § Atomicity
  (`--new-tab` cleanup), the table row, the new upstream rows, the local principle.
- `specs/commands/docs-write.md` — `--new-tab` failure behavior; `WRITE_INCOMPLETE` row.

## Approach

All in `phase1Requests` / `phase2Requests` (`src/commands/docs/md-to-doc.ts`) and
`docsWriteCommand` (`write.ts`):

1. **Empty body** — emit no `insertText` when the body is empty; the tab's own empty paragraph
   is the one the table splits. The reset requests over `[base, base+1)` stay.
2. **Stray paragraph** — after each `insertTable` at `at`, `deleteContentRange [at-1, at)`
   (after the existing style reset of the stray). Skipped when `at` is the tab's first index;
   that stray instead gets 0pt spacing and a 1pt newline run.
3. **Space after a table** — the paragraph a table precedes gets `spaceAbove` = the tab's
   `NORMAL_TEXT` space-below (read in `readState` from the tab's `namedStyles`, default 10pt),
   unless it is a heading. The top-of-tab `spaceAbove: 0` rule skips a paragraph that a table
   precedes.
4. **Cells** — phase 2 resets each cell's text style (`RESET_TEXT_FIELDS`) and paragraph style
   (`NORMAL_TEXT` + indents) over the inserted text before the run styles; empty cells get the
   paragraph reset over their newline.
5. **`--new-tab`** — `parseMarkdown` + `phase1Requests` run before `addDocumentTab`; `writeTab`
   is wrapped so a failure deletes the tab (best-effort, under the current revision) and the
   error gains a suggestion line saying so, or naming the tab if the delete failed too.
6. Reader: an empty paragraph immediately before a table is not rendered as a blank line
   (today it is absorbed by blank-line collapsing; make it explicit).

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit: table-only body → no `insertText`; stray delete follows each table insert (not at
      the tab's first index); `spaceAbove` on the paragraph after a table (not on a heading,
      not the top-of-tab zero); phase 2 resets every cell before run styles.
- [x] Live (scratch Doc, <chris@jarv.us>): the three repro files from the issues write cleanly;
      `text/plain` export shows no blank line between `Title` and the table; cells after a
      heading read back unbolded; the paragraph after a table has `spaceAbove` 10pt.
- [x] Live: a table as the first block of a tab; a table at the end of an `append`; two
      adjacent tables.
- [x] Live: a forced failure after `--new-tab` (an image URL Google refuses, placed so phase 1
      passes locally) leaves no tab and the error says the tab was removed.

## Risks / unknowns

- **Merge keeps the preceding style** — probed for a heading; a list item or quote before a
  table should behave the same (the preceding paragraph wins). Checked live.
- **Index drift from the stray delete** — it removes one index at `at-1`, below every later
  request in descending order, so earlier (lower) requests are unaffected; verified by the
  existing descending-order design.

## Notes

- **The merge keeps the preceding paragraph's style** — a `HEADING_1` stays a heading with the
  table directly below it, and a list item before a table keeps its bullet. Probed before
  the spec was amended; held on every live shape.
- **Two adjacent tables mid-document end up with nothing between them**: the second table
  (inserted first, descending order) merges its stray into the preceding paragraph, and the
  first table's insert at the second table's start index then does the same. At the *top* of a
  tab the strays can't merge into anything, so each is shrunk (1pt, zero spacing); `docs read`
  skips them. Visible only as structure in `documents.get`.
- **The gap after a table is read from the tab's named style** (`NORMAL_TEXT.spaceBelow`),
  so a Doc whose owner set 6pt gets 6pt; the Docs default is 10pt. A new tab from
  `--new-tab` has no state yet and uses the default.
- **The pre-add dry run** (`phase1Requests` against a fake placement) is pure and cheap; the
  compensating `deleteTab` was exercised live by an image URL Google refuses, which passes
  the local check and fails in the batch.
- Scratch Doc `1zqNMgGxn3w97bFfWIPsFE7FyPphou_Vashbu4gFRcHA` (<chris@jarv.us>), trashed
  afterwards.

## Follow-ups

- Issue: #106 multi-line cells, #107 column widths, #108 `edit-cell` / `replace-text` —
  reviewed together with these; each is its own plan.
- Tracked as: house spacing values on the named styles of tabs gws-axi creates (`docs create`,
  `--new-tab`), once the owner picks values; the principle and `updateNamedStyle` facts are
  recorded in the behavior spec.
- Tracked as: `docs write`'s `TAB_REQUIRED` still embeds a TOON listing in a suggestion string
  (carried from `plans/docs-tabs.md`).
