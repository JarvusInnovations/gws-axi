# Command: drive mkdir

## Summary

Creates a Drive **folder**. A folder is just a file with the well-known
`application/vnd.google-apps.folder` MIME type and no media body, so this is the
simplest Drive write — but a load-bearing one: it produces the `--parent` folder ID
that `drive upload` (and future `drive create`/`move`) write into.

No new scope: the existing full `auth/drive` scope authorizes `files.create`.

## Invocation

`gws-axi drive mkdir <name> [flags]`

- `<name>` — REQUIRED. The folder name. A missing name is a validation error.

## Flags

- `--parent <folder-id>` — parent folder ID. Default: My Drive root (no `parents` set).
- `--account <email>` — account override. REQUIRED when 2+ accounts are authenticated (this is a write — [principles.md#write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)).

## Data Requirements

- Drive `files.create` with `requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents? }`, **no `media`**, `fields` = the response field set below, `supportsAllDrives: true`.
- Scope: existing `auth/drive` (full). No `ADDITIONAL_SCOPES` entry, no re-auth.

## Display Rules

Header object (in order): `action: created`, then `account` (+ `account_source` per the standard header rules — but writes require explicit `--account` with 2+ accounts, so `account_source: default` only appears with exactly 1 account).

Body: `folder{id,name,parents,web_view_link}`

- `id` — the new folder's Drive ID, first-class and never truncated ([principles.md#ids-are-first-class](../principles.md#ids-are-first-class)); it is the value passed to `drive upload --parent`, `drive ls`, etc.
- `name` — the stored name.
- `parents` — comma-joined parent folder IDs (empty for root).
- `web_view_link` — `webViewLink` when present.

### help[] suggestions

- `drive upload <file> --parent <id>` — put a file in the new folder (the headline next step).
- `drive ls <id>` — list the folder's contents.
- `drive get <id>` / `drive permissions <id>` — metadata / sharing.
- A one-line note that re-running creates **another** folder (Drive allows duplicate names) — disclosing non-idempotency, mirroring `drive upload`'s create-new path.
- Open in browser: the `webViewLink`.

## Errors

- Missing `<name>` → `VALIDATION_ERROR` with a usage suggestion.
- A bad `--parent` (folder absent / no access) → translated `NOT_FOUND` re-wrapped to `FILE_NOT_FOUND` with an access-check suggestion (mirrors `drive get` / `drive upload`).
- All Google failures pass through `translateGoogleError`; raw output never reaches stdout ([principles.md#no-dependency-noise-on-stdout](../principles.md#no-dependency-noise-on-stdout)).

## Dispatcher

The `drive` dispatcher's existing `mkdir` stub becomes a real handler:
`{ name: "mkdir", mutation: true, handler: driveMkdirCommand }`. Being `mutation: true`, it engages write-protection through `resolveAccount`.

## Out of scope (v1)

- **Recursive path creation** (`mkdir -p` style: create intermediate folders from a slash path) — one folder per invocation. Deferred.
- **Idempotent find-or-create** — `mkdir` always creates a new folder; it does not search for an existing same-named folder in the parent and return it. (Drive permits duplicate folder names, and a name match could be ambiguous.) The non-idempotency is disclosed in `help[]`. A future `--reuse`/find-or-create mode can layer on top.

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account) — `mutation: true`; explicit `--account` required with 2+ accounts.
- [ids-are-first-class](../principles.md#ids-are-first-class) — the new folder ID is the handoff to every downstream write; never truncated, echoed into `help[]`.
- [minimal-default-schemas](../principles.md#minimal-default-schemas) — the response carries only the fields an agent needs to act on the new folder.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — next steps reference the real folder ID; discloses non-idempotency.
- [structured-errors-to-stdout](../principles.md#structured-errors-to-stdout) — validation and Google failures alike are `AxiError` on stdout.
- [byo-oauth-single-user](../principles.md#byo-oauth-single-user) — no new scope; rides the existing full `drive` grant.
