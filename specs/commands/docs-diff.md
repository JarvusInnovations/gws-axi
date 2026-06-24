# Command: docs diff

## Summary

Fetches the difference between two revisions of a native Google Doc directly — so an agent comparing versions does not have to download both revisions and diff them itself. Google exposes no diff API, so the command exports each revision to markdown server-side and computes a unified diff locally. The output is therefore a **diff of two markdown exports** (lossy relevance previews), not a faithful editorial diff — a fidelity limit the command states plainly.

Native Google Docs only. The revision content path is the same one `docs download --revision` already uses (`exportLinks`, markdown-default); `docs diff` reuses it for both sides.

## Invocation

- `gws-axi docs diff <fileId> <revA> [revB] [flags]`
- `revA` is the **from** revision; `revB` is the **to** revision. The diff shows the changes that transform `revA` into `revB`.
- `revB` is **optional**; when omitted it defaults to the **head** revision. So `docs diff <fileId> <rev>` answers "what changed between this old version and now?".
- Revision ids come from `gws-axi docs revisions <fileId>` (or the recent-revisions block in `docs read`).

## Flags

- `--full` — don't truncate the diff body (default cap: 8000 chars, matching `docs read`).
- `--out <path>` — write the full unified diff to a file (path or directory; a directory gets `<name>.r<revA>-r<revB>.diff`). Implies `--full`. Response carries `saved` instead of an inline `diff` block.
- `--account <email>` — account override.

## Data Requirements

- Drive `files.get` (fields `id,name,mimeType`) to label the file and reject non-native files.
- Drive `revisions.get` per side (fields `id,modifiedTime,lastModifyingUser(displayName),exportLinks`) for provenance + the markdown export URL.
- Authenticated GET of each revision's `exportLinks["text/markdown"]` (fallback `text/plain`), same fetch path as `docs download --revision`.
- Covered by the existing `auth/drive` scope; no new scope.

## Display Rules

Output order: account header, `document{}` header, `from{}`/`to{}` provenance blocks, `summary{}`, then either inline `diff` or `saved`.

```
document{id,name,type}
from{revision,modified,author}
to{revision,modified,author}
summary{lines_added,lines_removed,changed}
diff: |
  <unified diff of the two markdown exports>
```

- `from`/`to` carry each side's revision id (never truncated), `modifiedTime`, and `lastModifyingUser.displayName` — full provenance for both endpoints ([principles.md#provenance-by-default](../principles.md#provenance-by-default), [principles.md#ids-are-first-class](../principles.md#ids-are-first-class)).
- `summary.changed` is `false` when the two exports are byte-identical; the `diff` block is then the scalar `diff: no differences` (the markdown exports are identical — which does not prove the source revisions were identical, only their previews).
- The `diff` body is unified-diff format (git-style hunks), truncated to 8000 chars unless `--full`/`--out`, with a `diff_truncated`/`diff_total_chars` marker and a save suggestion when capped — mirroring `docs read`'s content truncation.
- **Argument order is respected, never reordered.** If the caller passes a newer revision as `revA` and an older as `revB`, the diff reads as a reversal; the command does not silently sort by time.

### Fidelity disclosure (required)

A `help[]`/`note` line states the diff compares **markdown exports**, which are lossy: structural/formatting changes that markdown can't represent (and Google-specific constructs) may be invisible, and native revision history is itself a sparse sample. Honors [principles.md#surface-completeness-limits](../principles.md#surface-completeness-limits).

## help[] suggestions

- Fetch either side's full content: `gws-axi docs download <fileId> --revision <revA>` / `--revision <revB>`.
- List all revisions: `gws-axi docs revisions <fileId>`.
- Save the full diff: `gws-axi docs diff <fileId> <revA> <revB> --out <path>` (when truncated).
- The markdown-export fidelity caveat line.

## Errors

- Non-native file → `NON_NATIVE_DOCUMENT` (a byte diff of binary revisions isn't meaningful; redirect to `drive revisions --full` for size/mime comparison).
- Bad `revA`/`revB` → `REVISION_NOT_FOUND`, suggesting `docs revisions <fileId>` to list valid ids.
- A revision with no markdown/plain `exportLinks` → `EXPORT_FORMAT_REQUIRED` listing available keys (same as `docs download --revision`).
- Missing `revA` argument → `VALIDATION_ERROR` with usage.

## Out of scope (state in help/notes, do not build)

- Word-level / inline diffs, HTML side-by-side rendering, or three-way merges — unified text diff only.
- Diffing binary (uploaded) files.
- A faithful editorial diff reconstructing formatting changes — impossible from markdown exports.

## Principles

**Inherited:**

- [provenance-by-default](../principles.md#provenance-by-default) — both endpoints' revision identity, time, and author are first-class in the output; a diff's whole purpose is traceable comparison.
- [ids-are-first-class](../principles.md#ids-are-first-class) — `from.revision`/`to.revision` are never truncated and are echoed into download/diff suggestions.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — the diff is between lossy markdown exports of a sparse revision history; the output says so rather than implying a faithful editorial diff.
- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — exporting two revisions provokes no write on the file.

**Local:**

- **A diff is a relevance tool, not a forensic one.** Like revision content download ([drive-revisions.md](drive-revisions.md) markdown-default), `docs diff` exists so an agent can judge *what changed* well enough to decide a next step — not to produce a legally faithful change record. This justifies diffing markdown exports (lossy, readable) over attempting a structural diff (faithful, unreadable, and infeasible from the public API). Mirrors and shares the rationale of drive-revisions' markdown-default principle; promote to `principles.md` if a third command echoes it.
