---
status: done
depends: [drive-move-trash]
specs:
  - specs/commands/gmail-draft.md
  - specs/commands/gmail-read.md
  - specs/commands/drive-upload.md
issues: [70]
---

# Plan: the rest of #70 — attachments and delivery-verification fields

## Scope

Items 2–4 of #70: `gmail draft --attach`; `sent` (local time) per message and attachment totals
on the thread header in `gmail read`, plus local `last_date` in `gmail search`; and
`revision_id` on `drive upload` output.

## Implements

- `specs/commands/gmail-draft.md` § Attachments
- `specs/commands/gmail-read.md` — delivery-verification bullet
- `specs/commands/drive-upload.md` — `revision_id`

## Approach

1. `compose.ts`: `buildMessage` emits `multipart/mixed` (html part first) when attachments
   are present; `filenameParams` for names.
2. `draft.ts`: repeatable `--attach`, `readAttachments` (paths, directories, 25 MB), upload
   via `message/rfc822` media.
3. `read.ts`: `sentTime`; thread `attachments` / `attachment_bytes`. `search.ts`: local
   `last_date`.
4. `upload.ts`: `headRevisionId`, falling back to the newest revision for native files.

## Validation

- [x] Unit: multipart structure with exactly one html part; filename encoding; attachment
      read errors; `sentTime` header and fallback.
- [x] Live: draft to self with three attachments — names (incl. non-ASCII) and sizes right in
      `gmail read`, binary byte-identical through `gmail download`; a 20 MB attachment drafts;
      25.1 MB is `ATTACHMENT_TOO_LARGE`; a missing path is `LOCAL_FILE_NOT_FOUND`.
- [x] Live: `gmail read` shows `sent` and thread `attachments`/`attachment_bytes`;
      `gmail search` shows local `last_date`.
- [x] Live: `drive upload --update` prints `revision_id` for a binary file (headRevisionId) and
      for a native Doc (`"2"`, matching `drive revisions`).
- [x] build, lint, format:check, test.

## Risks / unknowns

- The composer keeping attachments through a human send is expected but not exercised.

## Notes

- **RFC 2231 `filename*` loses to Gmail**: the first live draft stored `Résumé — draft.md`
  as `R_sum_ _ draft.md`. Switched to an RFC 2047 encoded-word in the quoted parameter,
  which Gmail keeps.
- Drafts went to the account's own address only; the two throwaway drafts were deleted.
  One draft remains for a human to eyeball in the Gmail UI: "gws-axi attach test 2 (safe to
  delete)" (`r-301365077595758956`).
- `gmail search`'s `last_date` was a raw header string — a pre-existing violation of the
  Displayed-times convention added in #88, fixed here since the issue asked for local sent
  times.

## Follow-ups

- Tracked as: send a draft with attachments from the Gmail UI once to confirm the composer
  keeps them.
- Tracked as: inline images (`cid:`) in draft bodies.
