# Principles

The project's philosophy, written down as principles. Each is decisive: it picks a side of a real trade-off so an implementer can resolve an unspecified case the way the author would. Feature specs reference the relevant entries *down* into their own `## Principles` sections (`principles.md#<anchor>`).

The umbrella over most of these is **agent-first output**: every response is meant to be read and acted on by an LLM agent in one pass, without re-querying and without parsing noise. The principles below are the teeth of that stance.

## minimal-default-schemas

Default output carries only the fields an agent needs to act; richer detail is opt-in behind explicit flags, never on by default. Long text is truncated to a fixed cap (500 chars) unless `--full`; lists default to a bounded `--limit`.

> **Why:** Token-budget discipline. An agent should parse a response and act without paying for fields it didn't ask for or re-querying for ones it did. Progressive disclosure keeps the common case cheap and the detailed case reachable.

## provenance-by-default

When a command surfaces content an agent may port into another system (download it, copy it, re-author it elsewhere), the content's **provenance** — which revision/version it came from, when, and by whom — rides along in the *default* output, not behind a flag. This deliberately overrides [minimal-default-schemas](#minimal-default-schemas) for the narrow case of provenance fields: they are always worth their tokens.

> **Why:** gws-axi is the read side of cross-system content moves — an agent reads a Doc here and writes it into a ticket, a repo, or another document. If it can't see *which version* it read, the destination records content with no traceable source, and a later "is this still current?" question is unanswerable without a re-query the agent won't know to make. Provenance is the one piece of metadata whose absence silently corrupts the downstream artifact, so it is never opt-in on a content read. This rules out hiding revision identity / recent-revision context behind `--full` on commands whose output is meant to be carried elsewhere.

## contextual-help-suggestions

Every response — success *and* error — carries a `help[]` array of concrete, runnable next-step commands tailored to the current state, referencing the real IDs/accounts from the result. Never generic advice.

> **Why:** The response is self-guiding: the agent's next move is in hand without a separate lookup. Generic help teaches nothing the agent couldn't already read in `--help`.

## ids-are-first-class

When a command surfaces records that an agent will act on or hand to another tool, the identifier (fileId, revisionId, messageId, …) is a first-class column, never truncated, and echoed into the `help[]` next-step suggestions. Discovery output exists to produce IDs the caller can use elsewhere.

> **Why:** gws-axi is frequently the discovery layer in a larger workflow — an agent surveys, finds the relevant items, and the ID is the handoff to the next step (re-fetch, mutate, or a separate tool). An ID that's truncated or buried forces a re-query and breaks the chain. This is a sharpened, cross-command case of [minimal-default-schemas](#minimal-default-schemas) and [contextual-help-suggestions](#contextual-help-suggestions): trim everything else, never the ID.

## surface-completeness-limits

When an API cannot guarantee a complete or exact result — the upstream documents the response may omit data, or the data is a lossy/partial representation — the command states that limit in its output (a `note`/`warning` field or `help[]` line), rather than presenting a partial result as if it were whole.

> **Why:** Traceable, trustworthy results are an AXI goal. An agent that's told "this list may omit older entries" can reason about the gap and seek another source; one handed a silently-partial list will treat it as exhaustive and conclude wrongly. Honesty about coverage is more useful than a clean-looking lie.

## toon-over-json

Output is TOON, not JSON. JSON is debugging-only (`doctor --json`).

> **Why:** TOON's tabular `name[N]{cols}:` form is more token-dense and more legible to an agent than JSON for list/record data — directly serving the agent-first stance.

## canonical-empty-list-shape

An empty list collapses to a scalar human-readable message under the list's own field name (`<name>: <reason>`) — not `<name>[0]:` plus a sibling `message:` field.

> **Why:** One field to read instead of two; the array-vs-string polymorphism *is* the signal that the list was empty. A uniform empty shape across every command means an agent handles "nothing found" the same way everywhere.

## structured-errors-to-stdout

