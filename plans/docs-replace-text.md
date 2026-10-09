---
status: done
depends: []
specs:
  - specs/commands/docs-replace-text.md
issues: [108]
pr: 114
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
   `includeTabsContent: true`; tab choice reuses the `docs write` rule (`TAB_REQUIRED` listing
   from `renderTabListing`); count over body + headers + footers + footnotes; `batch()` from
   `write.ts` for the write.
3. Dispatcher entry; `insert-text`/`delete-range` `instead[]` lines point here.
4. README, CLAUDE.md.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit: the matcher finds text in body paragraphs and in table cells, case-sensitive and
      not; flag parsing (required flags, empty `--find` refused, empty `--replace` allowed).
- [x] Live (scratch Doc, <chris@jarv.us>): one match in a bold table cell → replaced, cell still
      bold, `occurrences: 1`; two matches → `MULTIPLE_MATCHES` with both contexts, nothing
      written; `--all` → both; `--ignore-case`; `--replace ""` deletes; a match in another tab
      is untouched; `no_match` on a second run; multi-tab without `--tab` → `TAB_REQUIRED`.

## Risks / unknowns

- **`occurrencesChanged` vs local count** — headers/footers/footnotes are walked to keep them
  equal; any difference is reported, not hidden.
- **Match spanning text runs** — the matcher concatenates runs per paragraph, so a match across
  a bold/plain boundary counts once, as `replaceAllText` treats it.

## Notes

- **`bun run dev` drops an empty-string argument** — `--replace ""` reached the parser as a
  missing value under the dev script only. `bun bin/gws-axi.ts` directly and the built Node
  binary pass it through; the delete case was validated through `node dist/bin/gws-axi.js`.
  Recorded in CLAUDE.md § Commands so the next person doesn't chase it as a product bug.
- The replacement keeps the replaced text's style: `**Generating**` in a cell came back as
  `**Refining**`. Every live row in the Validation list held, including the local count
  matching `occurrencesChanged` on each write (1, 1, 2, 1).
- `TAB_REQUIRED` here embeds the tab listing in a suggestion string, the same as `docs write`;
  the inline-ids follow-up from `plans/docs-tabs.md` covers both.
- Scratch Doc `1ulPyE_5Wxqut_sF1eL34gE2kQZTag7UQ5SnvAEBkxSI` (<chris@jarv.us>), trashed.

## Follow-ups

- Issue: #108 second half — `edit-cell` by row label; next plan.
- Tracked as: `docs find` could offer `--match-case` now that the matcher supports it; not
  asked for yet.
- Tracked as: the three places that translate a `documents.get` failure (`find`, `write`,
  `replace-text`) duplicate the same `DOCUMENT_NOT_FOUND` / `NON_NATIVE_DOCUMENT` mapping;
  worth one helper when the next one appears.
