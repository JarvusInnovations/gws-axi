# API: Conventions

The contracts every `gws-axi` command honors. A command spec in `commands/` only documents its deviations from and specializations of these; the defaults below always apply.

## Invocation shape

- `gws-axi <service> <subcommand> [positional] [--flags]`.
- Account selection: `--account <email>` on any command, or a `GWS_AXI_ACCOUNT` pin for the whole environment (see [Environment](#environment)). Resolution and write-protection follow [principles.md#write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account) and the `resolveAccount` rules in [architecture.md](../architecture.md#account-resolution--write-protection-srcgoogleaccountts).
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

## Time ranges

Commands that filter by time take a pair of **range flags** — `--from`/`--to` (`calendar events`,
`calendar search`, `calendar freebusy`) or `--since`/`--until` (`drive activity`). Every such pair
honors the rules below. Flags that name a single moment rather than bound a range
(`calendar create --start/--end`, `calendar update --start/--end`) are **not** range flags and are
parsed literally.

Ranges are half-open: `[from, to)`. This is already what both upstream APIs do — Calendar's
`timeMax` is an exclusive upper bound, and `drive activity` builds `time >= from and time < to`.

### Precision determines the boundary

A range flag's value carries the precision of what was typed, and the resolved boundary follows from
that precision **and which edge it lands on**:

| Value | `--from` / `--since` resolves to | `--to` / `--until` resolves to |
| --- | --- | --- |
| `2026-08-26` (day) | `2026-08-26T00:00` local | `2026-08-27T00:00` local |
| `2026-08-26T14:00` (instant, no offset) | as written, local tz | as written, local tz |
| `2026-08-26T14:00:00-04:00` (instant) | as written, offset preserved | as written, offset preserved |

A date-only value denotes a **day**, not an instant, so `--to 2026-08-26` means "through the end of
the 26th" and `--from 2026-08-26 --to 2026-08-26` is that whole day. Because the upper bound is
exclusive, expanding to the *next* local midnight is the literal translation of "include the 26th".

The consequence is stated in help rather than hidden: `--to 2026-08-26` and `--to 2026-08-26T00:00`
are **not** the same boundary. Day granularity in, day boundary out.

Expansion is per-edge and precision-driven, **never conditional on the other edge**. A rule that
fired only when `from == to` would make `--from D --to D` and `--from D --to D+1` cover the same
window; each edge must stay independently monotonic.

### Relative tokens

Every range flag also accepts, in place of a date:

| Token | Precision | Meaning |
| --- | --- | --- |
| `now` | instant | the current moment |
| `today` / `tomorrow` / `yesterday` | day | that local calendar day, expanded per edge |
| `+Nd` / `-Nd`, `+Nw` / `-Nw` | day | N days / weeks from today, expanded per edge |
| `+Nh` / `-Nh` | instant | N hours from now |

Day-precision tokens expand exactly like a typed date, which is what makes them compose:
`--from now --to today` is the rest of today, `--from today --to +6d` is the next seven days.

Day and week arithmetic is **local-calendar arithmetic** — construct the local date N days out —
never millisecond addition. A DST transition inside the range must not shift a midnight boundary.

Weekday names (`monday`, `friday`) are deliberately absent: "monday" cannot be resolved to the next
or the previous Monday without guessing, and a range flag is the wrong place to guess.

### Window shortcuts

`calendar events`, `calendar search`, and `calendar freebusy` accept two sugar flags that expand to a
`--from`/`--to` pair before anything else runs:

- **`--today`** — today's local calendar day: `[today 00:00, tomorrow 00:00)`.
- **`--this-week`** — the week containing today, from its first day at 00:00 local through the same
  weekday 00:00 seven days later, regardless of what day it currently is. Not "the next seven days"
  (`--from today --to +6d`), and not "the rest of the week" (`--from now --to <the week's last date>`).

Which day starts the week is **the account's own Google Calendar `weekStart` setting** (`0` Sunday,
`1` Monday, `6` Saturday), not a constant. A person asking their calendar "what's this week" means
the week as their calendar draws it; a fixed Monday would be wrong for every Sunday-start user. The
setting is readable under the existing `calendar` scope (`settings.get`) — no new grant — and is
**cached per account** so the shortcut costs no extra round trip on the common path.

The lookup stays honest rather than hidden:

- The resolved window is echoed like any other range, and a week shortcut additionally reports
  `week_start: <day>` with its source, so the interpretation is visible on the call that used it.
- A failed or unavailable lookup **falls back to Monday and says so** in that same field. A
  preference lookup must never fail the query it was decorating — same best-effort posture as
  `docs read`'s inlined revisions.
- The cache carries a fetch timestamp and expires, so changing the setting in Google takes effect
  without re-auth.

A shortcut combined with `--from`/`--to`, or with another shortcut, is a `VALIDATION_ERROR` — never
silently resolved in favor of one.

### An empty window is an error, not an empty result

Once both edges resolve, `from >= to` fails with `VALIDATION_ERROR` naming both resolved boundaries
and the flags that produced them. A window that cannot match anything must never render as the
canonical empty-list shape: `events: no events found in the given time range` reads as *nothing is
scheduled*, and an agent acts on that.

### The resolved range is echoed

Every command that applies a range echoes it in its summary block as `range: <from> → <to>`, rendered
in **local-offset ISO** (`2026-08-26T00:00:00-04:00`), never UTC `Z` form
([principles.md#provenance-by-default](../principles.md#provenance-by-default)). The echo is what
makes tokens and shortcuts auditable — the caller can always see the window it actually got, without
re-deriving it.

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

## Environment

Two environment variables configure gws-axi. Both only **pin ambient context**; neither enables a
behavior unreachable by flag ([principles.md#env-pins-context-never-expands-capability](../principles.md#env-pins-context-never-expands-capability)).
There are no others, and adding one is a spec change, not an implementation detail.

| Variable | Effect |
| --- | --- |
| `GWS_AXI_ACCOUNT` | Pins every command in this environment to one authenticated account. |
| `XDG_CONFIG_HOME` | Relocates the config dir to `$XDG_CONFIG_HOME/gws-axi/` (standard XDG behavior; see [architecture.md](../architecture.md#config-layout-xdg)). |

An empty or whitespace-only value is treated as **unset**, never as a meaningful value.

### `GWS_AXI_ACCOUNT` pins the account

Set it to an authenticated account's email and every command acts as that account:

```sh
GWS_AXI_ACCOUNT=alice@example.com gws-axi calendar events --today
```

Its purpose is to constrain an agent session — an operator configures the environment once, and the
account cannot then drift with a shared `default_account` or a guessed flag. It is therefore a
**pin, not a default**:

| Situation | Result |
| --- | --- |
| Pin set, no `--account` | Acts as the pinned account, for reads *and* writes. |
| Pin set, `--account <same email>` | Fine. Agreement, not conflict. |
| Pin set, `--account <different email>` | `ACCOUNT_LOCKED` — refused, never silently overridden. |
| Pin names an unauthenticated account | `ACCOUNT_LOCK_INVALID` on every command that resolves an account. |
| Pin set alongside a different `default_account` | The pin wins; the default is untouched on disk. |

The pin **satisfies write-protection**: with 2+ accounts authenticated, a mutation under a pin needs
no `--account`, because the environment already made the explicit choice write-protection exists to
demand ([principles.md#write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)).
A pinned session that could still be talked into `--account someone-else@example.com` would not be a
constraint at all, which is why the conflict is an error rather than an override.

A pin naming an account that isn't authenticated fails loudly on every command rather than falling
back to the default. Silent fallback is precisely the outcome the pin was set to prevent, so a typo
in the variable must not degrade into "acted as somebody else."

### The pin is disclosed everywhere it applies

- Every command emits `account_source: env` in its header whenever the pin decided the account —
  including the single-account case, where no other `account_source` line would appear
  ([principles.md#self-describing-account-header](../principles.md#self-describing-account-header)).
- The home view (`gws-axi` / `--summary`), `auth accounts`, `auth status`, and `doctor` report the
  pin as `account_lock: <email> (GWS_AXI_ACCOUNT)`. Where those surfaces report write-protection,
  they say it is satisfied by the pin rather than claiming writes still require `--account`.
- `auth use <email>` still writes `default_account` while a pin is active — it is a legitimate
  change for other sessions — but its output states that the pin overrides it here.

### Auth commands are not pinned

`auth` subcommands operate on the account *store*, not *as* an account, so the pin does not gate
them: `auth login --account <other>` may still add an account, and `auth revoke` may still remove
one. The pin's guarantee is about which account service commands act as, and adding a second account
to the store does not weaken it — the pinned session still cannot use it.

One convenience follows: `auth login` with no `--account` and a pin set re-authenticates the pinned
account, so a locked session can refresh its own credentials without naming itself.

### What the pin is not

It is an **accident boundary, not a security boundary**. Anything that can run `gws-axi` can also
unset the variable ([principles.md#surface-completeness-limits](../principles.md#surface-completeness-limits)
applies to our own guarantees too). For an actual boundary, point `XDG_CONFIG_HOME` at a config dir
containing only the intended account's tokens — then no other account's credentials exist to use.
The two compose: the config dir bounds what is *reachable*, the pin bounds what is *used*.

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
