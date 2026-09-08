---
status: in-progress
depends: []
specs:
  - specs/api/conventions.md
  - specs/architecture.md
  - specs/principles.md
issues: []
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

`--account`'s description in the shared flags blocks gains a clause about the pin, and
`auth --help` documents `GWS_AXI_ACCOUNT` under a short `environment:` block. This is the
only place a reader finds the variable without already knowing it exists.

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

- [ ] `bun run build` (tsc) passes; `bun run test` green including the new `account.test.ts`.
- [ ] With 2 accounts authenticated and no pin, account *resolution* is unchanged (reads
      use the default, writes still raise `ACCOUNT_REQUIRED`), and the only output change is
      the newly-emitted `account_source: default` line. **Amended** from "behavior is
      byte-identical to before": `account_source` turned out never to have been wired (see
      below), and emitting it is a spec-conformance fix this plan cannot avoid making, since
      the pin's disclosure rides the same mechanism.
- [ ] `GWS_AXI_ACCOUNT=<b> gws-axi calendar events --today` acts as `<b>` while
      `default_account` is `<a>`, emits `account_source: env`, and leaves `config.json`
      unmodified.
- [ ] A mutation under a pin with 2+ accounts and no `--account` succeeds — verified on a
      real write (`calendar create` into a scratch event, then `calendar delete`).
- [ ] `GWS_AXI_ACCOUNT=<b> gws-axi calendar events --account <a>` → `ACCOUNT_LOCKED`, and
      the message names both accounts and the variable.
- [ ] `GWS_AXI_ACCOUNT=<b> gws-axi calendar events --account <b>` succeeds (agreement is
      not conflict).
- [ ] `GWS_AXI_ACCOUNT=nobody@example.com gws-axi calendar events` → `ACCOUNT_LOCK_INVALID`
      with an `unset GWS_AXI_ACCOUNT` suggestion — **not** a silent fall back to the default.
- [ ] `GWS_AXI_ACCOUNT= gws-axi calendar events` (empty value) behaves exactly as unset.
- [ ] `account_source: env` appears with only one account authenticated.
- [ ] `gws-axi --summary`, `gws-axi auth accounts`, `gws-axi auth status`, and
      `gws-axi doctor` each report `account_lock: <email> (GWS_AXI_ACCOUNT)` under a pin,
      and none of them claims writes still require `--account`.
- [ ] `gws-axi auth use <a>` under a pin to `<b>` writes the default and says the pin
      overrides it here.
- [ ] `GWS_AXI_ACCOUNT=<b> gws-axi auth login --no-wait` targets `<b>` without `--account`,
      and `auth login --account <a> --no-wait` under that pin is still allowed.
- [ ] `gws-axi calendar events --help` and `gws-axi auth --help` document the variable.

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

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
