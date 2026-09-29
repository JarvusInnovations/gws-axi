---
status: done
depends: [chat-read, chat-react]
specs:
  - specs/commands/chat-download.md
  - specs/commands/chat-read.md
---

# Plan: Download chat attachments

## Scope

`chat download` saves a message's uploaded attachments locally, and points Drive-file
attachments at `docs download`. `chat messages` stops saying attachments can't be downloaded.

**Out of scope:** fetching Drive files here (duplicate of `docs download`); downloading every
attachment in a conversation at once.

## Implements

- `specs/commands/chat-download.md` — the command.
- `specs/commands/chat-read.md` — attachments now point at it.

## Approach

1. Message addressing reuses `parseReactFlags`' shape — extract a shared parser rather than copy.
2. Fetch the message; select attachments by `--attachment` (position or name).
3. For each uploaded one, `media.download` by `attachmentDataRef.resourceName`, as an array
   buffer; write with `resolveOutputPath`; de-duplicate names within the message.
4. `mutation: false`. Update `chat messages` help text and note.
5. Tests: selection by index and name, name de-duplication, `--out` file-vs-directory rule,
   Drive-file partitioning.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Live, read-only, in Pan-SLA Tech into the scratchpad: the PDF and the GIF save with their
      own names, correct sizes, and correct file signatures. Copies deleted afterwards.
- [x] `--attachment 1` and `--attachment <name>` pick one; an unknown one is
      `ATTACHMENT_NOT_FOUND` listing what exists.
- [x] A message with no attachments is `NO_ATTACHMENTS`.
- [x] A Drive-file attachment is listed, not fetched, with a `docs download` suggestion.
- [x] `chat messages --fields attachments` no longer says attachments can't be downloaded.
- [x] Nothing is posted to Pan-SLA Tech.

## Risks / unknowns

- **Whole file in memory.** Chat's upload limit keeps attachments modest; a stream is a later
  improvement if needed.

## Notes

- **Verified live, read-only, in Pan-SLA Tech** at the owner's direction: a 2.3 MB PDF and a
  130 KB GIF saved with the right sizes and file signatures, by default, by position, by name,
  and to a chosen file path. Copies were written to the session scratchpad and deleted. Nothing
  was posted there.
- **The Drive-file case was verified** on a Google Drive notification message: listed with its
  file id and a `docs download` suggestion, nothing written.
- **Stacked on `chat-react`.** Message addressing moved from `react.ts` to `address.ts` so both
  commands share it; the branch was rebased onto `feat/chat-react`, whose PR it depends on.
- The obvious routes fail under user auth — `downloadUri` (401) and `attachments.get` (403) —
  which was found by probing before the spec was written.

## Follow-ups

- Tracked as: streaming large attachments rather than buffering them.
