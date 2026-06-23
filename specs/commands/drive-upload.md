# Command: drive upload

## Summary

Uploads the bytes of a **local file** into Google Drive — the first Drive *write* in the surface. By default it creates a new Drive file from the local path; with `--update <fileId>` it replaces the content of an existing file (a new revision); with `--convert` it asks Drive to convert the upload into the matching native Google format (Doc / Sheet / Slides) on the way in.

This is distinct from the planned `drive create` (which will make empty/native files from flags, no local source). `upload` is the verb an agent reaches for when it has bytes on disk to push up.

No new scope: the existing full `auth/drive` scope already authorizes `files.create` / `files.update` with media.

## Invocation

`gws-axi drive upload <local-path> [flags]`

- `<local-path>` — REQUIRED. Path to a readable local file. A missing path or a directory is a validation error (`LOCAL_FILE_NOT_FOUND` / `LOCAL_PATH_NOT_FILE`).

## Flags

- `--parent <folder-id>` — destination folder ID. Default: My Drive root (no `parents` set). Rejected together with `--update` (moving an existing file between folders needs `addParents`/`removeParents` — out of scope here; see below).
- `--name <name>` — name to give the file in Drive. Default: the basename of `<local-path>`. With `--update`, also renames the target.
- `--mime <type>` — override the source content type sent as the upload media type. Default: detected from the file extension; unknown extensions fall back to `application/octet-stream`.
- `--convert` — convert the upload into the matching native Google format server-side (sets the created file's target `mimeType`; the media is still sent as the source type and Drive converts). Supported source families map as in [Conversion table](#conversion-table); an unsupported source type is `UNSUPPORTED_CONVERSION`. Rejected together with `--update` (changing a file's type in place is out of scope).
- `--account <email>` — account override. REQUIRED when 2+ accounts are authenticated (this is a write — [principles.md#write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)).

## Data Requirements

- **Create**: Drive `files.create` with `requestBody: { name, parents?, mimeType? }` and `media: { mimeType: <sourceMime>, body: <read stream> }`, `fields` = the response field set below, `supportsAllDrives: true`. The `requestBody.mimeType` is set to the native target only under `--convert`; otherwise it is omitted so Drive stores the file as the uploaded type.
- **Update** (`--update <fileId>`): Drive `files.update` with `fileId`, `media: { mimeType, body }`, optional `requestBody: { name }`, same `fields`, `supportsAllDrives: true`. No `parents` change.
- Media body is a `fs.createReadStream(localPath)` so the file is streamed, not buffered into memory.
- Scope: existing `auth/drive` (full). No `ADDITIONAL_SCOPES` entry, no re-auth.

### Conversion table

`--convert` maps the detected/declared source MIME to a native Google target:

| Source family (examples)                                                                 | Native target                                  |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `.docx`/`.doc`, `.txt`, `.md`, `.rtf`, `.html` (word-processing & plain text)            | `application/vnd.google-apps.document`         |
| `.xlsx`/`.xls`, `.csv`, `.tsv` (spreadsheets & delimited)                                 | `application/vnd.google-apps.spreadsheet`      |
| `.pptx`/`.ppt` (presentations)                                                            | `application/vnd.google-apps.presentation`     |

A source type outside the table under `--convert` → `UNSUPPORTED_CONVERSION` (suggest dropping `--convert` to upload as-is).

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
- Open in browser: the `webViewLink`.

## Errors

- Missing/closed local path → `LOCAL_FILE_NOT_FOUND`; path is a directory → `LOCAL_PATH_NOT_FILE`. Both with a usage suggestion.
- `--parent` + `--update`, or `--convert` + `--update` → `VALIDATION_ERROR` (incompatible flags).
- `--convert` with an unsupported source type → `UNSUPPORTED_CONVERSION`.
- `--update <fileId>` where the file is absent / no access → `NOT_FOUND` re-wrapped to `FILE_NOT_FOUND` with an access-check suggestion (mirrors `drive get`).
- A bad `--parent` (folder absent / no access) surfaces the translated Google error (`NOT_FOUND` re-wrap) with an access-check suggestion.
- All Google failures pass through `translateGoogleError`; raw output never reaches stdout ([principles.md#no-dependency-noise-on-stdout](../principles.md#no-dependency-noise-on-stdout)).

## Dispatcher

The `drive` dispatcher gains a real handler for a new `{ name: "upload", mutation: true }` subcommand (the previously planned write stubs — `create`, `copy`, … — stay stubbed). Being `mutation: true`, it engages write-protection through `resolveAccount`.

## Out of scope (v1)

- **Resumable uploads** — v1 uses the library's simple/multipart streamed upload. Very large files (multi-GB) that benefit from resumable sessions are deferred.
- **Folder moves on update** — `--update` replaces content/name only; relocating via `addParents`/`removeParents` belongs with `drive move`.
- **In-place type conversion on update** — `--convert` + `--update` is rejected, not implemented.
- **Recursive directory upload** — one file per invocation; uploading a tree is deferred.
- **Idempotent create** — create-new intentionally always makes a new file; dedupe-by-name/path is not attempted. `--update` is the idempotent path and the disclosure in `help[]` points to it.

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account) — `mutation: true`; explicit `--account` required with 2+ accounts.
- [ids-are-first-class](../principles.md#ids-are-first-class) — the new fileId is the handoff to every downstream Drive/Docs command; never truncated, echoed into `help[]`.
- [minimal-default-schemas](../principles.md#minimal-default-schemas) — the response carries only the fields an agent needs to act on the new file.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — next steps reference the real fileId; the create-new path discloses non-idempotency and points at `--update`.
- [structured-errors-to-stdout](../principles.md#structured-errors-to-stdout) — local-FS and Google failures alike are `AxiError` on stdout.
- [byo-oauth-single-user](../principles.md#byo-oauth-single-user) — no new scope; rides the existing full `drive` grant.
