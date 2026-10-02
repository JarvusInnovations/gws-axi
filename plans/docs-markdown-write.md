---
status: planned
depends: []
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-write.md
  - specs/commands/docs-read.md
  - specs/commands/drive-upload.md
---

# Plan: Markdown writers for Docs (create, write, append)

## Scope

A gws-axi-owned Markdown→Doc converter emitting tab-scoped Docs API requests, and the three
commands built on it: `docs create`, `docs write` (replace one tab or add a new one), and
`docs append`. The `docs read` renderer is brought up to the same mapping so the pair
round-trips. `drive upload --convert` gains the pointer line and keeps Google's importer.

**Out of scope:** positional edits, child tabs, local images, tab delete/rename commands.

## Implements

- `specs/behaviors/markdown-to-doc.md` — the converter and its fidelity contract.
- `specs/commands/docs-write.md` — the three commands.
- `specs/commands/docs-read.md` § Content — the reader's side of the mapping.
- `specs/commands/drive-upload.md` — the help line and the out-of-scope rewording.

## Approach

1. **Converter** (`src/commands/docs/md-to-doc.ts`): parse with `marked` (already a
   dependency) into tokens; walk them into a flat plan of paragraphs with per-run styles,
   list nesting, tables, footnotes, images. From the plan, emit the batch: one `insertText`
   of the full tab text (tabs prefixed for nesting, `\u000b` for hard breaks), then
   `updateParagraphStyle` / `updateTextStyle` / `createParagraphBullets` over computed index
   ranges, `insertInlineImage`, `insertTable` and `createFootnote` placeholders. Index math is
   over the text we inserted, so it is unit-testable without the API.
2. **Second batch** for tables and footnotes: re-read the tab, fill cells (in reverse index
   order) and footnote segments. Failure between batches → `WRITE_INCOMPLETE`.
3. **Horizontal rule**: an empty paragraph with `borderBottom`; verify what Google's exporter
   does with it and record the answer in the behavior spec's table.
4. **Reader** (`src/commands/docs/markdown.ts`): code blocks from all-monospace paragraphs,
   blockquotes from start+end indents, checkbox lists, `\u000b` → hard break, bordered empty
   paragraph → `---`, skip the leading section break, `1.` at every level.
5. **Commands** (`src/commands/docs/write.ts`): shared source parsing with `drive upload`
   (extract the source reader if it is not already shared), tab resolution with `TAB_REQUIRED`
   / `TAB_NOT_FOUND`, `writeControl.requiredRevisionId`, the `lossy[]` report, and
   `create` via `files.create` + the write path.
6. Dispatcher: `create`, `write` real; `append` real; stub `instead[]` lines point at
   `docs write`. README, CLAUDE.md status, `docs.ts` help.

## Validation

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Unit: every row of the construct table produces the expected requests, with index
      ranges checked against the inserted text; `lossy[]` counts for checked tasks, code
      languages, inline HTML, over-deep nesting.
- [ ] Unit: the reader renders fixtures for each construct (code block, quote, checkbox,
      hard break, rule, nested ordered list) and does not emit the leading `---`.
- [ ] Live, scratch folder `1MWU4RkrVuDDIqJL9swWZIvLYCJpP_6Hh` (chris@jarv.us): a fixture
      covering the whole table round-trips through `docs write` → `docs read --tab` after
      normalization; `docs download --as text/markdown` is compared by eye and the behavior
      spec's table updated where it differs.
- [ ] Live: `docs write --tab` on a 2-tab Doc leaves the other tab untouched (its text and
      `docs read` output identical before and after).
- [ ] Live: `docs write --new-tab`, `docs append`, `docs create --parent` each produce the
      documented response; `docs write` on a multi-tab Doc without `--tab` returns
      `TAB_REQUIRED` and writes nothing.
- [ ] Live: a stale `requiredRevisionId` is refused — edit the Doc between a forced read and
      write and confirm `DOCUMENT_CHANGED`.
- [ ] Live: a table and a footnote survive the two-batch write; an `http` image is inserted; a
      local image path is `IMAGE_NOT_FETCHABLE` with nothing written.
- [ ] `drive upload x.md --convert` shows the importer line.

## Risks / unknowns

- **Index math around images and footnote references**: an inline image and a footnote
  reference each occupy one index; the converter must account for them in every later
  range. Unit tests pin this.
- **`requiredRevisionId` under tabs**: documented but unverified; if it misbehaves, fall back
  to comparing `revisionId` on a re-read and say so in the spec.
- **Request count limits** on `batchUpdate` for very large documents are undocumented; a
  cap on body size (with a clear error) may be needed.
- **The bordered-paragraph rule** may not export as `---` through Google; that is a table
  note, not a blocker.

## Notes

_Populated at closeout._

## Follow-ups

_Populated at closeout._
