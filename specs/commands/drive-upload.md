# Command: drive upload

## Summary

Uploads content into Google Drive — the first Drive *write* in the surface. The content comes from one of three sources: a **local file** (the default), **stdin** (`-` as the path), or an inline **`--content` string** (so an agent can push generated content without staging a temp file). By default it creates a new Drive file; with `--update <fileId>` it replaces the content of an existing file (a new revision); with `--convert` it asks Drive to convert the upload into the matching native Google format (Doc / Sheet / Slides) on the way in.

This is distinct from the planned `drive create` (which will make empty/native files from flags, no local source). `upload` is the verb an agent reaches for when it has bytes on disk to push up.

No new scope: the existing full `auth/drive` scope already authorizes `files.create` / `files.update` with media.

## Invocation

`gws-axi drive upload <source> [flags]`

Exactly one content source is required:

- `<local-path>` — a readable local file (the default). Missing path → `LOCAL_FILE_NOT_FOUND`; a directory → `LOCAL_PATH_NOT_FILE`.
- `-` as the positional → read the upload body from **stdin**.
- `--content <string>` → inline content, no file touched.

Zero sources, or more than one (e.g. a real path *and* `--content`, or `-` *and* `--content`), is a `VALIDATION_ERROR`. For stdin and `--content` there is no filename to infer from, so `--name` is **required** (see Flags).

## Flags

