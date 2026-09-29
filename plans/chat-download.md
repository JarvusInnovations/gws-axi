---
status: in-progress
depends: [chat-read]
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

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Live, read-only, in Pan-SLA Tech into the scratchpad: the PDF and the GIF save with their
      own names, correct sizes, and correct file signatures. Copies deleted afterwards.
- [ ] `--attachment 1` and `--attachment <name>` pick one; an unknown one is
      `ATTACHMENT_NOT_FOUND` listing what exists.
- [ ] A message with no attachments is `NO_ATTACHMENTS`.
- [ ] A Drive-file attachment is listed, not fetched, with a `docs download` suggestion.
- [ ] `chat messages --fields attachments` no longer says attachments can't be downloaded.
- [ ] Nothing is posted to Pan-SLA Tech.

## Risks / unknowns

- **Whole file in memory.** Chat's upload limit keeps attachments modest; a stream is a later
  improvement if needed.

## Notes

## Follow-ups
