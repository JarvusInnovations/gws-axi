---
status: done
depends: []
specs:
  - specs/api/conventions.md
  - specs/architecture.md
  - specs/principles.md
issues: []
pr: 67
---

# Plan: `GWS_AXI_ACCOUNT` — pin a session to one account via the environment

## Scope

Today the only way to choose an account is `--account` per invocation or the shared
`default_account` in `config.json`. Neither can constrain an agent: a flag is a per-call
choice the agent makes, and the default is mutable global state any parallel session can
flip. There is no way for an operator to configure an environment such that everything run
inside it acts as one account and nothing else.

This plan adds `GWS_AXI_ACCOUNT` as a **pin** — set it, and every service command in that
environment resolves to that account, for reads and writes, with a conflicting `--account`
refused rather than honored.

**In scope:**

- `GWS_AXI_ACCOUNT` read inside `resolveAccount` (`src/google/account.ts`) — the single
  source of truth every command already routes through, so no per-command work.
- Two new error codes: `ACCOUNT_LOCKED` (conflicting `--account`) and `ACCOUNT_LOCK_INVALID`
  (pin names an unauthenticated account).
- The pin satisfies write-protection — a mutation under a pin needs no `--account`.
- `account_source: env` in every command header, including the single-account case.
- **Wiring `account_source` at all** (discovered mid-plan — see the amendment note under
  Validation): `accountHeaderFields` had zero production call sites, so no `account_source`
  line has ever been emitted. Fixed via `withAccountSource` at the dispatcher.
- Pin disclosure on the state surfaces: home view / `--summary`, `auth accounts`,
  `auth status`, `doctor`, and a note on `auth use`.
- `auth login` with no `--account` falls back to the pinned account.
- `AccountResolution` grows a `source` discriminant, replacing the current
  `explicit: boolean` + count-based inference in `accountHeaderFields`.
- Docs: `README.md` (agent-sandbox recipe) and `docs/design.md` (auth model section).

**Out of scope:**

