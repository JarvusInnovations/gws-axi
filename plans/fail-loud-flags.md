---
status: done
depends: []
specs:
  - specs/principles.md
  - specs/api/conventions.md
pr: 99
---

# Plan: fail loud on unknown flags, everywhere

## Scope

Apply AXI principle 6 (kunchenguid/axi#63) to every gws-axi command. Before this, the commands
built on the chat parser and four hand-rolled checks validated flags; about 30 older handlers,
`auth`, and `doctor` dropped unknown flags silently, and calendar `--fields` skipped unknown
names.

## Implements

- `specs/principles.md#fail-loud-on-unknown-flags`
- `specs/api/conventions.md` § Unknown flags

## Approach

1. Move the shared parser to `src/util/flags.ts`; add `checkFlags`, per-flag `hints`,
   `noAccount`, and `parseFieldList`.
2. Every dispatcher entry declares `flags` (a spec, or `"self"` when its handler parses with
   `parseArgs`); dispatchers run `checkFlags` before resolving the account. Older handlers keep
   their parsers untouched.
3. `auth` declares per subcommand; `doctor` checks at the top.
4. Calendar `events` / `search` / `calendars` `--fields` refuse unknown names.

## Validation

- [x] Test: every handled subcommand declares flags; each declared spec equals the flags its
      `--help` documents; each rejects an unknown flag. `auth` and `doctor` reject unknown flags.
- [x] The help comparison found and fixed: `drive activity --recursive` (undocumented alias of
      `--folder`), `slides`/`sheets comments --full`/`--limit` (accepted, undocumented), and the
      label ops accepting each other's flags.
- [x] Live: `gmail search --querry`, `calendar events --fields colour`, `drive ls --recurse`,
      `auth login --url` (hint), `doctor --fix`, `slides comments --bogus` all exit 2 with the valid
      flags; `calendar events --single-events --today` and `drive ls -r` still work.
- [x] build, lint, format:check, test.

## Risks / unknowns

- A caller passing a stray flag that used to be ignored now gets exit 2. That is the point.

## Notes

- `--single-events` takes an optional value; it is declared boolean so a bare
  `--single-events` passes, and the handler still consumes a following `true`/`false`.
- Single-dash short flags (`-r` on `drive ls`) are positionals to the shared parser and are
  handled by their command; an unknown short flag is not caught.

## Follow-ups

- Tracked as: propose a flag-declaration helper to `axi-sdk-js` (draft for the owner to post).
