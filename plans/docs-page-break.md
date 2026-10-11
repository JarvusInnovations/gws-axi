---
status: done
depends: [docs-frontmatter]
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-read.md
issues: [126]
pr: 130
---

# Plan: Page breaks from a double rule

## Scope

Two or more consecutive thematic breaks, with only blank lines between them, become one
`insertPageBreak`, and `docs read` writes a page break back as `---`, a blank line, `---`.
Refused inside a list item or a quote.

**Out of scope:** section breaks (`insertSectionBreak`), and page breaks inside table cells
(Markdown can't put a rule there).

**Differs from the issue on one point:** the issue says the API refuses a page break inside a
list item. It doesn't (observed: the break lands, bulleted). The refusal stays, for the reason
in the spec: the break would split the list.

## Implements

- `specs/behaviors/markdown-to-doc.md` § Page breaks, its construct row and round-trip
  bullet, and two upstream rows.
- `specs/commands/docs-read.md`: the page-break rule.

## Approach

1. Parser (`parseBlocks`): an `hr` following an `hr` (with only `space` tokens between) turns
   the rule block just pushed into `{ pageBreak: true }`; further rules in the run are
   dropped. In a list item or a quote → `VALIDATION_ERROR`.
2. Phase 1:
   - a page-break paragraph is written as an empty `NORMAL_TEXT` paragraph (no border);
   - a shift at its start does `insertPageBreak`, then `deleteContentRange` of the newline
     after the break (`start+1 … start+2`). The shift runs in the existing descending-order
     pass, so nothing it moves is addressed later.
3. Reader (`markdown.ts`): a paragraph with a `pageBreak` element renders its text, if any,
   then `---\n\n---`.
4. Help: the `markdown:` block in `docs write --help` names the double rule.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit, parser:
  - `---\n\n---` gives one page break;
  - `***` / `___` mixes, and three rules, give one page break;
  - one rule stays a rule;
  - a rule, a paragraph and a rule give two rules;
  - inside a list item or a quote is refused.
- [x] Unit, phase 1: the empty paragraph and the shift (insert at its start, delete the
      newline after), with no border; and, with a table directly before it sharing its
      index, the break emitted before the table.
- [x] Unit, reader: an empty page-break paragraph, and text followed by a break, each with a
      round trip.
- [x] Live (scratch Doc, <chris@jarv.us>):
  - a metadata table, a double rule and `# Title`: the tab reads back with the double rule,
    one `[pageBreak]` paragraph and no empty paragraph;
  - a PDF export puts the title at the top of page 2.

## Risks / unknowns

- **Two real rules in a row** in an existing Doc read back as a double rule, and become a
  page break on re-write. The spec states this; it follows from the convention.

## Notes

- Live, 2026-10-11 (<chris@jarv.us>, trashed):
  - a `fit` metadata table, a double rule, `# Document title`, a body paragraph, a single
    rule and a line read back identical to the source;
  - the Doc held one `[pageBreak]` paragraph after the table and the bordered empty
    paragraph for the single rule, and no other empty paragraph;
  - in the PDF the title is the first line of page 2 (y = 71, the same as page 1's first
    line).
- **The reader dropped page breaks above tables.** Its skip for "an empty paragraph directly
  above a table" (the insertion stray) matched a page-break paragraph, which has no text.
  Fixed in the same commit, with a test.
- The issue said the API refuses a page break in a list item; it doesn't. The refusal is
  kept, for the reason the spec gives.

## Follow-ups

- None.
