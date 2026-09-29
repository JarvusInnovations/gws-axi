---
status: done
depends: []
specs:
  - specs/architecture.md
issues: [71]
pr: 72
---

# Plan: Re-enable APIs when a release adds one

## Scope

An install that completed setup never learns about an API added afterwards. `auth setup` only
performs the first incomplete step, `apis_enabled` stays marked done with the list it recorded at
the time, and the `API_NOT_ENABLED` error advises re-running a command that will not act.

This is a pre-existing defect, surfaced while planning the Chat service (issue #71), which adds
two more APIs. It is fixed first so that Chat's rollout — and `drive activity`'s, which has been
affected since it shipped — reaches existing installs.

**In scope:**

- Staleness detection for `apis_enabled` on owned installs, and its effect on `auth setup`,
  `doctor`, and the home view.
- Join-aware `API_NOT_ENABLED` guidance.
- Narrowing the 403 → `SCOPE_MISSING` classification to real scope failures.

**Out of scope:**

- Live probing of which APIs are enabled on a joined install — it has no access to ask.
- Any change to the other six setup steps.

## Implements

- `specs/architecture.md` § Auth model — "A completed `apis_enabled` step can go stale" and its
  five consequences.
- `specs/architecture.md` § Error model — the `SCOPE_MISSING` classification rule.

## Approach

1. **One staleness predicate**, exported from the setup-state module: given the setup state,
   return the APIs in `allApis()` missing from the step's recorded `apis`. A step marked
   `via: "team-join"` returns none. Every consumer below calls this — no consumer re-derives it.
2. **`setupProgress`** treats a stale `apis_enabled` as not done, so `nextStep` lands on it and
   the `done` count drops by one. This is the single change that makes `auth setup`, the home
   view, and `auth status` agree.
3. **`advanceApisEnabled`** already enables only what is missing and rewrites the recorded list,
   so it needs no change to act correctly once reached. Confirm the no-`gcloud` branch lists the
   *missing* APIs rather than the per-service set, which omits `ADDITIONAL_APIS`.
4. **`doctor`'s setup tier** reports the stale step as `fail` with the missing APIs in `detail`.
5. **`translateGoogleError`**: the `API_NOT_ENABLED` suggestion branches on whether the install
   is joined. The 403 scope branch keys on Google's reason codes and on "insufficient … scope"
   wording, not on any message containing "scope".
6. **Tests**: the predicate (fresh, stale, joined, legacy state with no recorded list);
   `setupProgress` with a stale step; both `API_NOT_ENABLED` branches; a 403 whose message
   mentions "scope" for an unrelated reason is *not* `SCOPE_MISSING`.

## Validation

- [x] `bun run build`, `bun run lint`, `bun run format:check`, `bun run test` all pass.
- [x] On this machine's real config — whose `apis_enabled` records five APIs from April —
      `gws-axi doctor --check setup` reports `apis_enabled` failing and names every missing API.
- [x] `gws-axi auth setup` on that config enables the missing APIs and reports
      `7 of 7 steps complete`, with `setup.json` recording the full current list.
- [x] After that run, every account's tokens are untouched (`tokens.json` mtime unchanged) and
      `consent_screen`, `test_user_added`, and `tokens_obtained` keep their original `at`
      timestamps.
- [x] `gws-axi drive activity <id>` succeeds end to end for the first time, and its `range:`
      echo renders in local-offset ISO — closing the follow-up left open by
      [`calendar-time-ranges`](calendar-time-ranges.md).
- [x] A state file with `apis_enabled: { done: true, via: "team-join" }` is reported complete,
      and `API_NOT_ENABLED` against it names the distributor and contains no Console URL and no
      `auth setup` suggestion.
- [x] A second `auth setup` immediately afterwards is a no-op that reports complete.

## Risks / unknowns

- **`gcloud` may lack permission or be signed into another account.** The existing failure path
  prints the manual `gcloud services enable` command; verify it names the missing APIs only.
- **A legacy `apis_enabled` with no recorded list** must read as stale on an owned install, not
  crash and not pass. Covered by a test.
- **Home view changes for every existing user on upgrade** — setup drops to 6 of 7 until they run
  `auth setup`. That is the intended signal, but it is user-visible and belongs in the release
  notes.
- **Narrowing the scope regex could un-classify a real scope failure** whose wording differs from
  what is expected. Mitigated by keeping every reason code the branch matches today.

## Notes

- **Verified live on the real config.** `doctor --check setup` reported `apis_enabled` failing
  and named `sheets.googleapis.com` and `driveactivity.googleapis.com`. `auth setup` then
  reported 7 of 7 and recorded all seven APIs. Every other step kept its April `at` timestamp,
  all four accounts' `tokens.json` mtimes were unchanged, and a second run was a no-op that did
  not rewrite the step.
- **Only one API was actually off.** The recorded list lagged the project: Sheets had been
  enabled by hand at some point and was merely unrecorded, so the run enabled Drive Activity
  alone. That is why `doctor` says stale APIs are "not yet confirmed enabled" rather than "not
  enabled" — the record is evidence about what setup did, not about the project.
- **`drive activity` ran end to end for the first time**, three and a half months after it
  shipped, with `range: 2026-09-21T00:00:00-04:00 → 2026-09-29T00:00:00-04:00` for
  `--since -7d --until today`. This closes the follow-up left open by
  [`calendar-time-ranges`](calendar-time-ranges.md).
- **The joined criterion is verified in two halves.** A `team-join` state file was run live
  against a temporary config dir: `doctor` reported the step ok and the home view 7 of 7. The
  `API_NOT_ENABLED` half is verified by unit test only — triggering it live needs a joined
  install calling an API that is disabled on its shared project.
- **Hand-confirming the step would have made it permanently stale.** `--confirm-step
  apis_enabled` recorded no list, and an owned step with no list is stale on every API. It now
  records the list it is asserting, tagged `via: "manual-confirm"`. The no-`gcloud`
  instructions also told the user to re-run `auth setup`, which without `gcloud` could only
  print the same instructions again; they now name the confirm command.
- **`setup.html` and the no-`gcloud` instructions omitted `ADDITIONAL_APIS`.** Both built their
  list from the per-service map, so Drive Activity was never offered to anyone enabling by
  hand. Both now list what is needed.
- **Every existing install drops to 6 of 7 on upgrade** until its owner runs `auth setup`. That
  is the intended signal and belongs in the release notes.
- **Two copies of the `team-join` check** (`loopback.ts`, `setup-html.ts`) were replaced by
  `isJoinedInstall()`.

## Follow-ups

- Tracked as: `drive activity`'s `time` column renders UTC (`…Z`) while the `range:` line above
  it renders local-offset ISO. Seen on the first successful run. `specs/commands/chat-read.md`
  already requires local-offset times for chat; `drive-activity.md` is silent on the column.
- Tracked as: the People API is not enabled on the project yet. It is added to
  `ADDITIONAL_APIS` by [`chat-read`](chat-read.md), at which point this plan's staleness check
  is what gets it enabled — the first real "a release added an API" run.
