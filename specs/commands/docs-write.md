# Command group: docs create, docs write, docs append

## Summary

The Markdown writers for Google Docs. Each takes Markdown from a local file, stdin, or
`--content`, converts it through the gws-axi converter
([markdown-to-doc](../behaviors/markdown-to-doc.md)), and writes it into **one tab**:

- **`docs create`** makes a new Doc, optionally with initial content.
- **`docs write`** replaces the content of one tab, or of a new tab it adds.
- **`docs append`** adds content at the end of one tab.

These are the write side of `docs read`: read a tab as Markdown, edit it, write it back —
without touching the document's other tabs, which is what `drive upload --update` cannot do.

No new scope: the existing `documents` grant authorizes `documents.create` and `batchUpdate`;
`drive` covers placing a new Doc in a folder.

## Invocation

```
gws-axi docs create --title <title> [<file> | - | --content <markdown>] [--parent <folder-id>]
gws-axi docs write  <documentId> (<file> | - | --content <markdown>) [--tab <id> | --new-tab <title> [placement] [--emoji <emoji>]]
gws-axi docs append <documentId> (<file> | - | --content <markdown>) [--tab <id>]
```

**Content source** — the same rule as `drive upload`: a readable local file, `-` for stdin, or
`--content <string>`, exactly one. For `create` the source is optional (no source → an empty
Doc). Missing path → `LOCAL_FILE_NOT_FOUND`; a directory → `LOCAL_PATH_NOT_FILE`; none or more
than one → `VALIDATION_ERROR`. An empty body for `write` is allowed (it empties the tab); for
`append` it is a `VALIDATION_ERROR`.

**Choosing the tab** (`write`, `append`):

- `--tab <id>` — the tab id as `docs read` lists it (`t.0`, `t.abc…`). Never a title: titles
  are not unique.
- Omitted on a single-tab Doc → that tab.
- Omitted on a multi-tab Doc → `TAB_REQUIRED`, listing `tabs[N]{id,title,index}` so the next
  call can name one. Nothing is written. There is no "replace every tab" mode here; that is
  `drive upload --update --replace-all-tabs`, by name.
- `--new-tab <title>` (`write` only) — add a tab with that title and write into it. Cannot be
  combined with `--tab`. Re-running adds another tab with the same title; the response says so.
  Where it goes is the next section.

**Placing a new tab** (`write` with `--new-tab`):

The placement flags are the ones `docs tabs update` takes ([docs-tabs.md](docs-tabs.md) §
`docs tabs update`), with the same meaning — one vocabulary for "where does this tab go":

