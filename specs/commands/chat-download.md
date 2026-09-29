# Command: chat download

## Summary

Saves the attachments of one Google Chat message to local files. A read on Chat's side: nothing
in the conversation changes, and read state is untouched. It writes only to the local disk.

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| An uploaded attachment's bytes can be fetched under user auth with the `chat.messages` scope, through `media.download` with the attachment's `attachmentDataRef.resourceName` | **Observed 2026-09-29**: a 2.3 MB PDF and a 130 KB GIF came back intact (`%PDF-`, `GIF89a`) |
| The attachment's own `downloadUri` does not accept the API token | **Observed**: `401` with an HTML sign-in page. Not used |
| `attachments.get` refuses under user auth | **Observed**: `403`. Not used — the message already carries the attachment metadata |
| A Drive-file attachment carries `driveDataRef.driveFileId` and no `attachmentDataRef` | Documented. Handled by pointing at the Drive commands, not fetched here |
| `media.download` returns `application/octet-stream`, not the file's type | **Observed**. The type comes from the attachment's `contentType` |

## Invocation

```
gws-axi chat download <space> <message> [--attachment <n|name>] [--out <path>]
gws-axi chat download spaces/<space>/messages/<id> [...]
```

- `<space>` / `<message>` — as in [chat-react.md § Invocation](chat-react.md#invocation): the id
  `chat messages` prints, a full resource name alone, or a `client-…` id. `--with <email>` works
  in place of `<space>`.
- `--attachment <n|name>` — one attachment: its 1-based position in the message, or its exact
  file name. Omitted: every uploaded attachment on the message.
- `--out <path>` — a directory (existing, or ending in `/`) to save into, or — for a single
  attachment only — a file path. Default: the current directory.

## Behavior

- **Uploaded attachments are saved** under their own file name, made safe for the filesystem.
  Two attachments on one message with the same name are saved as `name`, `name (2)`, and so on.
- **Drive-file attachments are not fetched.** They are listed with their Drive file id and a
  `gws-axi docs download <id>` suggestion, which already handles every Drive type and its
  export formats.
- **`--out` naming a file with several attachments selected** is a `VALIDATION_ERROR` before
  anything is fetched: name a directory, or pick one with `--attachment`.
- An existing file at the destination is overwritten, as `gmail download` does.
- A message with no attachments is `NO_ATTACHMENTS`, not an empty success.

## Output

```
account: alice@example.com
message:
  space: AAQApqInMC8
  id: nIos-gNEPiI.nIos-gNEPiI
saved[1]{name,type,bytes,path}:
  PhotoBookReport_20260909_120112.pdf,application/pdf,2329246,/home/alice/PhotoBookReport_20260909_120112.pdf
help[1]:
  PDF saved — `pdftotext "PhotoBookReport_20260909_120112.pdf" -` to extract text
```

When Drive-file attachments were skipped, a `drive_files[N]{name,type,drive_file}` block follows,
with a `docs download` suggestion per file in `help[]`. When nothing was saved because every
attachment is a Drive file, `saved` collapses to the canonical empty scalar and says why.

## Errors

| Code | When |
| --- | --- |
| `NO_ATTACHMENTS` | The message has none |
| `ATTACHMENT_NOT_FOUND` | `--attachment` names a position or file name the message doesn't have; the suggestions list what it does have |
| `MESSAGE_NOT_FOUND`, `SPACE_NOT_FOUND`, `DM_NOT_FOUND`, `SCOPE_MISSING` | As in [chat-read.md § Errors](chat-read.md#errors) |
| `VALIDATION_ERROR` | `--out` names a file while several attachments are selected; bad arguments |

## Principles

**Inherited:**

- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — `mutation: false`.
  Downloading changes nothing in Chat, so it needs no `--account` with 2+ accounts.
- [no-dead-end-surfaces](../principles.md#no-dead-end-surfaces) — a Drive-file attachment is not
  refused; it names the command that fetches it.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — skipped Drive
  files are listed, never silently dropped.
