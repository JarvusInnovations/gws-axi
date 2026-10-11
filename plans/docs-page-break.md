---
status: in-progress
depends: [docs-frontmatter]
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-read.md
issues: [126]
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

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Unit, parser:
  - `---\n\n---` gives one page break;
  - `***` / `___` mixes, and three rules, give one page break;
  - one rule stays a rule;
  - a rule, a paragraph and a rule give two rules;
  - inside a list item or a quote is refused.
- [ ] Unit, phase 1: the empty paragraph and the shift (insert at its start, delete the
      newline after), in descending order with a table and an image elsewhere.
- [ ] Unit, reader: an empty page-break paragraph, and text followed by a break, each with a
      round trip.
- [ ] Live (scratch Doc, <chris@jarv.us>):
  - a metadata table, a double rule and `# Title`: the tab reads back with the double rule,
    one `[pageBreak]` paragraph and no empty paragraph;
  - a PDF export puts the title at the top of page 2.

## Risks / unknowns

- **Two real rules in a row** in an existing Doc read back as a double rule, and become a
  page break on re-write. The spec states this; it follows from the convention.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
