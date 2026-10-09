---
status: done
depends: [docs-table-writes]
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-tabs.md
pr: 121
---

# Plan: Guarantee paragraph spacing on tabs gws-axi creates

## Scope

A Doc written by `docs create` into an account whose template gives `NORMAL_TEXT` no
spacing had no paragraph spacing anywhere (the Field Guide). Tabs gws-axi creates (`docs
create`, `--new-tab`) now get Docs' own 10pt-after when their Normal text has none;
`docs tabs update --paragraph-spacing <pt>` fixes existing tabs; a `--tab` write into a
0/0 tab says so.

**Out of scope:** house spacing values (the owner keeps Docs' default); restyling existing
tabs without being asked.

## Implements

- `specs/behaviors/markdown-to-doc.md` § Spacing — the guarantee bullet + upstream row.
- `specs/commands/docs-tabs.md` — `--paragraph-spacing`.

## Approach

1. `write.ts`: the state masks (both forms) read `NORMAL_TEXT` `spaceAbove` + `spaceBelow`;
   `TabTarget.spaceAbovePt`. `ensureParagraphSpacing(api, account, state, tab)` — when both
   are 0, one `updateNamedStyle` (`spaceBelow: 10pt`) under the revision guard, sets
   `tab.spaceBelowPt`, returns true for the response line. Called in `create` after the
   read, and in the `--new-tab` path after a properties re-read of the new tab (its styles
   come from the template, not the reply). `render()` adds the line; a `--tab` write into a
   0/0 tab gets the pointer line instead.
2. `tab-ops.ts`: `--paragraph-spacing <pt>` → `updateNamedStyle` request alongside the
   property update; `changed: paragraph_spacing`; `tab{}.paragraph_spacing`; undo.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit: `needsParagraphSpacing` (0/0 → yes; 0/10, 6/0 → no); flag parsing
      (`--paragraph-spacing 0` ok, `-1`/`x` refused).
- [x] Live: a tab forced to 0/0 (via the new flag) then `docs write --new-tab` → the new
      tab reads 10pt after and the response says so; `docs write --tab` into the 0/0 tab →
      pointer line, style untouched; `docs tabs update --paragraph-spacing 10` → 10, undo
      line restores 0, re-run `unchanged`.
- [ ] The Field Guide fixed with that command (owner's Doc, owner's call — it is in another
      account; the command is in the PR).

## Risks / unknowns

- **`updateNamedStyle` on a brand-new tab** — worked live; a new tab added to a Doc whose
  first tab was zeroed came in at 0/0 itself (tabs inherit the Doc's current style, not
  Google's default), which is exactly the case the guarantee covers.

## Notes

- The Field Guide's tab was Arial 11 with 0/0 — a different account's template than the
  owner's workspace (Droid Sans, 10pt below), so `docs create` there wrote a Doc with no
  paragraph spacing at all, including after the numbered list. The converter inherited an
  empty style faithfully; the principle (space is a paragraph property) was kept and the
  result was still wrong, because a tab can have *no* paragraph property to inherit.
- The value is Docs' own default (10pt), applied only when the tab has none — not a house
  value (owner's rule, 2026-10-09).
- Scratch Doc `1oINXqSRPXPrZlzg2G5Tp_CLa7NKQCM4eIYzo0cFySfU` (<chris@jarv.us>), trashed.

## Follow-ups

- Tracked as: `docs tabs <id>` could list `paragraph_spacing` per tab; today only the
  update response carries it.
