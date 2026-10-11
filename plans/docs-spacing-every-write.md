---
status: done
depends: [docs-paragraph-spacing]
specs:
  - specs/behaviors/markdown-to-doc.md
pr: 131
---

# Plan: Paragraph spacing on every write, not only new tabs

## Scope

The 0/0 guarantee from `docs-paragraph-spacing` covered `docs create` and `--new-tab` only. A
`--tab` write into a 0/0 tab printed a hint and changed nothing. On 2026-10-11 an owner's Doc's tab, created by an older gws-axi, was regenerated with `--tab` several times
and stayed unspaced: the generating agent never acted on the hint. The owner decided the
guarantee should cover every write.

**Out of scope:** restyling a tab that has any spacing of its own; `replace-text` and
`edit-cell`, which write inside existing paragraphs and never set paragraph spacing.

## Implements

- `specs/behaviors/markdown-to-doc.md` § Spacing: the guarantee bullet, now covering every
  write, with its reason.

## Approach

1. `write.ts` `writeTab`: when `needsParagraphSpacing(tab)`, set `tab.spaceBelowPt` to 10
   before phase 1 (the gap under a table reads it) and put `paragraphSpacingRequest` first in
   the same batch as the content. `WriteResult.spacingSet` carries it to `render()`.
2. Remove `ensureParagraphSpacing` and its separate batch from `create` and `--new-tab`. They
   now go through `writeTab` like `--tab` and `append`.
3. `render()`: the "was set" line names the undo (`--paragraph-spacing 0`), and the pointer
   line for an untouched 0/0 tab goes away, since it can no longer happen.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit: `writeTab`'s first batch comes from the pure `tabWriteRequests`. For a 0/0 tab
      (replace and append) the spacing request comes first and the table gap is 10pt; for a
      tab with 8pt below there is no request and the gap stays 8pt. A tab whose Normal style
      wasn't read is never restyled.
- [x] Live (scratch Doc, <chris@jarv.us>):
  - force a tab to 0/0 with `docs tabs update --paragraph-spacing 0`, then `docs write --tab`
    into it: the tab reads 10pt, and the response says so with the undo;
  - re-run: no restyle line;
  - `docs append` into another 0/0 tab: the same.

## Risks / unknowns

- None known. The request was verified live in `docs-paragraph-spacing`. Batching it ahead of
  the content changes only which batch it rides in.

## Notes

- Live, 2026-10-11 (scratch Doc, <chris@jarv.us>, trashed):
  - `t.0` was forced to 0 with `docs tabs update --paragraph-spacing 0`, then written with
    `--tab`: it read back at 10pt, and the response gave the undo;
  - re-running gave no restyle line;
  - a second `--new-tab` tab, forced to 0, then `docs append`: 10pt.
- **Found on the way:** the API omits a zero magnitude, so "no spacing" and "style not read"
  looked the same. `TabTarget.normalStyleRead` now tells them apart, and an unread style is
  never restyled.
- The reporting Doc's tab, the case that prompted this, was fixed by hand the same day with
  `docs tabs update --paragraph-spacing 10`.

## Follow-ups

- None.
