# Command: docs read

## Summary

Reads a native Google Doc and renders its body as GitHub-flavored markdown for an agent to consume in one pass. Because the rendered content is frequently *ported into another system* (a ticket, a repo, another doc), `docs read` is also the discovery funnel for the document's version history: every read carries the content's provenance (head revision + recent revisions) and points at the commands that fetch or compare past versions.

Operates only on native Google Docs. Uploaded `.docx`/etc. files route to `docs download` via a structured error (`NON_NATIVE_DOCUMENT`).

## Invocation

- `gws-axi docs read <documentId> [flags]`

## Flags

- `--tab <id>` — tab to render (omit for single-tab docs; required to pick one in a multi-tab doc).
- `--full` — don't truncate the rendered markdown (default cap: 8000 chars). `--out` implies `--full`.
- `--out <path>` — write the rendered markdown to a file (path or directory; a directory gets `<title>.md`). When set, the response carries a `saved` field instead of an inline `content` block.
- `--account <email>` — account override.

## Data Requirements

- Docs `documents.get` with `includeTabsContent: true` — the document, its `revisionId` (head), title, and tabs.
- Drive `revisions.list` (fields `revisions(id,modifiedTime,lastModifyingUser(displayName))`, newest first) for the recent-revisions block — **best-effort, additive** (see Display Rules). Covered by the existing `auth/drive` scope; no new scope.

## Display Rules

Output order: account header, `document{}` header, `tabs[N]` listing, recent-revisions block, then either inline `content` or `saved`.

### `document{}` header

`document{id,title,tab?,tab_count?,revision_id}`. `tab` when a single tab is rendered; `tab_count` when multi-tab and no `--tab`. `revision_id` is the **head** revision id and is first-class — it is the provenance anchor for whatever the agent does with the content.

### `tabs[N]{id,title,index,parent,active}`

Always shown when the doc has tabs; `active` is `✓` on the rendered tab. Multi-tab docs without `--tab` return only the tabs listing (no content) so the agent can pick one.

### Recent revisions (always shown)

A `revisions[N]{id,modified,author}` list of the **most recent 5** revisions, newest first — the same minimal schema as `drive revisions`. This is shown by default (not behind a flag) per [principles.md#provenance-by-default](../principles.md#provenance-by-default): an agent porting this content elsewhere must see which version it read without a second command.

- `id` — revision id, never truncated; the value passed to `docs download --revision` and `docs diff`.
- Native Docs revision lists are a sparse, session-level sample — this block carries the same completeness caveat as `drive revisions` (a `help[]` line), honoring [principles.md#surface-completeness-limits](../principles.md#surface-completeness-limits). It is the *recent* slice, not the full history; `drive revisions` (with `--limit`) is the complete-as-Drive-allows listing.
- **Best-effort:** the revisions fetch is a secondary call. If it fails (transient error, permission quirk), the read still returns the content with a `revisions: history unavailable` note and a `help[]` line pointing at `drive revisions` — a failed provenance fetch never fails the content read.

### Content

When a tab is rendered: either an inline `content` block of GitHub-flavored markdown (truncated to 8000 chars unless `--full`, with a `content_truncated`/`content_total_chars` marker and a save suggestion when capped), or a `saved` path + `content_total_chars` when `--out` is set. Images render as `[image]` placeholders.

## help[] suggestions

Built from the current result, always including the version-history funnel:

- View full version history: `gws-axi docs revisions <documentId>`.
- Fetch a past version's content: `gws-axi docs download <documentId> --revision <id>` (using a real id from the recent-revisions block).
- Compare two versions: `gws-axi docs diff <documentId> <revA> <revB>`.
- Existing suggestions retained: save/expand when truncated, image-placeholder note, higher-fidelity markdown via `docs download --as text/markdown`, `docs find`, `docs comments`.
- The native-revision completeness caveat line (see Recent revisions).

## Errors

- Not found / no access → `DOCUMENT_NOT_FOUND` with access-check suggestions.
- Non-native file → `NON_NATIVE_DOCUMENT`, redirecting to `docs download` and the convert-to-Google-Docs path.
- `--tab` not present → `TAB_NOT_FOUND` listing available tab ids.

## Principles

**Inherited:**

- [provenance-by-default](../principles.md#provenance-by-default) — recent revisions + head `revision_id` are shown on every read, not behind a flag, because the content is routinely ported into other systems and its source version must travel with it.
- [ids-are-first-class](../principles.md#ids-are-first-class) — `revision_id` and each listed revision `id` are never truncated and are echoed into `help[]` as ready-to-run `docs download --revision` / `docs diff` commands.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — the recent-revisions block is a sparse, recent slice of a sparse history; say so rather than imply exhaustiveness.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — `docs read` is the discovery funnel for version history; the help array names `revisions`, `download --revision`, and `diff` with real ids.
- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — neither the content read nor the revisions fetch provokes a write.
