---
status: done
depends: [docs-read-fit-hint]
specs:
  - specs/behaviors/markdown-to-doc.md
  - specs/commands/docs-write.md
  - specs/commands/drive-upload.md
issues: [125]
pr: 129
---

# Plan: YAML frontmatter — stripped by default, or a table

## Scope

`docs create` / `write` / `append` strip a leading YAML frontmatter block by default and say
so, `--frontmatter keep` writes it as text, and `--frontmatter table` writes its keys as a
`fit` label/value table (with `--frontmatter-keys` to choose rows). `drive upload` strips it
when Markdown becomes a Doc. `docs read` is unchanged.

**Flag shape differs from the issue.** The issue proposes `--keep-frontmatter` and
`--frontmatter-table[=keys]`. The flag parser has no `--flag=value` form anywhere, and an
optional value can't be told from the next positional argument. So it is one mode flag,
`--frontmatter strip|keep|table`, plus `--frontmatter-keys`: one concept, one flag, the same
on both commands.

**Out of scope:** writing frontmatter back from `docs read`; any frontmatter format but YAML
(TOML `+++`, JSON).

## Implements

- `specs/behaviors/markdown-to-doc.md` § Frontmatter and its construct row.
- `specs/commands/docs-write.md` — the two flags and the `frontmatter:` line.
- `specs/commands/drive-upload.md` — `--frontmatter strip|keep`.

## Approach

1. `bun add yaml` (eemeli/yaml, no dependencies), in its own commit.
2. `src/commands/docs/frontmatter.ts`:
   - `splitFrontmatter(source)` returns `{ data, body, keys }`, or `undefined` when there is
     no frontmatter. It throws `VALIDATION_ERROR` on unparseable YAML.
   - `frontmatterTable(data, keys?)` returns the Markdown of the `fit` table (with
     `headerRows: 0` handled below).

   Pure, unit-tested.
3. Converter:
   - `parseMarkdown` stays as it is;
   - the writers (`write.ts`) split first, then convert the body, or the table's Markdown
     followed by the body;
   - a table needs no header row: `TableBlock` gains a way to say so (`headerRows: 0`) for
     the table written from frontmatter, so its first key isn't bold-pinned as a header;
   - the writer skips the pin when `headerRows` is 0.
4. `write.ts` flags and the `frontmatter:` line in `render()`; help text.
5. `drive/upload.ts`: when the source MIME is Markdown and the result is a Doc, read the
   body into a string, split, and upload the remainder. Add `--frontmatter strip|keep`,
   refused when no Markdown is being converted.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit, `splitFrontmatter`:
  - a mapping, with `...` as the closing line and with a BOM;
  - not frontmatter: no closing line, a scalar, a list, comments only, an empty block, or
    not at the start;
  - a parse error is a `VALIDATION_ERROR`.
- [x] Unit, `frontmatterTable`:
  - nested keys dotted;
  - a scalar list joined with `<br>`;
  - a mapping list as `k: v` lines;
  - null empty, `|` escaped;
  - key selection and order, with a mapping key expanding;
  - an unknown key refused with the list.
- [x] Unit, writer: `headerRows: 0` is not pinned and not bold; flag validation
      (`--frontmatter-keys` without `table`; a bad mode).
- [x] Upload: `--frontmatter table` refused (unit). A non-Markdown upload (`a.txt`) and a
      non-converting one (`a.md` without `--convert`) are refused before uploading; that
      check is in the command path, so it was verified live (exit 2, nothing uploaded).
- [x] Live (scratch Doc, <chris@jarv.us>):
  - `docs create` from a file with frontmatter: no YAML in the Doc, and the response says
    `stripped (N keys)`;
  - `--frontmatter table --frontmatter-keys title,from`: the table, labels bold and fitted,
    no header row;
  - `drive upload --convert` of the same file: no YAML.

## Risks / unknowns

- **False positives.** A document that really opens with a rule, a `key: value` line and
  another rule is read as frontmatter. That is the ecosystem convention (GitHub renders it as
  a table), and `--frontmatter keep` is the way out, named in the response line.

## Notes

- **Found and fixed a #127 bug.** The ported span-table tokenizer, like
  `marked-extended-tables`, let header lines after the first go without a pipe. So `note: |`
  in YAML, then a few lines, then the closing `---` lexed as a one-column table. The same
  would happen to any prose line mentioning `|` above a setext `---`. Every header line now
  needs a pipe. Its own commit, with a test.
- Live, 2026-10-11 (<chris@jarv.us>, all trashed):
  - `docs create` stripped 5 keys and read back with no YAML;
  - `--frontmatter table --frontmatter-keys title,from,tags` gave 4 rows with bold labels,
    an 83pt fitted label column and no pinned header, and it read back as
    `<!-- cols: fit 1 -->` (the fix from #128 covering it);
  - `drive upload --convert` stripped 5 keys.
- A frontmatter table reads back with its first row above the delimiter, because GFM needs
  one. Re-writing it makes that row a pinned header, which is the same layout with one
  pinned row. This is expected and was left as is.
- Flags: one `--frontmatter strip|keep|table` mode flag plus `--frontmatter-keys`, not the
  issue's `--keep-frontmatter` / `--frontmatter-table[=keys]` (no `--flag=value` parsing).

## Follow-ups

- None.
