---
status: done
depends: [docs-page-break, docs-spacing-every-write]
specs:
  - specs/behaviors/markdown-to-doc.md
pr: 133
---

# Plan: No gap above a page's first paragraph or a heading under a heading

## Scope

Two spacing rules the owner asked for on 2026-10-11, after the AI Use Policy Doc opened page 2
with a gap above its title and a 24pt gap between the title (`HEADING_1`) and its first section
(`HEADING_2`):

- the first paragraph after a page break gets `spaceAbove: 0`, the same as the first paragraph
  of a tab;
- a heading directly after another heading gets `spaceAbove: 0`.

**Out of scope:**

- headings appended under existing content, where the paragraph above isn't known to the
  converter;
- changing the template's named styles.

## Implements

- `specs/behaviors/markdown-to-doc.md` § Spacing: *no gap at the top* (now covering page
  breaks) and *no stacked gap between headings*; § Page breaks; the PDF-vs-editor upstream
  row.

## Approach

`phase1Requests` paragraph styles: compare each paragraph with the one before it.

- If the previous paragraph is a page break, and no table sits between them
  (`!followsTable`), set `spaceAbove: 0`.
- If both are headings and no table sits between them, set `spaceAbove: 0`.

The existing under-a-table rule keeps priority.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit:
  - `# A\n## B` → B has `spaceAbove` 0;
  - `# A\npara\n## B` → B has none set;
  - a double rule then `# T` → T has 0;
  - a table, then a page break, then `# T` → T has 0 and the page-break paragraph keeps the
    table gap;
  - `# A`, then a table, then `## B` → B keeps its own space-above (the table rule).
- [x] Live (scratch Doc, <chris@jarv.us>): a table, a page break, `# Title`, `## Section`,
      then text. The title and the section read `spaceAbove` 0.

## Risks / unknowns

- None. Each rule is one more `spaceAbove` in a request that already exists.

## Notes

- Live, 2026-10-11 (scratch Doc, <chris@jarv.us>, trashed): a table, a page break,
  `# Title`, `## Section`, text, `## Next`, text. The page-break paragraph took the table gap
  (10pt). The title and the section read `spaceAbove {unit: PT}`, which is 0, because the
  API omits a zero magnitude. `## Next`, after text, inherits its style's space-above.
- **The earlier page-break spec was wrong about the editor.** A PDF export drops
  space-above at a page's top, and the editor does not. The AI Use Policy Doc showed the
  title's 24pt gap at the top of page 2. The spec's upstream row now records both.
- An existing test expected `### Three` directly under `# One` to keep its gap. It was
  updated, because the new rule removes that gap.

## Follow-ups

- None.
