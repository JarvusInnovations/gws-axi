---
status: in-progress
depends: []
specs:
  - specs/commands/docs-replace-text.md
issues: [108]
---

# Plan: docs replace-text — tab-scoped, formatting-preserving text replacement

## Scope

The first half of #108: `docs replace-text <id> --find --replace [--tab] [--all]
[--ignore-case]`, the Docs API's `replaceAllText` scoped to one tab, with a local match count
that refuses an ambiguous replacement.

**Out of scope:** `edit-cell` by row label (second half of #108, its own plan); patterns;
cross-tab replacement.

## Implements

- `specs/commands/docs-replace-text.md` — the whole command.

## Approach

1. **Shared matcher** — lift `findMatches` out of `src/commands/docs/find.ts` into an exported
   helper that walks structural elements recursively (paragraphs, table cells, nested tables)
   with a `matchCase` option; `docs find` keeps its case-insensitive default and gains matches
   inside tables. `buildContext` exported alongside.
2. **`src/commands/docs/replace-text.ts`** — `parseArgs` with the declared flags; `readState`
   from `write.ts` is not enough (it carries no text), so one `documents.get` with
   `includeTabsContent: true` and a mask covering the tab tree + target tab's segments; tab
   choice reuses the `docs write` rule (`TAB_REQUIRED` listing from `renderTabListing`); count
   over body + headers + footers + footnotes; `batch()` from `write.ts` for the write.
3. Dispatcher entry; `insert-text`/`delete-range` `instead[]` lines point here.
4. README, CLAUDE.md.

## Validation

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Unit: the matcher finds text in body paragraphs and in table cells, case-sensitive and
      not; flag parsing (required flags, empty `--find` refused, empty `--replace` allowed).
- [ ] Live (scratch Doc, <chris@jarv.us>): one match in a bold table cell → replaced, cell still
      bold, `occurrences: 1`; two matches → `MULTIPLE_MATCHES` with both contexts, nothing
      written; `--all` → both; `--ignore-case`; `--replace ""` deletes; a match in another tab
      is untouched; `no_match` on a second run; multi-tab without `--tab` → `TAB_REQUIRED`.

## Risks / unknowns

- **`occurrencesChanged` vs local count** — headers/footers/footnotes are walked to keep them
  equal; any difference is reported, not hidden.
- **Match spanning text runs** — the matcher concatenates runs per paragraph, so a match across
  a bold/plain boundary counts once, as `replaceAllText` treats it.

## Notes

(At closeout.)

## Follow-ups

(At closeout.)
