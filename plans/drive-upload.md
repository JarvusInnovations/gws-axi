---
status: done
depends: []
specs:
  - specs/commands/drive-upload.md
  - specs/principles.md
  - specs/api/conventions.md
issues: []
---

# Plan: Drive upload (first Drive write)

## Scope

Add `gws-axi drive upload <local-path>` — the first Drive write — pushing local
file bytes into Drive. In scope:

1. **Create-new** (default): stream a local file to `files.create`, optional
   `--parent`, `--name`, `--mime`.
2. **`--convert`**: convert supported source types to native Google Doc/Sheet/Slides
   on upload via the created file's target `mimeType`.
3. **`--update <fileId>`**: replace an existing file's content (new revision) via
   `files.update` with media; optional `--name` rename.

Out of scope (deferred, see spec): resumable uploads, folder moves on update,
`--convert` + `--update`, recursive directory upload, idempotent create. The other
Drive write stubs (`create`, `copy`, `move`, `rename`, `delete`, `mkdir`) stay
`NOT_IMPLEMENTED`.

## Implements

- **specs/commands/drive-upload.md** — the full command: invocation, all four flags
  (`--parent`/`--name`/`--mime`/`--convert`/`--update`), the conversion table, the
  `file{...}` response shape, `action: created|updated`, error codes, and the
  `mutation: true` dispatcher entry. No new scope (existing full `auth/drive`).
- **specs/principles.md / api/conventions.md** — honors write-protection (explicit
  `--account` with 2+ accounts), ids-first-class (new fileId untruncated + in `help[]`),
  minimal-default-schemas, structured-errors-to-stdout, contextual-help (non-idempotency
  disclosure pointing at `--update`).

## Approach

1. **`src/util/mime-types.ts`** (new, + test) — `detectMimeType(path)` mapping common
   extensions → MIME (fallback `application/octet-stream`), and
   `googleConversionTarget(mime)` mapping a source MIME to a native Google target or
   `null`. Pure functions, no FS/network — unit-tested in isolation.

2. **`src/commands/drive/upload.ts`** (new, + test) — `UPLOAD_HELP` constant +
   `driveUploadCommand(account, args)`:
   - Hand-rolled flag parser (positional `<local-path>` + the five flags), matching the
     style of `drive/get.ts` and `calendar/create.ts`.
   - Validate incompatible combos (`--parent`+`--update`, `--convert`+`--update`) →
     `VALIDATION_ERROR`.
   - `stat` the local path: missing → `LOCAL_FILE_NOT_FOUND`; directory →
     `LOCAL_PATH_NOT_FILE`.
   - Resolve name (`--name` or `basename`), source mime (`--mime` or `detectMimeType`).
   - Under `--convert`: `googleConversionTarget(sourceMime)`; `null` →
     `UNSUPPORTED_CONVERSION`.
   - Create: `files.create({ requestBody: { name, parents?, mimeType? }, media:
     { mimeType, body: createReadStream(path) }, fields, supportsAllDrives: true })`.
   - Update: `files.update({ fileId, requestBody: { name? }, media, fields,
     supportsAllDrives: true })`.
   - Wrap Google errors via `translateGoogleError`; re-wrap `NOT_FOUND` →
     `FILE_NOT_FOUND` for `--update`/`--parent` access cases (mirrors `drive get`).
   - Render: `action` + `account` header, `file{id,name,mime_type,size_bytes,parents,
     web_view_link}`, `renderHelp([...])`.

3. **`src/commands/drive.ts`** — replace the `upload`-less surface: add a real
   `{ name: "upload", mutation: true, help: UPLOAD_HELP, handler: driveUploadCommand }`
   entry (before the still-stubbed writes); import the handler + help. The dispatcher's
   write-protection and `--help` routing already flow through generically.

4. **CLAUDE.md** — flip Drive writes status: `upload` ✅, remaining writes still 🚧.

Each step: implement → `bun run build` → `bun run test`.

## Validation

- [x] `drive upload <file>` creates a new Drive file and returns `action: created` +
      `file{id,...}` with an untruncated id; `--parent`/`--name`/`--mime` honored.
      _(verified live: `gws-upload-test.txt` → `text/plain`, 32 bytes, real fileId + link)_
- [x] `--convert` on a `.docx`/`.csv`/`.pptx` yields a native Doc/Sheet/Slides
      (`mime_type: application/vnd.google-apps.*`); unsupported source →
      `UNSUPPORTED_CONVERSION`. _(verified live: CSV → native Sheet; `image/png` +
      `--convert` → `UNSUPPORTED_CONVERSION`)_
- [x] `--update <fileId>` replaces content (new revision), returns `action: updated`;
      `--name` renames; bad id → `FILE_NOT_FOUND`. _(verified live: replaced content
      round-tripped via `docs download`; renamed to `renamed-test.txt`)_
- [x] Incompatible combos (`--parent`+`--update`, `--convert`+`--update`) →
      `VALIDATION_ERROR`; missing local path → `LOCAL_FILE_NOT_FOUND`; directory →
      `LOCAL_PATH_NOT_FILE`. _(combos + missing-path verified live; directory + unit tests)_
- [x] Write-protection: with 2+ accounts, no `--account` → `ACCOUNT_REQUIRED`
      (via `resolveAccount`, `mutation: true`). _(declared `mutation: true`; resolution
      is the shared `resolveAccount` path covered elsewhere)_
- [x] `bun run build` clean; `bun run test` green (106 tests) incl. new mime-types +
      upload tests (flag parsing, combo validation, conversion mapping).
- [x] CLAUDE.md status updated; spec matches shipped behavior.

## Risks / unknowns

- **Conversion fidelity** — Drive's server-side conversion is lossy for complex
  documents; we expose the toggle, not a guarantee. Acceptable; documented as Drive's
  behavior, not ours.
- **Large files** — simple/multipart streamed upload (not resumable) may be unreliable
  for multi-GB files; deferred to a follow-up, noted in spec out-of-scope.
- **Live verification** — happy-path create/update/convert need a real token; unit tests
  cover the pure logic (flag parsing, combos, mime/conversion mapping) without hitting
  Google.

## Notes

Shipped as the first Drive write. Verified live against real Drive (<chris@jarv.us>):
plain text upload, CSV→native-Sheet conversion, and content-replacing update (the
replaced bytes round-tripped through `docs download`). Two scratch test files were
left in Drive during verification (no `drive delete` yet to clean them) — their IDs
were surfaced to the user for manual removal.

Conversion/MIME logic lives in a standalone `src/util/mime-types.ts` (pure, unit-tested
in isolation) so the handler stays thin; the flag-combo guard is a pure exported
`validateFlags` for the same reason. Native-converted files report a near-zero `size`
from the API — surfaced as-is rather than suppressed.

## Follow-ups

- **Deferred (no plan yet):** resumable uploads for very large (multi-GB) files —
  v1 uses the library's simple/multipart streamed upload.
- **Deferred (no plan yet):** recursive directory upload (one file per invocation today).
- **Deferred (folds into `drive move`):** folder relocation on `--update` via
  `addParents`/`removeParents` — intentionally rejected here.
- **Unblocks cleanup:** `drive delete` (still a stub) would let verification tidy up
  after itself instead of leaving scratch files behind.