- `--content <string>` — inline upload body, as an alternative to a local path or stdin. Mutually exclusive with a local path / `-`.
- `--parent <folder-id>` — destination folder ID. Default: My Drive root (no `parents` set). Rejected together with `--update` (moving an existing file between folders needs `addParents`/`removeParents` — out of scope here; see below).
- `--name <name>` — name to give the file in Drive. Default: the basename of `<local-path>`. **Required** when the source is stdin (`-`) or `--content`, since there's no filename to infer. With `--update`, also renames the target.
- `--mime <type>` — override the source content type sent as the upload media type. Default: detected from the file extension; for stdin / `--content` (no path) detected from the **`--name` extension** instead; unknown extensions fall back to `application/octet-stream`.
- `--convert` — convert the upload into the matching native Google format server-side. On **create**, sets the new file's target `mimeType` (media is sent as the source type and Drive converts). On **`--update`**, permitted only when the target file is already the native type the source converts to (see [`--convert` with `--update`](#convert-with-update)). Supported source families map as in [Conversion table](#conversion-table); an unsupported source type is `UNSUPPORTED_CONVERSION`.
- `--replace-all-tabs` — acknowledge that updating a **multi-tab Doc** or **multi-sheet Spreadsheet** will collapse it to a single tab/sheet, and proceed (see [Multi-tab targets](#multi-tab-targets)). Only meaningful with `--update`; passing it otherwise is a `VALIDATION_ERROR`.
- `--account <email>` — account override. REQUIRED when 2+ accounts are authenticated (this is a write — [principles.md#write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)).

## Data Requirements

- **Create**: Drive `files.create` with `requestBody: { name, parents?, mimeType? }` and `media: { mimeType: <sourceMime>, body: <body> }`, `fields` = the response field set below, `supportsAllDrives: true`. The `requestBody.mimeType` is set to the native target only under `--convert`; otherwise it is omitted so Drive stores the file as the uploaded type.
- **Update** (`--update <fileId>`): Drive `files.update` with `fileId`, `media: { mimeType, body }`, optional `requestBody: { name }`, same `fields`, `supportsAllDrives: true`. No `parents` change. A `files.get(fileId, fields: id,mimeType)` **always** precedes the update: it validates the target's type under `--convert` (see below) and identifies container targets for the [tab preflight](#multi-tab-targets). When the target is a Doc or Spreadsheet, a second call — Docs `documents.get` (`includeTabsContent: true`, `tabProperties`/`childTabs` mask) or Sheets `spreadsheets.get` (`sheets.properties` mask) — counts its sub-surfaces without fetching content.
- **Media body** by source: a local file is a `fs.createReadStream(path)` (streamed, not buffered); stdin is `process.stdin`; `--content` is the string itself. For stdin/`--content` the body has no extension, so the name+mime defaults derive from `--name`.
- Scope: existing `auth/drive` (full). No `ADDITIONAL_SCOPES` entry, no re-auth.

### Conversion table

`--convert` maps the detected/declared source MIME to a native Google target:

| Source family (examples)                                                                 | Native target                                  |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `.docx`/`.doc`, `.txt`, `.md`, `.rtf`, `.html` (word-processing & plain text)            | `application/vnd.google-apps.document`         |
| `.xlsx`/`.xls`, `.csv`, `.tsv` (spreadsheets & delimited)                                 | `application/vnd.google-apps.spreadsheet`      |
| `.pptx`/`.ppt` (presentations)                                                            | `application/vnd.google-apps.presentation`     |

A source type outside the table under `--convert` → `UNSUPPORTED_CONVERSION` (suggest dropping `--convert` to upload as-is).

### `--convert` with `--update`

Replacing an existing native Doc/Sheet/Slides' content from a convertible source (e.g. edited markdown → the same Doc, as a new revision) — the write side of the read→edit→write-back loop. Permitted **only when the target is already the native type the source converts to**:

1. The source must convert to a native target (`googleConversionTarget(sourceMime)`), else `UNSUPPORTED_CONVERSION` (as on create).
2. A `files.get(fileId, fields: id,mimeType)` reads the target's current type.
3. If the target is **not** a native Google file → `VALIDATION_ERROR` (can't convert a binary file's type in place — that's a new-file operation; out of scope).
4. If the target's native type **differs** from the source's conversion target (e.g. markdown source → Doc, but the target file is a Sheet) → `VALIDATION_ERROR` naming both types.
5. Otherwise: `files.update` with `media: { mimeType: <sourceMime>, body }` and `requestBody.mimeType` set to the (matching) native target — Drive converts the uploaded media into the existing native file as a **new revision** (visible in `drive revisions` / `docs diff`). Optional `requestBody.name` renames as usual.

`--convert` + `--update` is otherwise unconstrained (the previous blanket rejection is lifted). `--parent` + `--update` remains rejected (folder moves are out of scope).

### Multi-tab targets

Two native types split their content across named sub-surfaces, and Drive's import flattens both: a Doc always comes back **single-tab**, a Spreadsheet **single-sheet**. Replacing the content of a Doc with multiple tabs, or a Spreadsheet with multiple sheets, therefore destroys every one but the first. Both are verified live, and both happen **with or without `--convert`** — Drive converts the media implicitly when the target is native — so the rule attaches to `--update` against these types, not to `--convert`.

An agent following the documented round trip (`docs read --tab X` / `sheets read --tab X` → edit → write back) would otherwise discard the tabs it never read, with nothing in the output saying so. Therefore:

1. On `--update`, when the target's `mimeType` is one of the container types below, count its sub-surfaces.

   | mimeType | Counted via | Sub-surface | Inspect with |
   | --- | --- | --- | --- |
   | `…google-apps.document` | Docs `documents.get` (`tabProperties`/`childTabs` mask) | tabs, incl. nested child tabs | `docs read <id>` |
   | `…google-apps.spreadsheet` | Sheets `spreadsheets.get` (`sheets.properties` mask) | sheets | `sheets read <id>` |

2. More than one, and no `--replace-all-tabs` → `MULTI_TAB_TARGET`. The file is **not** modified. The error names the count and the titles at risk, and suggests both `--replace-all-tabs` and the type's read command.
3. With `--replace-all-tabs`, the update proceeds and the success output discloses the collapse in `help[]` ([principles.md#surface-completeness-limits](../principles.md#surface-completeness-limits)), pointing at `drive revisions <id>` for the prior version.

One flag and one error code cover both, because it is one hazard: a spreadsheet's sheets *are* its tabs, the framing `sheets read` already uses. Wording adapts per type ("3 tabs"/"3 sheets") so the message names what the caller actually has.

The collapse is recoverable in content but not in structure — the pre-update revision still holds the prior version, while tab/sheet boundaries survive only in the editor's own version history. The guard's job is to make the trade explicit, not to prevent it.

Single-tab Docs, single-sheet Spreadsheets, and non-container targets (Slides, binaries) are unaffected — no extra friction on the common case.

## Display Rules

Header object (in order): `action: created` (or `updated` under `--update`), then `account` (+ `account_source` per the standard header rules — but writes require explicit `--account` with 2+ accounts, so `account_source: default` only appears with exactly 1 account).

Body: `file{id,name,mime_type,size_bytes,parents,web_view_link}`

- `id` — the Drive fileId, first-class and never truncated ([principles.md#ids-are-first-class](../principles.md#ids-are-first-class)); it is the handoff to `drive get` / `docs download` / `drive permissions`.
- `name` — the stored name.
- `mime_type` — the **stored** Drive mime type from the API response (the native type when `--convert` took effect, else the source type).
- `size_bytes` — from the response when present (omitted for native-converted files, which report no `size`).
- `parents` — comma-joined parent folder IDs (empty for root).
- `web_view_link` — `webViewLink` when present.

### help[] suggestions

- `drive get <id>` for full metadata; `drive permissions <id>` for sharing.
- When converted: `docs read <id>` (for a Doc) / `docs download <id>` to fetch it back.
- When **created** (not `--update`): a one-line note that re-running creates another copy (Drive allows duplicate names) and that `--update <id>` replaces this file's content instead — disclosing the non-idempotency of create-new.
- When an update collapsed a multi-tab Doc under `--replace-all-tabs`: a line stating how many tabs were replaced by the single imported tab, and that the prior version is in `drive revisions <id>`.
- Open in browser: the `webViewLink`.

## Errors

- No content source, or more than one (`<path>` / `-` / `--content` combined) → `VALIDATION_ERROR`.
- stdin or `--content` without `--name` → `VALIDATION_ERROR` (no filename to infer).
- Missing/closed local path → `LOCAL_FILE_NOT_FOUND`; path is a directory → `LOCAL_PATH_NOT_FILE`. Both with a usage suggestion.
- `--parent` + `--update` → `VALIDATION_ERROR` (incompatible flags).
- `--convert` + `--update` against a non-native target, or a target whose native type doesn't match the source's conversion target → `VALIDATION_ERROR` (see [`--convert` with `--update`](#convert-with-update)).
- `--update` against a Doc with 2+ tabs, or a Spreadsheet with 2+ sheets, without `--replace-all-tabs` → `MULTI_TAB_TARGET` (see [Multi-tab targets](#multi-tab-targets)); nothing is written.
- `--replace-all-tabs` without `--update` → `VALIDATION_ERROR` (nothing to replace on create).
- `--convert` with an unsupported source type → `UNSUPPORTED_CONVERSION`.
- `--update <fileId>` where the file is absent / no access → `NOT_FOUND` re-wrapped to `FILE_NOT_FOUND` with an access-check suggestion (mirrors `drive get`).
- A bad `--parent` (folder absent / no access) surfaces the translated Google error (`NOT_FOUND` re-wrap) with an access-check suggestion.
- All Google failures pass through `translateGoogleError`; raw output never reaches stdout ([principles.md#no-dependency-noise-on-stdout](../principles.md#no-dependency-noise-on-stdout)).

## Dispatcher

The `drive` dispatcher gains a real handler for a new `{ name: "upload", mutation: true }` subcommand (the previously planned write stubs — `create`, `copy`, … — stay stubbed). Being `mutation: true`, it engages write-protection through `resolveAccount`.

## Out of scope (v1)

- **Resumable uploads** — v1 uses the library's simple/multipart streamed upload. Very large files (multi-GB) that benefit from resumable sessions are deferred.
- **Folder moves on update** — `--update` replaces content/name only; relocating via `addParents`/`removeParents` belongs with `drive move`.
- **Changing a file's *type* on update** — `--convert` + `--update` only re-imports a convertible source into a target that's *already* the matching native type (a new revision). Turning a binary file into a native one (or one native type into another) in place is not supported.
- **Writing to a specific tab or sheet, or adding one** — Drive media replaces the file wholesale; per-tab writes need Docs `batchUpdate` and per-sheet writes need Sheets `values.update`, both belonging with the deferred `docs`/`sheets` write surfaces. `--replace-all-tabs` is a disclosure, not a tab-aware write.
- **Recursive directory upload** — one file per invocation; uploading a tree is deferred.
- **Resumable / large stdin** — stdin and `--content` use the same simple streamed upload as files; very large piped inputs that need resumable sessions are deferred.
- **Idempotent create** — create-new intentionally always makes a new file; dedupe-by-name/path is not attempted. `--update` is the idempotent path and the disclosure in `help[]` points to it.

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account) — `mutation: true`; explicit `--account` required with 2+ accounts.
- [ids-are-first-class](../principles.md#ids-are-first-class) — the new fileId is the handoff to every downstream Drive/Docs command; never truncated, echoed into `help[]`.
- [minimal-default-schemas](../principles.md#minimal-default-schemas) — the response carries only the fields an agent needs to act on the new file.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — next steps reference the real fileId; the create-new path discloses non-idempotency and points at `--update`.
- [structured-errors-to-stdout](../principles.md#structured-errors-to-stdout) — local-FS and Google failures alike are `AxiError` on stdout.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — a multi-tab collapse is never silent: it either blocks with `MULTI_TAB_TARGET` or is disclosed in `help[]` after the opt-in.
- [byo-oauth-single-user](../principles.md#byo-oauth-single-user) — no new scope; rides the existing full `drive` grant.
