---
status: done
depends: [docs-table-discoverability]
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-read.md
pr: 119
---

# Plan: `fit` columns — size a column to its content

## Scope

`fit` as a value in the `cols` hint (`<!-- cols: fit 1 -->`): the column is sized to its
widest line, measured by gws-axi from Helvetica/Arial metrics plus a margin; the other
columns share the rest.

**Out of scope:** per-font metrics beyond the platform default (a generic tool assumes no
organization's font); measuring images; row heights.

## Implements

- `specs/behaviors/markdown-to-doc.md` § Fitted columns + the construct row; the
  adjacent-tables clause under § Nothing before a table.
- `specs/commands/docs-read.md` — the round-trip note.

## Approach

1. `src/commands/docs/text-width.ts`: the two ASCII width arrays extracted from Adobe's
   Helvetica / Helvetica-Bold AFMs (copyright notice retained), `measureText(text, {bold,
   sizePt})` with NFD base-letter fallback and a 1-em fallback for non-Latin.
2. Parser: `parseColsHint` returns `Array<number | "fit">`; fractions for the numeric
   entries are of the non-fit share.
3. Phase 2 (`columnWidths(block, contentWidth, fontPt)`, pure): fit widths from the cells
   (header row bold, list indent, hard-break segments), floor 24pt, margin, scaling rule;
   remaining width to the proportional columns.
4. `write.ts`: `NORMAL_TEXT.textStyle(fontSize, weightedFontFamily)` in the state mask;
   `Phase2Input.bodyFontPt`; a help line when a fit was measured for a non-Arial/Helvetica
   body font.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit: `measureText` against AFM values (`a` 11pt = 6.116pt; bold `A` = 7.942pt; `é` as
      `e`; CJK as 1em); `columnWidths` — one fit + one flex, all-fit, bold header dominating,
      list indent, scaling when fits exceed the page; parser accepts `fit` and refuses
      `fit` with a wrong count.
- [x] Live (scratch Doc, chris@jarv.us): a label/value table with `cols: fit 1` lands with
      the label column at the computed width (`tableColumnProperties`), the value column
      taking the rest; `docs read` shows percentages; the response notes the Arial
      measurement on a non-Arial tab.

## Risks / unknowns

- **Rendering can't be checked through the API** (soft wraps are not in the document
  model). The margin is the guard; the user eyeballs a real table once.

## Notes

- **Found and fixed a #112 bug**: two tables mid-document with nothing between them share an
  insertion index; the second (inserted first) merged its stray into the paragraph above,
  which put the first table's insert on the table's own start index — a 400. #112's
  adjacent-tables check was at the top of a tab, where the shrink path runs, so it never
  saw this. Now only the first table of a same-index group merges upward; the stray between
  two tables is shrunk, as it must be (its own range can't be deleted). Spec clause added.
- Live fit on a Droid Sans tab: `Owner / reviewer` (bold label) → 106pt, value column 362pt;
  an all-fit table came out 38/63pt. Measured as Arial; the response said so. The Doc was
  left in place (`1oX4px_fnZB81KSiMF8RY0X115ziEwyyFs6HX8hDorbc`) for the owner to eyeball
  wrapping, which the API can't show.
- The metrics are the platform default on purpose: no organization's font is special-cased
  (owner's call, 2026-10-09). The margin (6% + 2pt) is what covers other proportional fonts.

## Follow-ups

- None: `fit` completes the `cols` hint; the remaining table ideas (caption-row merge,
  `|` escaping in cells) are tracked on the earlier plans.
