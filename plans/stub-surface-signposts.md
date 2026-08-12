---
status: planned
depends: []
specs:
  - specs/api/conventions.md
  - specs/principles.md
issues: [50]
---

# Plan: signpost the working path from every stubbed subcommand

## Scope

**In:** give every scaffolded (`NOT_IMPLEMENTED`) subcommand across `sheets`, `docs`,
`drive`, and `slides` a declared list of working alternatives, and surface that list in the
three places a caller can hit it — the `NOT_IMPLEMENTED` error, the subcommand's `--help`,
and the service's `--help`.

**Out:** implementing any of the stubbed writes. `calendar` is fully implemented and needs
no change. The unused `buildServiceStub` helper (`src/commands/service-stub.ts`) is dead
code predating the real dispatchers — flagged, not removed here.

## Implements

- [`specs/principles.md#no-dead-end-surfaces`](../specs/principles.md#no-dead-end-surfaces) — new principle.
- [`specs/api/conventions.md`](../specs/api/conventions.md) — "Unimplemented and unsupported
  surfaces" section.

Closes [#50](https://github.com/JarvusInnovations/gws-axi/issues/50), which reported an agent
extracting the OAuth token and hand-rolling a `.js` script to update a spreadsheet because
`sheets --help` offered no hint that `drive upload` exists.

## Approach

1. **`src/commands/stub-signposts.ts`** (new, shared by all four dispatchers, per
   [principles.md#single-source-of-truth-helpers](../specs/principles.md#single-source-of-truth-helpers)):

   - `notImplemented(service, sub, account, instead?)` → `AxiError` with `instead` lines
     first in `suggestions[]`, diagnostics after. When `instead` is absent, an explicit
     "no gws-axi command does this yet" line takes its place.
   - `withInstead(help, instead?)` → appends an `instead[N]:` block to a stub's `--help`.
   - `renderAlternatives(subs)` → the service-level `alternatives[N]:` block, deduped across
     every stubbed subcommand; empty string when nothing is stubbed.

2. **Each dispatcher** gains an optional `instead?: string[]` on its subcommand interface,
   populated per stub, and routes its three surfaces through the helpers above.

3. **The alternative lines** (each states the limit, not just the command):

   | Service | Stubs | Alternative |
   | --- | --- | --- |
   | `sheets` | `update`, `append`, `clear` | `drive upload <csv> --update <id> --convert` — replaces the **entire** spreadsheet; not a per-range write, and multi-sheet targets need `--replace-all-tabs` |
   | `sheets` | `create` | `drive upload <csv> --convert --name <title>` |
   | `sheets` | `add-tab` | none |
   | `docs` | `append`, `insert-text`, `delete-range`, `style-*`, `insert-table`, `edit-cell` | `docs download <id>` → edit → `drive upload <md> --update <id> --convert` — the documented round trip; replaces the **whole** document as a new revision |
   | `docs` | `comment-*` | none |
   | `drive` | `create` | `drive upload` (file/stdin/`--content`), or `drive mkdir` for a folder |
   | `drive` | `copy`, `move`, `rename`, `delete` | none |
   | `slides` | `create` | `drive upload <pptx> --convert` |
   | `slides` | `update` | `drive upload <pptx> --update <id> --convert` |

   `drive rename` deliberately gets **none**: `drive upload --update --name` renames, but only
   while replacing the file's content, so advertising it as a rename would mislead.

## Validation

- [ ] `gws-axi sheets --help` shows an `alternatives[N]:` block naming `drive upload`.
- [ ] `gws-axi sheets update <id> --account <email>` returns `NOT_IMPLEMENTED` whose **first**
      suggestion is the `drive upload --update … --convert` line, not the account diagnostic.
- [ ] `gws-axi sheets update --help` ends with an `instead[N]:` block.
- [ ] Same three checks pass for `docs append`, `drive create`, and `slides update`.
- [ ] `sheets add-tab` and `drive move` (no alternative) state that explicitly rather than
      omitting the block.
- [ ] `calendar --help` is unchanged (nothing stubbed) and gains no empty `alternatives:` block.
- [ ] Every alternative line names a command that actually resolves today
      (`drive upload`, `drive mkdir`, `docs download`).
- [ ] `bun run test` and `bun run build` pass.

## Risks / unknowns

- **Signpost accuracy drifts as writes land** — each alternative is a claim about a *current*
  command. When a real `sheets update` ships, its `instead` entry must be removed with it.
  Mitigated by keeping the lines in the dispatcher table next to the stub they describe, so
  deleting the stub deletes the claim.
- **Overselling** — every alternative here is wholesale-replace standing in for a granular
  edit. Lines that state the command without the caveat would send agents into silent data
  loss (the hazard `MULTI_TAB_TARGET` already guards).

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
