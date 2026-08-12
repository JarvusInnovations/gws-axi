# API: Conventions

The contracts every `gws-axi` command honors. A command spec in `commands/` only documents its deviations from and specializations of these; the defaults below always apply.

## Invocation shape

- `gws-axi <service> <subcommand> [positional] [--flags]`.
- Account selection: `--account <email>` on any command. Resolution and write-protection follow [principles.md#write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account) and the `resolveAccount` rules in [architecture.md](../architecture.md#account-resolution--write-protection-srcgoogleaccountts).
- `<service> <sub> --help` prints that subcommand's `<SUB>_HELP` (for services with a real dispatcher).

## Output envelope

Every successful command emits TOON ([principles.md#toon-over-json](../principles.md#toon-over-json)) composed of, in order:

1. **Header** — at minimum `account: <email>`, plus `account_source: default` when 2+ accounts and the default was used implicitly ([principles.md#self-describing-account-header](../principles.md#self-describing-account-header)).
2. **Summary** (optional) — counts/context, e.g. `count: 3 of 47`.
3. **Body** — an object (`renderObject`) and/or one or more lists (`renderList`), using minimal default schemas with opt-in detail ([principles.md#minimal-default-schemas](../principles.md#minimal-default-schemas)).
4. **`help[]`** — concrete, runnable next-step suggestions referencing the real IDs/accounts in this result ([principles.md#contextual-help-suggestions](../principles.md#contextual-help-suggestions)).

## List shape

- A populated list renders `name[N]{col1,col2,…}:` rows. Column set is the minimal default unless a flag opts into more.
- An empty list collapses to a scalar message under the list's own field name: `name: <human reason>` ([principles.md#canonical-empty-list-shape](../principles.md#canonical-empty-list-shape)). Use `renderListResponse`'s `emptyMessage`, or replicate the shape by hand.
- Record identifiers are first-class, never truncated, and echoed into `help[]` ([principles.md#ids-are-first-class](../principles.md#ids-are-first-class)).

## Completeness & fidelity disclosure

When the upstream API documents that a response may be incomplete, or returns a lossy/partial representation of the underlying data, the command states that limit in its output (a `note`/`warning` field or a `help[]` line) rather than presenting the partial result as whole ([principles.md#surface-completeness-limits](../principles.md#surface-completeness-limits)).

## Unimplemented and unsupported surfaces

A subcommand may be **scaffolded** (listed, `--help`-documented, no handler — throws
`NOT_IMPLEMENTED` after account resolution) or **refused by design** (`NOT_SUPPORTED`, e.g.
`gmail send`). Either way it must signpost the working path
([principles.md#no-dead-end-surfaces](../principles.md#no-dead-end-surfaces)):

- A scaffolded subcommand declares its **alternatives** — real, runnable gws-axi commands
  that accomplish some or all of what it will do — as part of its dispatcher entry, so the
  same list feeds every surface that mentions it.
- The `NOT_IMPLEMENTED` error leads its `suggestions[]` with those alternatives. Diagnostic
  lines (which account resolution picked, where the planned surface is documented) come
  after — they are context, not the next step.
- `<service> <sub> --help` for a scaffolded subcommand appends an `instead[N]:` block with
  the same lines.
- `<service> --help` carries an `alternatives[N]:` block whenever any of its subcommands is
  scaffolded, so the working path is visible without drilling into a stub.
- Each alternative line states what it does **and where it falls short** — most are
  wholesale-replace substitutes for a granular edit
  ([principles.md#surface-completeness-limits](../principles.md#surface-completeness-limits)).
- When no alternative exists, say so explicitly rather than omitting the block.

## Error envelope

- All errors are `AxiError(message, code, suggestions[])` on **stdout** ([principles.md#structured-errors-to-stdout](../principles.md#structured-errors-to-stdout)).
- Google API errors pass through `translateGoogleError`; 404s are re-wrapped into domain-specific codes with access-check suggestions. Raw dependency output never reaches stdout ([principles.md#no-dependency-noise-on-stdout](../principles.md#no-dependency-noise-on-stdout)).
- Validation failures use code `VALIDATION_ERROR` with a one-line usage suggestion.
- Unrecoverable → non-zero exit; idempotent no-ops → exit 0 ([principles.md#idempotent-mutations] is implied for mutations).

## Scopes & auth

- A command works only if its service's representative scope (and any required `ADDITIONAL_SCOPES`) was granted at login. A new capability needing a scope not implied by an existing grant adds an `ADDITIONAL_SCOPES` entry and requires affected accounts to re-auth once (see [architecture.md](../architecture.md#scope-model-srcauthscopests)).
- Insufficient-scope (403) is translated with a suggestion to re-run `auth login`.

## Reads vs writes

- Read commands never mutate server state, including not provoking writes on the upstream service ([principles.md#read-only-stays-read-only](../principles.md#read-only-stays-read-only)).
- Write commands declare `mutation: true` in their dispatcher entry, which engages write-protection.
