---
status: done
depends: [drive-upload]
specs:
  - specs/commands/drive-mkdir.md
  - specs/principles.md
  - specs/api/conventions.md
issues: []
---

# Plan: Drive mkdir (create folders)

## Scope

Add `gws-axi drive mkdir <name>` — create a Drive folder, producing the folder ID
that `drive upload --parent` (and future writes) consume. In scope: the single-folder
create with optional `--parent`, the `folder{...}` output, error translation, and the
`mutation: true` dispatcher wiring (replacing the existing stub).

Out of scope (deferred, see spec): recursive `mkdir -p` path creation and idempotent
find-or-create. The other Drive write stubs (`create`, `copy`, `move`, `rename`,
`delete`) stay `NOT_IMPLEMENTED`.

## Implements

- **specs/commands/drive-mkdir.md** — the full command: positional `<name>`,
  `--parent`, the `folder{id,name,parents,web_view_link}` response shape,
  `action: created`, error codes, and the `mutation: true` dispatcher entry. No new
  scope (existing full `auth/drive`).
- **specs/principles.md / api/conventions.md** — honors write-protection,
  ids-first-class (new folder ID untruncated + in `help[]`), minimal-default-schemas,
  structured-errors-to-stdout, contextual-help (non-idempotency disclosure).

## Approach

1. **`src/commands/drive/mkdir.ts`** (new, + test) — `MKDIR_HELP` constant +
   `driveMkdirCommand(account, args)`:
   - Hand-rolled flag parser (positional `<name>` + `--parent`), matching `drive/upload.ts`.
   - Missing name → `VALIDATION_ERROR`.
   - `files.create({ requestBody: { name, mimeType: FOLDER_MIME, parents? }, fields,
     supportsAllDrives: true })` (no media).
   - `translateGoogleError`; re-wrap `NOT_FOUND` → `FILE_NOT_FOUND` for a bad `--parent`
     (mirrors `drive get` / `upload`).
   - Render: `action: created` + `account` header, `folder{...}`, `renderHelp([...])`
     leading with `drive upload <file> --parent <id>`.
   - Export `parseFlags` for unit testing.

2. **`src/commands/drive.ts`** — replace the `mkdir` stub entry with the real handler;
   import `driveMkdirCommand` + `MKDIR_HELP` (drop the old inline `MKDIR_HELP` stub
   constant). Update DRIVE_HELP's "upload is live" note to include mkdir.

3. **CLAUDE.md** — move `mkdir` from the 🚧 stub line to the ✅ Drive writes line.

Each step: implement → `bun run build` → `bun run test`.

## Validation

- [x] `drive mkdir <name>` creates a folder and returns `action: created` +
      `folder{id,...}` with an untruncated id; `--parent` nests it. _(verified live:
      `gws-mkdir-test` at root, then a nested `sub` folder with `--parent`)_
- [x] A bad `--parent` → `FILE_NOT_FOUND`; missing name → `VALIDATION_ERROR`.
      _(both verified live)_
- [x] An uploaded file lands in the new folder via `drive upload --parent <newId>`
      (end-to-end with the upload command). _(verified live: `in-folder.txt` uploaded
      into the folder; `drive ls` showed `sub/` + `in-folder.txt`)_
- [x] Write-protection: with 2+ accounts, no `--account` → `ACCOUNT_REQUIRED`
      (declared `mutation: true`; shared `resolveAccount` path).
- [x] `bun run build` clean; `bun run test` green (112 tests) incl. new mkdir
      parseFlags + validation tests.
- [x] CLAUDE.md status updated; spec matches shipped behavior.

## Risks / unknowns

- **Non-idempotency** — re-running creates a duplicate folder. Disclosed in `help[]`;
  idempotent find-or-create is an explicit follow-up, not a v1 gap.
- **Live verification** — happy path needs a real token; unit tests cover flag parsing
  without hitting Google.

## Notes

Second Drive write, building directly on `drive-upload`'s patterns (flag parser,
`FILE_NOT_FOUND` re-wrap, `action`/header/`folder{}`/`renderHelp` output). A folder is
just `files.create` with `mimeType: application/vnd.google-apps.folder` and no media —
the simplest write. Verified live end-to-end with `drive upload` and `drive ls`:
folder → nested folder → file inside → listing.

Decision: create-new (non-idempotent), consistent with `upload`, disclosed in `help[]`.
Find-or-create was considered and deferred (Drive allows duplicate names; a name match
in the parent can be ambiguous).

## Follow-ups

- **Deferred (no plan yet):** recursive `mkdir -p` — create intermediate folders from a
  slash path in one call.
- **Deferred (no plan yet):** idempotent find-or-create (`--reuse` or default) — return
  an existing same-named folder in the parent instead of making a duplicate.
- **Unblocks cleanup:** `drive delete` (still a stub) would let live verification remove
  its own scratch folders/files instead of leaving them behind.
