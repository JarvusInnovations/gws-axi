# Command: setup

Explicit, discoverable installation of the SessionStart hook that makes the gws-axi home view (Google Workspace state — authenticated accounts, write-protection status, setup/health) ambient. This is the **only** way the hook is installed: hooks register only from a user-invoked setup command, never as a side effect of ordinary commands, and there is no env toggle. Mirrors the first-party reference tools (`gh-axi`, `chrome-devtools-axi`) and the sibling AXIs (`slack-axi`, `harvest-axi`): a single `setup hooks` action that installs or repairs, nothing more.

## Invocation

`gws-axi setup hooks`

This is a top-level command (`setup`) with a single `hooks` action. It is NOT a `(account, args)` service handler — it takes no account and touches no Google API; its handler is `setupCommand(args: string[]) => Promise<string>`.

## Subcommands

- `setup hooks` — install or repair the SessionStart hook across Claude Code (`~/.claude/settings.json`), Codex (`~/.codex/hooks.json` + `config.toml`), and the OpenCode ambient-context plugin. Idempotent (re-running with the same resolved command is a silent no-op) and self-repairing (updates the command if the executable path changed). Delegates entirely to the SDK's `installSessionStartHooks({ marker: "gws-axi", timeoutSeconds: 10 })`.
- `setup --help` / `setup hooks --help` — print the reference (`SETUP_HELP`).
- Any other action → `VALIDATION_ERROR` pointing at `gws-axi setup hooks`.

There is no `status` or `uninstall` subcommand: those are not part of the AXI standard or SDK, and the first-party tools don't provide them. Re-running `setup hooks` repairs; removal is a manual settings.json edit.

## Output

```
hooks:
  status: installed
  integrations: Claude Code, Codex, OpenCode
  marker: gws-axi
help[1]:
  Restart your agent session to receive gws-axi ambient context
```

On any SDK-reported problem (collected via `onError`), fail with a `HOOK_INSTALL_FAILED` error carrying the underlying messages.

## Errors

- Unknown / missing action (anything but `hooks`) → `VALIDATION_ERROR` with a `Run \`gws-axi setup hooks\`` suggestion.
- SDK-reported install problems → `HOOK_INSTALL_FAILED` carrying the collected messages.

## Registration

`setup: setupCommand` in the `runAxiCli` `commands` map; `setup: SETUP_HELP` in `COMMAND_HELP`; `setup` in the `TOP_HELP` command list and an example line `gws-axi setup hooks`. `runAxiCli` is called with NO `hooks` option — the SDK does not auto-install, so the hook only ever appears via this command.

## Principles

**Inherited** — see [`../principles.md`](../principles.md):

- [structured-errors-to-stdout](../principles.md#structured-errors-to-stdout) — validation and install failures alike are `AxiError` on stdout.
- [toon-over-json](../principles.md#toon-over-json) — the `hooks:` block + `help[]` render as TOON.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — points the user at the restart needed to pick up ambient context.
