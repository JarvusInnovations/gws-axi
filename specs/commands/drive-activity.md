# Command: drive activity

## Summary

Reports an attributed, timestamped activity timeline for a Drive file or folder using the Drive Activity API v2 — create, edit, move, rename, delete, restore, permission changes, and comments. This is richer than `drive revisions` (which only lists saved content versions): it answers "who did what, when" across actions revisions never capture.

Requires a new read-only scope, so it ships behind a one-time re-auth.

## Invocation

`gws-axi drive activity <itemId> [flags]`

- `<itemId>` — a Drive file or folder ID. By default, activity for that single item.

## Flags

- `--folder` / `--recursive` — treat `<itemId>` as an ancestor: report activity for the folder and all descendants (`ancestorName` query) rather than the single item (`itemName`). (One flag name; spec uses `--folder`.)
- `--since <date>` / `--until <date>` — bound the time range. Map to the Activity API `time` filter (RFC 3339 / accepts the same dateish parsing as calendar commands).
- `--action <type[,type...]>` — filter to specific action types (`create`, `edit`, `move`, `rename`, `delete`, `restore`, `permission_change`, `comment`, …). Maps to the `detail.action_detail_case` filter.
- `--limit <n>` — max activities (default 50). Paginates internally on `pageToken`.
- `--account <email>` — account override.

## Data Requirements

- Drive Activity API v2 `activity.query` (POST `https://driveactivity.googleapis.com/v2/activity:query`). Body: `itemName: "items/<id>"` OR `ancestorName: "items/<id>"`, optional `filter` (`time` + `detail.action_detail_case`), `pageSize`, `pageToken`.
- **New scope** `https://www.googleapis.com/auth/drive.activity.readonly` — read-only, NOT implied by `auth/drive`. Added to `ADDITIONAL_SCOPES` in `src/auth/scopes.ts` (same pattern as `gmail.settings.basic`). Pre-existing accounts must re-auth once; the scope is incremental on the already-restricted `auth/drive` footprint so it doesn't worsen the consent/verification posture.
- Required API: `driveactivity.googleapis.com` — added to `ADDITIONAL_APIS`, so `allApis()` includes it and the `auth setup` API-enablement step enables/checks it alongside the per-service APIs. (The per-account runtime `probe.ts` health check keys off the five representative `SERVICE_SCOPES` only and does not separately probe this API; an api-not-enabled 403 at call time is translated to `API_NOT_ENABLED` with enablement guidance.)

## Display Rules

Header: `item{id,scope}` where `scope` is `item` or `ancestor`.

List, **newest first**:

```
activities[N]{time,action,actor,target}
```

- `time` — the activity timestamp (or the end of its `timeRange`).
- `action` — the primary action type, normalized to a short label. Filterable types: `create`, `edit`, `move`, `rename`, `delete`, `restore`, `permission_change`, `comment`. Additional labels surfaced in output but not selectable via `--action`: `dlp_change`, `reference`, `settings_change`, `applied_label_change`. An activity bundling multiple actions lists the primary one.
- `actor` — best-effort identity. The API returns `actor.user.knownUser.personName` = `people/<id>`, not an email; v1 emits that raw `people/<id>` string as the stable identifier (no People API round-trip — resolving to email is out of scope, see below). Other actor types map to stable labels: `deleted-user`, `unknown-user`, `anonymous`, `impersonation`, `administrator`, `system`. Never blank, never fabricated.
- `target` — the affected item, rendered `"<title> (<id>)"` when both are known, else whichever is present. The item id (`driveItem.name` → `<id>`) is always kept reachable per [principles.md#ids-are-first-class](../principles.md#ids-are-first-class); never truncated.

### Visibility disclosure (required)

Append a `note` / `help[]` line: results are limited to activity visible to the authenticated account — items never shared with this account contribute no history. This honors [principles.md#surface-completeness-limits](../principles.md#surface-completeness-limits).

### help[] suggestions

- Widen with `--folder` (when not already in folder scope); in folder scope, narrow with `--action`.
- Bound the window with `--since`/`--until` when neither is set.
- Fetch an item surfaced here with `gws-axi drive get <id>` / `docs download <id>`.
- Cross-reference content versions with `gws-axi drive revisions <id>`.

## Errors

- Missing scope (403 insufficient) → translated with a suggestion to re-run `auth login` to grant `drive.activity.readonly` (re-auth path).
- API not enabled → doctor surfaces it; runtime 403 translated with enablement guidance.
- Unknown item / no access → `NOT_FOUND` re-wrap with access-check suggestion.

## Dispatcher

New `drive` read subcommand `{ name: "activity", mutation: false }`. Read-only.

## Out of scope (v1)

- Resolving every actor to a verified email (People API resolution is best-effort; consumer/anonymous actors may be unresolvable).
- Org-wide audit across users (that needs admin-only Reports API; out of reach on a single consented account — see [project: exploration track]).

## Principles

**Inherited:**

- [ids-are-first-class](../principles.md#ids-are-first-class) — target ids are the handoff to `drive get` / `docs download`; never truncate.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — state the per-account visibility ceiling explicitly.
- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — querying activity is pure; the scope requested is `.readonly`.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — suggest the narrowing/cross-referencing next steps with real ids.
