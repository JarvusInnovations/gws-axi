# Command: drive revisions

## Summary

Lists the revision history of any Drive file, and downloads the content of a specific historical revision. The revision concept is Drive-wide (every file type has revisions), so the canonical command lives under `drive`. A thin `docs revisions` alias points at the same implementation for discoverability, since "version history" is a Docs-shaped mental model.

Revision **content download** is an extension of the existing `docs download` command (which is already Drive-backed and works on any file), via a new `--revision` flag — not a separate fetch path.

## Invocation

- `gws-axi drive revisions <fileId> [flags]` — list revisions.
- `gws-axi docs revisions <fileId> [flags]` — alias; identical behavior.
- `gws-axi docs download <fileId> --revision <revisionId> [flags]` — download one revision's content.

## A. `drive revisions <fileId>` (list)

### Flags

- `--full` — include `size_bytes`, `mime_type`, `kept`, `published` columns (empty where the field doesn't apply to the file's type).
- `--limit <n>` — max revisions to return (default 100). Internally paginates `revisions.list` on `nextPageToken` to gather all, then applies the limit after sorting.
- `--account <email>` — account override.

### Data Requirements

- Drive `files.get` (fields `id,name,mimeType`) to label the file and classify native vs binary.
- Drive `revisions.list` paginated, fields `nextPageToken,revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress),keepForever,published,mimeType,size)`.
- Covered by the existing `auth/drive` scope. No new scope.

### Display Rules

Header object:

```
document{id,name,type,revision_count,head_revision}
```

- `type` — `native` (mimeType starts `application/vnd.google-apps.`) or `binary`.
- `head_revision` — the id of the newest revision (by `modifiedTime`).

List (default minimal schema), **newest first**:

```
revisions[N]{id,modified,author}
```

- `id` — revision id, first-class and never truncated; it's the value passed to `docs download --revision`.
- `modified` — `modifiedTime`.
- `author` — `lastModifyingUser.displayName`, or empty string when absent (anonymous/system edits).

`--full` extends the schema to `{id,modified,author,size_bytes,mime_type,kept,published}`. `size_bytes`/`kept` populate for binary files only; `published` for native only — empty cells otherwise.

**Ordering is computed by the command** (sort by `modifiedTime` descending), not assumed from API order — the Drive API does not document revision ordering.

### Completeness disclosure (required)

For **native** files, append a `note` field and a `help[]` line stating the list may be incomplete: the Drive API can omit older revisions for frequently-edited Google Docs/Sheets/Slides, and the editor's own version-history UI may show more. This honors [principles.md#surface-completeness-limits](../principles.md#surface-completeness-limits). Binary files do not get this note (their revision list is complete up to the purge rule below).

### Empty / single-revision

Every file has ≥1 revision, so the empty-list case is effectively unreachable, but the command still routes through the canonical empty shape for consistency.

### help[] suggestions

- Download a listed revision: `gws-axi docs download <fileId> --revision <id>`.
- For native files, the completeness caveat line.
- For binary files where older revisions show no downloadable content, note the keep-forever purge (below).

## B. `docs download <fileId> --revision <revisionId>` (content)

Extends the existing `docs download`. Without `--revision`, behavior is unchanged (head download). With `--revision`:

### Flags added

- `--revision <id>` — the revision to download (from `drive revisions`).
- Existing `--as <mime>` and `--out <path>` still apply.

### Display Rules / behavior

- **Native file + `--revision`**: fetch that revision's content via the revision's `exportLinks` map (an authenticated GET to the chosen format's URL). **Default format is `text/markdown`** ([project: exploration tool — markdown default for agent reading]). The command reads the revision's `exportLinks`, looks up the key for the requested/default mime, and if absent falls back: requested `--as` missing → `EXPORT_FORMAT_REQUIRED` listing the available `exportLinks` keys; default markdown missing → fall back to `text/plain`, else first available, noting the substitution in `help[]`.
- **Binary file + `--revision`**: fetch via `revisions.get({ fileId, revisionId, alt: "media" })`. `--as` is invalid for binary (same as head download) → `VALIDATION_ERROR`. If the revision's content is unavailable because it was purged (binary revisions are auto-purged ~30 days after newer content unless `keepForever`), report `REVISION_CONTENT_UNAVAILABLE` with a note that only pinned revisions retain old content — do not fail opaquely.
- Output mirrors head `download`: a `file{...}` block gaining `revision` and `revision_modified`, plus the `saved:` path when written. Default filename when `--out` omitted: `<base>.r<revisionId><ext>` so a revision download never clobbers a head download.

### Errors

- Bad `revisionId` → Drive 404 re-wrapped as `REVISION_NOT_FOUND`, suggesting `drive revisions <fileId>` to list valid ids.
- Native mime not in `exportLinks` → `EXPORT_FORMAT_REQUIRED` listing available keys.
- Purged binary content → `REVISION_CONTENT_UNAVAILABLE`.

## Out of scope (state in help/notes, do not build)

- The full per-edit timeline shown in the Docs version-history sidebar — not exposed by any public API.
- User-assigned version *names* — not on the Drive revision resource.
- Content integrity hashes for native files — Drive provides none (md5 is binary-only); this tool does not synthesize forensic hashes (see [project: exploration, not forensics]).
- Diffs between revisions — now a separate command, [docs diff](docs-diff.md) (native Docs only; diffs markdown exports). Not handled here.

## Principles

**Inherited:**

- [ids-are-first-class](../principles.md#ids-are-first-class) — fileId + revisionId are the product of this command; they hand off to `docs download --revision` and to downstream tools. Never truncate; always echo into `help[]`.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — native revision lists may silently omit history; say so rather than imply exhaustiveness.
- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — listing and downloading revisions must not provoke a new revision or access-write on the file.
- [minimal-default-schemas](../principles.md#minimal-default-schemas) — `{id,modified,author}` by default; `--full` for the rest.

**Local:**

- **Markdown is the default revision content format.** This is a discovery/exploration tool: an agent downloads a revision to judge relevance, not to retain a faithful artifact. Markdown is the most readable native export and is the right default even though it's lossy; fidelity-sensitive capture happens with other tooling. (Rules out defaulting to `.docx`/PDF the way head `download` does.)
