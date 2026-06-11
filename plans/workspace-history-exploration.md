---
status: in-progress
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

- [ ] `gmail read <id> --headers` emits `headers[N]{name,value}` (full set incl. Received/Message-ID/DKIM) + `internal_date` + parsed body; ids untruncated.
- [ ] `gmail read <id> --raw` emits decoded RFC 2822 source; `--out` writes it; `--raw`+`--headers` → `VALIDATION_ERROR`.
- [ ] `gmail read` still marks nothing read (read-only preserved).
- [ ] `drive revisions <fileId>` lists newest-first `{id,modified,author}`; `--full` adds size/mime/kept/published; native files carry the completeness note.
- [ ] `docs revisions <fileId>` alias is identical to `drive revisions`.
- [ ] `docs download <fileId> --revision <id>` on a native file returns markdown by default and respects `--as` with `EXPORT_FORMAT_REQUIRED` fallback; on a binary file uses `alt=media` and rejects `--as`; bad id → `REVISION_NOT_FOUND`; filename suffixed `.r<id>`.
- [ ] `drive activity <itemId>` lists newest-first `{time,action,actor,target}`; `--folder`, `--since/--until`, `--action`, `--limit` shape the query; visibility note present.
- [ ] `drive.activity.readonly` is in `allScopes()`; `doctor` checks `driveactivity.googleapis.com`; missing-scope 403 suggests re-auth.
- [ ] `bun run build` clean; `bun run test` green; new Vitest specs for flag parsing + output shape + error translation across all three.
- [ ] CLAUDE.md "Current implementation status" updated; specs match shipped behavior (no drift).

## Risks / unknowns

- `exportLinks` key set is server-determined per revision — markdown may be absent on some; fallback chain + `EXPORT_FORMAT_REQUIRED` handle it.
- Drive Activity actor resolution to email is best-effort; consumer/anonymous actors may stay opaque. Acceptable per spec.
- Adding `drive.activity.readonly` forces a one-time re-auth for existing accounts — must be called out in output/docs, mirroring the `gmail.settings.basic` precedent.
- Revisions API may omit history for heavily-edited native docs — surfaced as a note, not worked around.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