- `--first` / `--last` (default `last`, the pre-#101 behavior) — within the top level, or
  within `--under <tabId>`.
- `--before <tabId>` / `--after <tabId>` — adjacent to that tab, in its parent.
- `--under <tabId>` — as a child of that tab (last child unless `--first`).
- `--emoji <emoji>` — the tab's icon.

At most one of `--first`/`--last`/`--before`/`--after`; `--under` only with `--first`/`--last`
or alone. An anchor that names no tab is `TAB_NOT_FOUND` before anything is written. Any of
these flags **without `--new-tab`** is a `VALIDATION_ERROR` whose hint says they place a new
tab and names `docs tabs update <id> <tabId>` for moving an existing one — never silently
dropped ([fail-loud-on-unknown-flags](../principles.md#fail-loud-on-unknown-flags)). The
regenerate-per-round pattern from #101 is one call:
`docs write <id> ./round-3.md --new-tab "Round 3" --first`.

## Flags

- `--content <markdown>` — inline body (see Content source).
- `--tab <id>`, `--new-tab <title>` — see Choosing the tab.
- `--first`, `--last`, `--before <tabId>`, `--after <tabId>`, `--under <tabId>`, `--emoji <emoji>`
  — `write` with `--new-tab` only; see Placing a new tab.
- `--title <title>` — `create` only, REQUIRED.
- `--parent <folder-id>` — `create` only; the folder to create in. Default: My Drive root.
- `--account <email>` — REQUIRED when 2+ accounts are authenticated
  ([write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)).

## Data Requirements

- `write` / `append`: Docs `documents.get` with `includeTabsContent: true` (tab properties and
  each tab's body end index, plus `revisionId`), then one or two `documents.batchUpdate` calls
  carrying `writeControl.requiredRevisionId` from that read. `write` clears the tab's body from
  index 1 to its end − 1 and inserts; `append` inserts at the end of the body. `--new-tab` adds
  the tab first (`addDocumentTab` with `title`, and `index`/`parentTabId`/`iconEmoji` from the
  placement flags), in the same batch.
- `create`: Drive `files.create` with the Doc MIME type and optional `parents` (so `--parent`
  works, which `documents.create` cannot do), then the `write` path into the Doc's only tab.
- Conversion produces requests scoped to the target `tabId`; see the behavior spec for the
  mapping and atomicity.

## Display Rules

Header: `action: created | written | appended`, then `account` (+ `account_source` per the
standard rules).

Body: `document{id,title,tab,tab_title,revision_id,web_view_link}`

- `id` — the document id, first-class.
- `tab`, `tab_title` — the tab written. For `create` the Doc's single tab.
- `tab_index`, `tab_parent` — with `--new-tab`: where it landed (index within the parent;
  parent empty at the top level).
- `revision_id` — the **head revision after the write**, from the batch reply: the provenance
  anchor for `docs diff` ([provenance-by-default](../principles.md#provenance-by-default)).
- `web_view_link` — the Doc URL.

Then `content{chars,blocks}` — what was written: characters inserted and top-level blocks
(paragraphs, headings, list items, tables, …) — followed by `lossy[N]{construct,count,handling}`
or `lossy: none` per the behavior spec.

With `--new-tab`, the `tabs[N]{id,title,index,parent,emoji}` listing from `docs tabs` follows,
so the placement is confirmed without a read ([docs-tabs.md](docs-tabs.md) § Principles, *a
move shows the order it produced*).

### help[] suggestions

- Verify: `docs read <id> --tab <tab>`.
- Compare with the previous version: `docs diff <id> <previous revision>` using the revision
  read before the write (`write`, `append`).
- `drive share <id> --with <email>` after `create`.
- When `--new-tab` was used: a note that re-running adds another tab, the `--tab <id>` form
  to write to this one, and `docs tabs update <id> <tab>` for moving, renaming or marking it.
- When `lossy` is non-empty: a line naming the heaviest loss and that the Doc was still written.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | Source rules broken; `--tab` with `--new-tab`; `--new-tab` on `append`; `--title`/`--parent` outside `create`; empty body on `append`; a placement or `--emoji` flag without `--new-tab` (hint names `docs tabs update`); conflicting placement flags |
| `LOCAL_FILE_NOT_FOUND`, `LOCAL_PATH_NOT_FILE` | As `drive upload` |
| `DOCUMENT_NOT_FOUND` | Absent or no access, as `docs read` |
| `NON_NATIVE_DOCUMENT` | The id is not a native Doc (an uploaded `.docx`), redirecting to `drive upload --convert` |
| `TAB_REQUIRED` | Multi-tab Doc, no `--tab`; carries the tab listing |
| `TAB_NOT_FOUND` | `--tab`, or a `--before`/`--after`/`--under` anchor, names no tab in this Doc; carries the tab listing |
| `INVALID_EMOJI` | Google refused the `--emoji` value; no tab was added |
| `IMAGE_NOT_FETCHABLE` | A non-`http(s)` image source, or a URL Google refused; nothing written |
| `DOCUMENT_CHANGED` | The Doc's revision moved between the read and the write; nothing written. Suggests re-running |
| `WRITE_INCOMPLETE` | The first batch applied but the table/footnote fill did not; names the revision before the write for `docs diff` |
| `FILE_NOT_FOUND` | `--parent` folder absent or inaccessible (`create`) |

All Google failures pass through `translateGoogleError`.

## Dispatcher

`create` and `write` are new `{ mutation: true }` entries; the scaffolded `append` gains its
handler and drops `--text` for the shared source rule. The remaining Docs write stubs'
`instead[]` lines point here instead of at `drive upload --update`, since `docs write` is the
tab-safe replacement path.

## Out of scope (v1)

- **Positional edits** (`insert-text --at`, `delete-range`, `edit-cell`): index-addressed
  editing stays stubbed; `write` and `append` cover the read→edit→write loop without indices.
- **Checked tasks** — the API has no way to set them; disclosed, not worked around.
- **Local images** — would need a Drive upload per image; deferred.
- **Deleting, renaming, reordering tabs** — [docs-tabs.md](docs-tabs.md).

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
- [provenance-by-default](../principles.md#provenance-by-default) — the post-write revision is
  in the response; the pre-write one is in `help[]` as a ready `docs diff`.
- [ids-are-first-class](../principles.md#ids-are-first-class) — tabs are addressed by id, as
  `docs read` lists them; never by title.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — `lossy[]`.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions)

**Local:**

- **One tab per write, never a collapse.** A `docs` writer touches exactly the tab it names.
  The only command that can flatten a Doc is `drive upload --update`, and it says so by flag.

  > **Why:** the reason these commands exist is that the import path destroys tabs. A writer
  > that could do the same by omission would re-create the hazard under a new name.