- Any *other* environment variable. The spec now caps the surface at two
  ([principles.md#env-pins-context-never-expands-capability](../specs/principles.md#env-pins-context-never-expands-capability));
  adding a third is a spec change first.
- Making the pin a security boundary. It is an accident boundary by construction — anything
  that can run `gws-axi` can unset it. The real boundary is a scoped `XDG_CONFIG_HOME`,
  which already works and only needs documenting alongside the pin.
- A `--lock` flag or persisted lock in `config.json`. A pin's whole value is that it lives
  outside the state the pinned session can edit; writing it to `config.json` would put it
  back within reach.
- Per-service or per-command pins (`GWS_AXI_CALENDAR_ACCOUNT`). No demonstrated need, and
  it multiplies the invisible-configuration problem the principle warns about.

## Implements

- `specs/api/conventions.md` § **Environment** — the whole section: the two-variable cap,
  empty-is-unset, the pin precedence table, write-protection satisfaction, the loud-failure
  rule for an invalid pin, the disclosure list, the auth-commands carve-out, and the
  accident-vs-security-boundary statement.
- `specs/api/conventions.md` § **Invocation shape** — account selection now names the pin.
- `specs/architecture.md` § **Account resolution & write-protection** — the reordered
  `resolveAccount` algorithm with the pin checked first, the `source` discriminant, the
  auth-commands carve-out, and the two new codes in the error-model list.
- `specs/principles.md#env-pins-context-never-expands-capability` — new principle.
- `specs/principles.md#write-protection-requires-explicit-account` — amended so
  "explicit" covers the pin.
- `specs/principles.md#self-describing-account-header` — amended for `account_source: env`.

## Approach

### 1. `src/config.ts` — read the variable in one place

```ts
/** The GWS_AXI_ACCOUNT pin, normalized; undefined when unset or blank. */
export function getAccountLock(): string | undefined {
  const raw = process.env.GWS_AXI_ACCOUNT;
  if (!raw || !raw.trim()) return undefined;
  return normalizeEmail(raw);
}
```

Empty-is-unset is deliberate and load-bearing: `GWS_AXI_ACCOUNT=` in a `.env` or a shell
export that resolved to nothing must not become a pin that matches no account and bricks
every command. (Same class of bug as the `Number("") === 0` weekStart regression fixed in
d5bd070 — an empty value parsing as *valid* rather than absent.)

Read via `process.env` at call time, never cached at module load, so tests can set and clear
it per case without module-registry games.

### 2. `src/google/account.ts` — the pin, ahead of everything else

`AccountResolution.explicit: boolean` becomes `source: AccountSource`:

```ts
export type AccountSource = "env" | "flag" | "single" | "default";

export interface AccountResolution {
  account: string;
  source: AccountSource;
  totalAccounts: number;
  defaultAccount?: string;
  lockedTo?: string;   // set whenever a pin is active
}
```

`explicit` was only ever consumed by `accountHeaderFields`, and the pin makes the boolean
insufficient anyway (it must be *explicit for write-protection* yet *disclosed like a
default*). One discriminant answers both questions and is greppable.

Resolution order — the pin is checked immediately after the zero-accounts guard, before
`--account` validation, so a conflict reports the *lock*, not a bogus `ACCOUNT_NOT_FOUND`:

```
0 accounts                              → NO_ACCOUNTS
lock set:
  !hasAccount(lock)                     → ACCOUNT_LOCK_INVALID
  requested && requested !== lock       → ACCOUNT_LOCKED
  else                                  → { account: lock, source: "env", lockedTo: lock }
requested                               → validate → { source: "flag" }
1 account                               → { source: "single" }
mutation                                → ACCOUNT_REQUIRED
default set                             → { source: "default" }
else                                    → NO_DEFAULT_ACCOUNT
```

Both new errors name the variable and give an unset command, since an agent that hits one
may not know its own environment:

- `ACCOUNT_LOCK_INVALID` — "GWS_AXI_ACCOUNT is set to `x@y` but that account is not
  authenticated", suggesting the authenticated list, `auth login --account x@y`, and
  `unset GWS_AXI_ACCOUNT`.
- `ACCOUNT_LOCKED` — "This environment is pinned to `a@b` (GWS_AXI_ACCOUNT); `--account c@d`
  cannot override it", suggesting re-running without `--account`, and running the command
  in an unpinned environment if the other account is really wanted.

`accountHeaderFields` becomes source-driven:

```ts
if (resolution.source === "env") fields.account_source = "env";
else if (resolution.source === "default" && resolution.totalAccounts > 1)
  fields.account_source = "default";
```

`env` is emitted unconditionally — with one account authenticated no `account_source` line
would otherwise appear, and that is exactly the case where a reader most needs to know a pin
is in force.

### 3. State surfaces

| File | Change |
| --- | --- |
| `src/commands/home.ts` | `account` = pinned email; `account_lock: <email> (GWS_AXI_ACCOUNT)`; the `write_protection:` line becomes "satisfied by GWS_AXI_ACCOUNT pin" instead of "writes require --account"; drop the "add another account" help under a pin |
| `src/commands/auth.ts` `runAccounts` | `locked_to` field; mark the pinned row; a help line saying `auth use` won't take effect here |
| `src/commands/auth.ts` `runStatus` | `account_lock` when set |
| `src/commands/auth.ts` `runUse` | still writes the default; adds a `note` + help line that the pin overrides it in this environment |
| `src/commands/auth.ts` `runLogin` | no `--account` + pin set → treat the pin as the requested account (before the existing 0/1/2+ branching) |
| `src/commands/doctor.ts` | `account_lock` in the output; the existing `write_protection: enabled — writes require --account` line gets the same treatment as home's |

`auth accounts`/`login`/`revoke` keep operating on the whole store — the pin gates which
account commands *act as*, not which accounts may exist.

### 4. Help text

`auth --help` documents `GWS_AXI_ACCOUNT` under an `environment:` block plus a `notes:`
block for the accident-vs-security-boundary caveat. This is the one place a reader finds the
variable without already knowing it exists.

**Amended**: there is no "shared flags block" — each of ~25 help strings is hand-written with
its own `flags[N]` count. Editing all of them would inflate every help screen for a variable
most callers never set, and each edit is a chance to leave a stale count (a hazard
[`calendar-time-ranges`](calendar-time-ranges.md) already hit). Only the **write** commands'
`--account <email>  REQUIRED when 2+ accounts are authenticated` lines are edited, because the
pin makes that statement *false* — a correctness fix, not discoverability. Read-command help
is left alone: under a pin, `ACCOUNT_LOCKED`'s message explains the situation at the moment
it matters, which is the contextual-help contract
([principles.md#contextual-help-suggestions](../specs/principles.md#contextual-help-suggestions)).

### 5. Tests — `src/google/account.test.ts` (new)

`resolveAccount` has no test file today; this adds one covering the pin *and* the
pre-existing branches it reorders, so the reordering is guarded.

- Existing matrix preserved: 0 accounts, `--account` valid/invalid, single account,
  2+ accounts read/write with and without a default.
- Pin: no `--account`; `--account` same (normalization-insensitive: `Alice@X` vs
  `alice@x`); `--account` different → `ACCOUNT_LOCKED`; unauthenticated pin →
  `ACCOUNT_LOCK_INVALID`; unset and whitespace-only both behave as no pin.
- Pin + `mutation: true` + 2 accounts + no `--account` → resolves (write-protection
  satisfied), the single most important assertion in the file.
- Pin overrides a *different* `default_account` without rewriting `config.json`.
- `accountHeaderFields`: `env` emitted with 1 account and with 2+; `default` only for
  `source: "default"` with 2+; nothing for `flag`/`single`.

Env manipulation follows `src/commands/auth.test.ts`'s save/restore-in-`beforeEach`/`afterEach`
pattern already used for `XDG_CONFIG_HOME`, over a temp config dir.

## Validation

- [x] `bun run build` (tsc) passes; `bun run test` green including the new `account.test.ts`.
- [x] With 2 accounts authenticated and no pin, account *resolution* is unchanged (reads
      use the default, writes still raise `ACCOUNT_REQUIRED`), and the only output change is
      the newly-emitted `account_source: default` line. **Amended** from "behavior is
      byte-identical to before": `account_source` turned out never to have been wired (see
      below), and emitting it is a spec-conformance fix this plan cannot avoid making, since
      the pin's disclosure rides the same mechanism.
- [x] `GWS_AXI_ACCOUNT=<b> gws-axi calendar events --today` acts as `<b>` while
      `default_account` is `<a>`, emits `account_source: env`, and leaves `config.json`
      unmodified.
- [x] A mutation under a pin with 2+ accounts and no `--account` succeeds — verified on a
      real write (`calendar create` into a scratch event, then `calendar delete`).
- [x] `GWS_AXI_ACCOUNT=<b> gws-axi calendar events --account <a>` → `ACCOUNT_LOCKED`, and
      the message names both accounts and the variable.
- [x] `GWS_AXI_ACCOUNT=<b> gws-axi calendar events --account <b>` succeeds (agreement is
      not conflict).
- [x] `GWS_AXI_ACCOUNT=nobody@example.com gws-axi calendar events` → `ACCOUNT_LOCK_INVALID`
      with an `unset GWS_AXI_ACCOUNT` suggestion — **not** a silent fall back to the default.
- [x] `GWS_AXI_ACCOUNT= gws-axi calendar events` (empty value) behaves exactly as unset.
- [x] `account_source: env` appears with only one account authenticated.
- [x] `gws-axi --summary`, `gws-axi auth accounts`, `gws-axi auth status`, and
      `gws-axi doctor` each report `account_lock: <email> (GWS_AXI_ACCOUNT)` under a pin,
      and none of them claims writes still require `--account`.
- [x] `gws-axi auth use <a>` under a pin to `<b>` writes the default and says the pin
      overrides it here.
- [x] `GWS_AXI_ACCOUNT=<b> gws-axi auth login --no-wait` targets `<b>` without `--account`,
      and `auth login --account <a> --no-wait` under that pin is still allowed.
- [x] `gws-axi auth --help` documents the variable, and every **write** command's
      `--account` help line no longer claims the flag is unconditionally REQUIRED.
      **Amended** from "`gws-axi calendar events --help` and `gws-axi auth --help` document
      the variable" — read-command help is deliberately left alone; see Approach § 4.

## Risks / unknowns

- **Reordering `resolveAccount` touches every command.** The pin is checked before
  `--account` validation, so an unauthenticated `--account` under a pin now reports
  `ACCOUNT_LOCKED` rather than `ACCOUNT_NOT_FOUND`. That is the correct precedence (the lock
  is the governing fact), but it is a behavior change on an existing path — hence the
  no-pin regression criterion above, and porting the full pre-existing matrix into the new
  test file rather than only testing what's new.
- **`explicit: boolean` → `source` is a breaking shape change** on an exported interface.
  Only `accountHeaderFields` reads it today, but the grep must be exhaustive before the
  field is removed; a stale `.explicit` would silently read `undefined` (falsy) and
  mislabel headers rather than failing to compile — check for `explicit` in destructuring
  patterns, not just property access.
- **`account_source` was dead code, discovered mid-plan.** `accountHeaderFields` computed
  the line but nothing called it: every dispatcher hands its handler only
  `resolution.account` (a string), and handlers render the `account:` line themselves, so
  the resolution never left the dispatcher.
  [principles.md#self-describing-account-header](../specs/principles.md#self-describing-account-header)
  has been unimplemented since it was written. The pin's disclosure requirement cannot be met
  without fixing it, so this plan does — via `withAccountSource` splicing the line into the
  handler's rendered output at the dispatcher, rather than threading an `AccountResolution`
  through ~50 handler signatures. Side effect: `account_source: default` now appears for the
  first time on implicit 2+-account reads, which is what the spec always required.
- **Disclosure surfaces are hand-maintained.** Six places must learn about the pin, and a
  missed one becomes a surface that confidently reports the *wrong* account context — worse
  than not mentioning it. Mitigated by making the check one exported helper call, not
  re-derived `process.env` reads.
- **`auth login`'s pin fallback interacts with `ACCOUNT_MISMATCH`.** If the user signs into
  a different Google account than the pin, the existing ID-token check must still fire and
  refuse ([principles.md#authoritative-identity-from-id-token](../specs/principles.md#authoritative-identity-from-id-token));
  the pin supplies the *expectation*, it must not become the recorded identity.
- **Being honest that this isn't a sandbox.** The feature will read like a security control
  to anyone skimming. The spec says plainly that it isn't and points at scoped
  `XDG_CONFIG_HOME`; the README recipe must lead with the pairing rather than presenting the
  pin alone as containment.

## Notes

- **`account_source` had never been emitted, by anything.** `accountHeaderFields` computed
  the line and had zero production call sites: dispatchers hand handlers only
  `resolution.account` (a string), handlers render `account:` themselves, and the
  `AccountResolution` never left the dispatcher. So
  [principles.md#self-describing-account-header](../specs/principles.md#self-describing-account-header)
  was unimplemented from the day it was written, and nobody noticed because the missing line
  looks exactly like the (correct) single-account case. Found only because the pin's own
  disclosure rides the same mechanism. `specs/architecture.md` credited
  `accountHeaderFields` for the behavior and has been corrected to describe
  `withAccountSource`. **Lesson worth generalizing: a spec clause whose absence is invisible
  in the common case needs a test, not a reviewer.**
- **The splice, not a signature change.** Fixing it "properly" meant threading an
  `AccountResolution` through ~50 handlers. `withAccountSource(resolution, output)` inserts
  the line after the rendered `account:` line at the dispatcher instead — six call sites, no
  handler churn. It matches on `startsWith("account:")` rather than a substring so a
  `help[]` line mentioning `--account:` can't be mistaken for the header, and prepends when a
  handler renders no account line at all.
- **`account_source: default` is new user-visible output** on implicit 2+-account reads. It
  is what the spec always required, but it is a change to every such response, and worth
  knowing if any downstream parser assumed a fixed header shape.
- **The pin is checked before `--account` validation**, so under a pin an unauthenticated
  `--account` reports `ACCOUNT_LOCKED`, not `ACCOUNT_NOT_FOUND`. Deliberate: the lock is the
  governing fact and the flag would have been refused either way. Covered by a test named for
  the precedence so a future reorder trips it.
- **A broken pin shows no `account:` line in the home view.** The first cut printed the
  default account beside the "NOT AUTHENTICATED" warning, which reads as a working
  fallback — the precise misreading the loud-failure rule exists to prevent. It now reports
  the lock and `authenticated_accounts[]` only.
- **`gws-axi --summary` is rejected by the SDK arg parser** ("Flags must come after the
  command") — pre-existing, unrelated to this work. The SessionStart hook actually runs bare
  `gws-axi` (the home view), which does report the pin; `doctor --summary` is the other
  summary path and also reports it. `specs/architecture.md` and `docs/design.md` both say the
  hook runs `gws-axi --summary`; see Follow-ups.
- **`doctor --summary` exits 0 even on a failing check**, including a broken pin, because
  summary mode returns before `process.exitCode` is set. Pre-existing and plausibly
  deliberate (a SessionStart hook shouldn't fail a session); left alone. Full `doctor` does
  exit 1 on a broken pin, verified.
- **Verified live against two real accounts** (`chris@jarv.us` default, `themightychris@gmail.com`
  pinned), including a real `calendar create` under a pin with no `--account` — the write
  landed on the non-default account and was deleted afterward. `config.json` confirmed
  unmodified throughout.
- **`account_source: env` with exactly one account authenticated is unit-verified only** —
  this machine has two accounts. The path is account-count-independent by construction
  (`accountSourceLabel` returns `"env"` on source alone), and both `accountHeaderFields` and
  `withAccountSource` are tested at `totalAccounts: 1`.

## Follow-ups

- Issue — `specs/architecture.md` § SessionStart hook and `docs/design.md` both state the hook
  runs `gws-axi --summary`, but that invocation is rejected by the SDK arg parser and the
  installed hook runs bare `gws-axi`. Spec drift predating this plan; not touched here
  because it belongs to the `setup hooks` surface, not account resolution.
- Issue — `doctor --summary` returns exit 0 regardless of failing checks (summary mode returns
  before `process.exitCode` is set). Worth an explicit decision recorded in
  `specs/commands/setup.md`: either it is deliberate (hooks must not fail sessions) and the
  spec should say so, or it is a bug.
- Tracked as: a scoped-`XDG_CONFIG_HOME` recipe for provisioning an agent's config dir with a
  single account's tokens. Documented conceptually in README and `docs/design.md`, but there
  is no command that *builds* such a directory — today it is a manual copy. Add one only if
  the pattern gets used enough to earn the surface.
- Tracked as: no per-service pin (`GWS_AXI_CALENDAR_ACCOUNT`) and no third environment
  variable, by design — `principles.md#env-pins-context-never-expands-capability` caps the
  surface at two, and raising the cap is a spec change first.
