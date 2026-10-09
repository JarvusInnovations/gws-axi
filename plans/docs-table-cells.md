---
status: in-progress
depends: []
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-read.md
issues: [106]
---

# Plan: Multi-line table cells — `<br>` and lists inside cells

## Scope

#106: a table cell may hold several lines (`<br>`) and a flat list (`- `, `1. `, `- [ ] `
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

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Unit: parser — `<br>` variants, item lines (three kinds), mixed lines, indented item
      flattened + disclosed; phase 2 — request sequence for a two-paragraph cell with a list;
      reader — a cell with two paragraphs and a bulleted one renders `a<br>- b<br>- c`.
- [ ] Live (scratch Doc, chris@jarv.us): the issue's example (`**Inputs**` | three linked
      bullet items) writes, reads back identically through `docs read`, and shows as a real
      bulleted list in the editor; a `<br>` between plain lines is a line break with no gap;
      a checkbox item in a cell; `docs find` matches text in the second line of a cell.

## Risks / unknowns

- **marked's cell text** — `Tokens.TableCell.text` is the raw cell markdown; splitting it
  before lexing means a `<br>` inside inline code (`` `a<br>b` ``) splits too. Accepted;
  disclosed in the spec row if it bites.
- **Bullets inside the header row** — allowed by the model; bold is still forced on row 0.

## Notes

(At closeout.)

## Follow-ups

(At closeout.)