All errors are `AxiError` with a stable `code` and actionable `suggestions[]`, written to **stdout** (not stderr). Google API errors are always funneled through `translateGoogleError` — never surfaced raw.

> **Why:** Agents read one channel and parse a predictable shape. Raw Google error JSON, or a message on stderr, is unparseable noise that corrupts the output contract.

## no-dependency-noise-on-stdout

Stdout is exclusively AXI-structured output. Never leak dependency chatter (`gcloud` stderr, raw `googleapis` errors, library logs) into it.

> **Why:** The agent parses stdout as a contract. Any tool chatter mixed in breaks parsing. This is the input side of the same discipline as [structured-errors-to-stdout](#structured-errors-to-stdout).

## self-describing-account-header

Every command echoes `account: <email>` in its output, and adds `account_source: default` when 2+ accounts are authenticated and the default was used implicitly.

> **Why:** Parallel agent sessions share one config file. The response must state which account it acted as, so a default changed by another session never silently misleads the reader.

## write-protection-requires-explicit-account

With 2+ accounts authenticated, **write** operations REQUIRE explicit `--account <email>` (error `ACCOUNT_REQUIRED` otherwise); reads fall back to the configured default. With exactly 1 account, neither requires a flag.

> **Why:** In shared-config parallel sessions, one session flipping the default must never cause another's write to land on the wrong account. A little friction on writes buys zero silent wrong-account mutations. Reads are reversible, so they keep the convenience.

## authoritative-identity-from-id-token

The account storage key is always the OAuth ID-token `email` claim (lowercased), never a user-supplied string. A `--account` expectation that mismatches the returned email refuses to write tokens (`ACCOUNT_MISMATCH`).

> **Why:** Prevents identity spoofing via flag and catches the common "clicked the wrong account in Google's chooser" mistake at the moment it happens.

## byo-oauth-single-user

Ship BYO-only — each user brings their own Google Cloud OAuth client. No embedded shared client. Do not add one without hitting a documented re-assessment trigger (see `docs/shared-client-future.md`).

> **Why:** A shared client carrying Gmail scopes requires perpetual, costly CASA security audits with suspension risk on miss; BYO confines suspension blast-radius to one user and removes all ongoing compliance overhead. Ship-first, verify-later.

## never-auto-launch-browsers

The CLI never opens a browser itself. `setup.html` is the single browser surface; the CLI prints a `file://` link the user clicks, and all Console deep-links live on that page.

> **Why:** Auto-launching hits whatever Chrome profile is default, which is usually the wrong Google account. A link the user clicks from their own terminal lands in the profile they intend.

## read-only-stays-read-only

Commands classified as reads must not mutate server state as a side effect of reading — including not triggering writes on the upstream service (e.g. opening a document in a way that records a new revision or access event). Diagnostics (`doctor`) are likewise strictly read-only and safe to run anytime.

> **Why:** Agents run reads liberally, in parallel, and inside automated hooks. A read with a hidden write is unsafe to retry and corrupts exactly the history an exploration command exists to observe. Keeping reads pure makes them free to call.

## single-source-of-truth-helpers

Cross-cutting rules live in exactly one place and every call site routes through it: account resolution → `resolveAccount` (`src/google/account.ts`); Gmail label name↔id resolution → `src/commands/gmail/labels-shared.ts`; Google error translation → `translateGoogleError` (`src/google/client.ts`).

> **Why:** A rule copied into N call sites drifts into N subtly-different rules. One implementation, many callers, means write-protection (and every other shared rule) is enforced identically everywhere.

## gmail-send-out-of-scope-by-design

Gmail `send` is intentionally NOT implemented — it short-circuits with `NOT_SUPPORTED`, redirecting to `draft`. This is a product boundary enforced in code, not a token limitation (the granted `gmail.modify` token *is* send-capable). Do not "implement" send.

> **Why:** No Gmail scope grants drafting + label edits while withholding send, so the safety boundary "agent composes, human sends" can't be drawn with scopes — it's drawn in code instead. Crossing it would let an agent send mail unsupervised.
