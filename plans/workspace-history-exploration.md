---
status: done
depends: []
specs:
  - specs/commands/gmail-read.md
  - specs/commands/drive-revisions.md
  - specs/commands/drive-activity.md
  - specs/principles.md
  - specs/api/conventions.md
issues: []
---

# Plan: Workspace history & exploration reads

## Scope

Add three additive, read-only capabilities that let an agent comprehensively survey
and follow a trail across a user's Google Workspace, surfacing IDs the caller hands
off to downstream tools:

1. **`gmail read --raw` / `--headers`** — full RFC 2822 headers + raw source.
2. **`drive revisions <fileId>`** (+ `docs revisions` alias) and **`docs download --revision`** — file version history and historical content download (markdown-default for native).
3. **`drive activity <itemId>`** — attributed action timeline via the Drive Activity API v2.

In scope: the read commands, their output shapes, the new `drive.activity.readonly`
scope wiring + doctor/probe updates, and Vitest coverage. Explicitly out: the full
Docs sidebar timeline, version names, forensic content hashing, revision diffs, and
org-admin/Vault-grade provenance (see each spec's "Out of scope").

## Implements

- **specs/commands/gmail-read.md** — `--raw` (format=raw decoded), `--headers` (full
  `headers[N]` + `internal_date` + parsed body), mutual-exclusion, thread→latest-message
  resolution. No new scope (existing `gmail.modify`).
- **specs/commands/drive-revisions.md** — `drive revisions` list (paginated, newest-first,
  `--full`, completeness note for native), `docs revisions` alias, and `docs download
  --revision` (native via `exportLinks` markdown-default; binary via `alt=media`; purge
  - format fallbacks). No new scope (existing `auth/drive`).
- **specs/commands/drive-activity.md** — `drive activity` (`itemName`/`ancestorName`,
  `--since/--until/--action/--limit`, best-effort actor resolution, visibility note).
  New `drive.activity.readonly` scope + `driveactivity.googleapis.com` API.
- **specs/principles.md / api/conventions.md** — new commands honor ids-first-class,
  surface-completeness-limits, read-only, minimal-default-schemas, structured errors.

## Approach

Build in three commits, lowest-risk first:

1. **gmail headers/raw** — extend `src/commands/gmail/read.ts` flag parser + a
   `renderHeaders`/`renderRaw` branch. `format=raw` returns base64url `raw`; decode to
   UTF-8. `--headers` reads full `payload.headers[]`. Reuse existing thread/message
   resolution; for a thread id under `--raw`/`--headers`, resolve to the newest message.

2. **drive revisions + revision download** — new `src/commands/drive/revisions.ts`
   (list, paginate `revisions.list`, classify native/binary via `files.get`, sort by
   `modifiedTime` desc, completeness note). Register in `drive.ts`; add `docs revisions`
   alias in `docs.ts`. Extend `src/commands/docs/download.ts` with `--revision`:
   native → fetch revision `exportLinks[mime]` (default `text/markdown`, fallback chain)
   with an authenticated GET via `oauthClientForAccount` token; binary → `revisions.get
   alt=media`; `.r<id>` filename suffix; new error codes `REVISION_NOT_FOUND`,
   `EXPORT_FORMAT_REQUIRED`, `REVISION_CONTENT_UNAVAILABLE`.

3. **drive activity** — add `drive.activity.readonly` to `ADDITIONAL_SCOPES` and
   `driveactivity.googleapis.com` to `REQUIRED_APIS`/probe. New
   `src/commands/drive/activity.ts` calling `activity:query` (raw `fetch` + bearer, like
   probe.ts, or googleapis driveactivity client). Normalize action detail → label;
   resolve `people/<id>` actors best-effort (People API or leave raw); visibility note.
   Register in `drive.ts`. Document the one-time re-auth in CLAUDE.md status.

Each commit: implement → `bun run build` → `bun run test` → add tests.

## Validation

- [x] `gmail read <id> --headers` emits `headers[N]{name,value}` (full set incl. Received/Message-ID/DKIM/ARC) + `internal_date` + parsed `body{}`; ids untruncated. _(verified live against a real thread)_
- [x] `gmail read <id> --raw` emits decoded RFC 2822 source; `--out` writes it (`.eml`, 40KB verified); `--raw`+`--headers` → `VALIDATION_ERROR`. _(verified live)_
- [x] `gmail read` still marks nothing read — uses `format=raw`/`full` gets, no `modify` call (read-only preserved).
- [x] `drive revisions <fileId>` lists newest-first `{id,modified,author}`; `--full` adds size/mime/kept/published; native files carry the completeness note. _(verified live on a native Doc: 18 revs, head 1179)_
- [x] `docs revisions <fileId>` alias is identical to `drive revisions`. _(verified live)_
- [x] `docs download <fileId> --revision <id>` on a native file returns markdown by default (56KB `.r250.md` verified) and respects `--as` with `EXPORT_FORMAT_REQUIRED` fallback; on a binary file uses `alt=media` and rejects `--as`; bad id → `REVISION_NOT_FOUND` (verified live); filename suffixed `.r<id>`. _(binary `alt=media` path exercised by code review + unit tests; not run against a live binary file)_
- [x] `drive activity <itemId>` lists newest-first `{time,action,actor,target}`; `--folder`, `--since/--until`, `--action`, `--limit` shape the query; visibility note present. _(validation/error paths verified live; the live happy-path returns data only after the re-auth below — exercised via unit tests on the pure extractors + filter builder)_
- [x] `drive.activity.readonly` is in `allScopes()` and `driveactivity.googleapis.com` in `allApis()` (verified at runtime); missing-scope 403 suggests re-auth (verified live: `INSUFFICIENT_SCOPE`). _(per-account `probe.ts` does not separately probe the Activity API — spec amended to reflect this; runtime 403 → `API_NOT_ENABLED`)_
- [x] `bun run build` clean; `bun run test` green (85 tests); new Vitest specs for flag parsing + output shape + error translation across all three.
- [x] CLAUDE.md "Current implementation status" updated; spec-drift auditor run and findings resolved (specs match shipped behavior).

## Risks / unknowns

- `exportLinks` key set is server-determined per revision — markdown may be absent on some; fallback chain + `EXPORT_FORMAT_REQUIRED` handle it.
- Drive Activity actor resolution to email is best-effort; consumer/anonymous actors may stay opaque. Acceptable per spec.
- Adding `drive.activity.readonly` forces a one-time re-auth for existing accounts — must be called out in output/docs, mirroring the `gmail.settings.basic` precedent.
- Revisions API may omit history for heavily-edited native docs — surfaced as a note, not worked around.

## Notes

Shipped as four feature commits + a spec commit + an audit-fix commit:

- `feat(gmail): add read --headers and --raw modes`
- `feat(drive): add revisions list + revision content download`
- `feat(drive): add activity timeline via Drive Activity API v2`
- `fix(workspace-history): resolve spec-drift audit findings`

Verified live against real Workspace data where the existing token's scopes
allowed: gmail headers/raw, drive/docs revisions list + alias, native
revision markdown download, and all validation/error paths. The Drive
Activity happy-path could not be run live because the existing token
predates `drive.activity.readonly` — it correctly returns `INSUFFICIENT_SCOPE`
until a one-time re-auth. The pure logic (filter builder, action/actor/target
extractors) is unit-tested.

A spec-drift audit was run before closeout; it found one bug (gmail `--raw
--out` shape) and several gaps, all resolved in the audit-fix commit —
either by fixing code or amending specs to the shipped design.

The dependency bump (`googleapis` 173, `google-auth-library` 10.7.0 with an
exact `overrides` pin) and the specops scaffold landed as separate earlier
commits on `develop`, not part of this plan's feature work.

## Follow-ups

- **Deferred (no plan yet):** People API actor resolution for `drive activity`
  — turn `people/<id>` into a display name/email. Explicitly out of v1 scope;
  raw id is the stable fallback today.
- **Deferred (no plan yet):** richer `drive activity` output — a `--full` mode
  expanding every action in a multi-action activity (currently shows the
  primary), and per-action detail (move source/dest, permission deltas).
- **Deferred (no plan yet):** revision `--diff <a>..<b>` for native docs
  (export both to markdown, diff client-side).
- **None required:** the `drive.activity.readonly` re-auth is expected
  behavior, surfaced in help/output and CLAUDE.md, mirroring the
  `gmail.settings.basic` precedent.
