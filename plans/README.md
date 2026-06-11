# Plans

`specs/` describes **state** (what should be true). `plans/` describes **motion** (how we get there next). Each file here is one scope-bounded chunk of work: its scope, the specs it implements, its dependencies on other plans, and concrete validation criteria. Together the plan files form a micro-DAG bridging specs to merged code.

Plans are temporal. Once merged, a plan freezes as historical record — its merged-PR link plus completed validation boxes become the project's memory of what got built and what was deferred.

## Workflow

1. Update or add the relevant `specs/` first (their own change/review).
2. Add a plan declaring how to bring the code to the spec (`status: planned`).
3. Implement; flip to `in-progress`.
4. Close out: the last commit before merge flips `status: done`, adds `pr:`, checks the verified Validation boxes, and fills Notes + Follow-ups.

## Statuses

`planned` → `in-progress` → `done` (frozen). Edge cases: `blocked`, `cancelled`.

## Querying the DAG

Don't hand-maintain a diagram or status table here — it rots. The specops CLI reads the authoritative frontmatter on demand:

- `.agents/skills/specops/scripts/specops` — this repo's plans dashboard (ready / blocked / recently done).
- `.agents/skills/specops/scripts/specops next` — what's ready to work on next.
- `.agents/skills/specops/scripts/specops dag` — Mermaid graph of the DAG.

The full protocol (frontmatter schema, body template, closeout ritual, Follow-ups taxonomy) is in `.agents/skills/specops/references/plans-protocol.md`. Read it before authoring or closing out a plan.
