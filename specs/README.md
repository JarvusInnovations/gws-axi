# gws-axi Specs

These specs declare the complete desired state of `gws-axi` — an agent-ergonomic Google Workspace CLI built to the [AXI standard](https://axi.md). They are the source of truth for what the tool should do. Implementation follows spec; all work begins with a spec update.

## Spec-First Workflow

1. **Spec change** — Propose a change to the relevant spec file(s). A review conversation, not a code change.
2. **Accept** — Reviewer approves. The spec now describes a state the implementation does not yet match.
3. **Implement** — Bring the code into conformance with the spec.
4. **Verify** — Compare the running CLI to the spec. If they match, the work is done.

Code with no corresponding spec is unspecified behavior — it may exist for practical reasons, but the spec doesn't guarantee it. Spec with no corresponding code is a known gap — a `plans/` entry should track it.

## How Agents Use These Specs

1. **Read the relevant spec first** before writing code. Every command and cross-cutting behavior has (or should have) a spec.
2. **The spec answers "what", not "how"** — what output appears, what flags exist, what rules apply. It does not dictate file layout, function names, or parsing strategy.
3. **If the spec is ambiguous, clarify the spec** — don't guess and code. Propose an amendment.
4. **If the spec is wrong, fix the spec** — don't work around it in code.
5. **When done, check your work against the spec** — every display rule, every flag, every error case.

## Directory Layout

```
specs/
├── README.md            ← you are here
├── principles.md        ← project-wide decisive principles (the "why" that resolves unspecified decisions)
├── architecture.md      ← tech stack, dispatch structure, auth/config/output/error models
├── api/
│   └── conventions.md   ← cross-command output, error, account-resolution, help[] contracts
└── commands/            ← one file per command or command group (what it does, flags, output, errors)
    └── <service>-<command>.md
```

- **principles.md** — the decisive value judgments that pick a side when two reasonable implementations conflict. Feature specs reference the relevant ones *down* into their own `## Principles` sections.
- **architecture.md** — concrete, foundational structure and model decisions (distinct from principles, which are value judgments).
- **api/conventions.md** — the contracts every command honors: TOON output shape, the canonical empty-list form, the `account:` header, `help[]` suggestions, `AxiError` shape, account resolution + write-protection.
- **commands/** — one spec per command. Declares flags, default vs `--full`/opt-in output schema, error translation, and account/write-protection behavior.

## Conventions

- Specs are declarative present-tense "what is true" statements, testable by inspecting CLI output.
- Output column lists use TOON notation, e.g. `revisions[N]{id,modified,author}`.
- A PR that changes behavior changes the spec in the same PR. Spec↔code divergence is a bug, not debt.

See `plans/README.md` for how work-in-flight is tracked, and `.agents/skills/specops/SKILL.md` for the full methodology.
