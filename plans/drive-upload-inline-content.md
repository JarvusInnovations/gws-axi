---
status: done
depends: []
specs:
  - specs/commands/drive-upload.md
issues: []
pr: 30
---

# Plan: drive upload from stdin / inline content

## Scope

Let an agent push content it just generated into Drive **without writing a temp
file first**. Today `drive upload <local-path>` requires a readable file on disk;
an agent that produced markdown in-context must stage it to a tempfile, upload,
then clean up. Add a content source that bypasses the filesystem:

- `drive upload --content <string>` — inline content, and/or
- `drive upload -` (or `--stdin`) — read the upload body from stdin.

Pairs naturally with `--convert` (e.g. pipe generated markdown straight into a new
native Doc). Surfaced as a follow-up during the `docs-revision-discoverability`
work, where the read→edit→write-back round trip exposed the missing inline path.

In scope: a non-file content source for `drive upload` (create path; `--update`
too if cheap), name/mime handling when there's no filename to infer from, and the
spec amendment. Out: multi-part/multiple inputs, binary stdin edge cases beyond a
single stream.

## Implements

- **specs/commands/drive-upload.md** — amend Invocation/Flags so `<local-path>` is
  one of several mutually-exclusive content sources (path | `--content` | stdin);
  define `--name`/`--mime` defaulting when no path is present (name required or
  derived; mime defaults to `text/plain`/`text/markdown` or must be given);
  keep streaming where possible.

## Approach

(Detailed when picked up — spec amendment first.) Likely: factor the media-body
construction in `src/commands/drive/upload.ts` to accept a `Readable` from either
`fs.createReadStream`, a string buffer (`--content`), or `process.stdin`; require
`--name` (and default/require `--mime`) when there's no source path to infer from;
reuse the existing create/convert flow unchanged downstream.

## Validation

- [x] `echo '# Hi' | gws-axi drive upload - --name notes.md --mime text/markdown --convert`
      creates a native Doc with no temp file touched.
- [x] `--content <string>` path works equivalently.
- [x] Mutually-exclusive sources validated (`VALIDATION_ERROR` when 2+ given, or none).
- [x] Missing `--name` with no path → `VALIDATION_ERROR` with usage.
- [x] `bun run build` clean; `bun run test` green incl. new flag-parsing/source tests.

## Risks / unknowns

- Name/mime inference has no extension to lean on when there's no path — must be
  explicit or sensibly defaulted; don't silently mislabel.
- Streaming stdin vs. buffering — keep memory bounded for large inputs.

## Notes

- Shipped in PR #30 alongside [`drive-upload-update-convert`](drive-upload-update-convert.md)
  (one branch/PR for both upload follow-ups).
- Sources are mutually exclusive: local path (default), `-` (stdin), `--content`.
  Settled on `-` for stdin (Unix convention) rather than a `--stdin` flag.
- `--mime` for stdin/`--content` derives from the `--name` extension via the
  existing `detectMimeType` — no new mime logic.
- Verified live: stdin and `--content` each created a native Doc via Google's
  conversion, no temp file.

## Follow-ups

- **None.** Resumable/large piped uploads are noted out-of-scope in the spec
  (stdin uses the same simple streamed upload as files).
