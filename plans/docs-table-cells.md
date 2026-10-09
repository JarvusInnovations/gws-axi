---
status: done
depends: []
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-read.md
issues: [106]
pr: 115
---

# Plan: Multi-line table cells — `<br>` and lists inside cells

## Scope

# 106: a table cell may hold several lines (`<br>`) and a flat list (`-`, `1.`, `- [ ]`
lines), written as hard breaks and bulleted paragraphs inside the cell, and read back the same
way by `docs read`.

**Out of scope:** nested lists in cells (the API can't; flattened + disclosed), column widths
(#107), any other block content in cells (still text + `lossy`).

## Implements

- `specs/behaviors/markdown-to-doc.md` — the two new construct rows, the fidelity rule for
  cells, the upstream row.
- `specs/commands/docs-read.md` § Content — the cell rendering rule.

## Approach

1. **Model** (`md-to-doc.ts`): `TableBlock.rows` becomes `TableCell[][]`, a cell being a list
   of `{ inline, list? }` paragraphs. The table parser splits each cell's raw text on
   `<br\s*/?>`, classifies each line by list marker (`-`/`*`, `\d+[.)]`, `- [ ]`/`- [x]`;
   an indented marker is flattened and counted as `table_cell_nested_list`), lexes each line
   inline, and joins consecutive non-item lines into one paragraph with `\u000b` between
   them.
2. **Phase 2**: per cell, the text is the paragraphs joined with `\n`; one `insertText`, the
   existing resets, run styles per paragraph at their offsets, header bold, then one
   `createParagraphBullets` per run of same-kind items (level 0 — no index shift).
3. **Reader** (`markdown.ts` `renderTable`): per cell paragraph, a bullet → `<marker> text`,
   otherwise text with `\u000b` → `<br>`; paragraphs joined with `<br>`.
4. `lossy` handling table gains `table_cell_nested_list: flattened`; `table_cell_block` keeps
   images/footnotes.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit: parser — `<br>` variants, item lines (three kinds), mixed lines, indented item
      flattened + disclosed; phase 2 — request sequence for a two-paragraph cell with a list;
      reader — a cell with two paragraphs and a bulleted one renders `a<br>- b<br>- c`.
- [x] Live (scratch Doc, <chris@jarv.us>): the issue's example (`**Inputs**` | three linked
      bullet items) writes, reads back identically through `docs read`, and shows as a real
      bulleted list in the editor; a `<br>` between plain lines is a line break with no gap;
      a checkbox item in a cell; `docs find` matches text in the second line of a cell.

## Risks / unknowns

- **marked's cell text** — `Tokens.TableCell.text` is the raw cell markdown; splitting it
  before lexing means a `<br>` inside inline code (`` `a<br>b` ``) splits too. Accepted;
  disclosed in the spec row if it bites.
- **Bullets inside the header row** — allowed by the model; bold is still forced on row 0.

## Notes

- **Nesting inside a cell is not writable**: probed before the spec — a leading tab plus
  `createParagraphBullets` leaves the tab as literal text and the level at 0. Flat lists are
  the whole surface, by API, not by choice.
- **`<br>` is a line break, not a paragraph** (the issue proposed a paragraph): the hard-break
  encoding the converter already uses keeps lines tight — no paragraph spacing opens up
  between them — and reads back as `<br>` through the existing `\u000b` rule.
- The live round-trip of the full fixture was exact up to the spec's normalizations (`[x]`
  → `[ ]`, `2.` → `1.`). The structure dump showed real bullets with links in the cell.
- The `docs find` row was validated by unit test on this branch and live only after merge:
  the branch was cut from `develop` before #114 (the table-walking matcher) landed, so the
  live `find` here still used the body-only walk.
- Scratch Doc `1hhBZ7q1MMJl7rrzGBEp6HGEwM_0aCfs0cJfIDbIDts8` (<chris@jarv.us>), trashed.

## Follow-ups

- Issue: #107 column widths — next plan.
- Tracked as: `|` inside a cell is still rendered as a space by `docs read` (pre-existing);
  escaping it as `\|` would round-trip.
