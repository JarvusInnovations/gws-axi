---
status: done
depends: [docs-markdown-write]
specs:
  - specs/commands/docs-read.md
issues: [84]
---

# Plan: docs read — disclose tasks, render image alt text

## Scope

Two read-side gaps found while filing the Docs API gap issues: `docs read` rendered every
checklist item as `- [ ]` with nothing saying the state is unknown, and rendered every image as
a bare `[image]` although `documents.get` returns its alt text.

## Implements

- `specs/commands/docs-read.md` § Content.

## Approach

`renderBodyAsMarkdown` takes the tab's `inlineObjects` and reports `task_count`; `read.ts`
passes them through and adds the help line.

## Validation

- [x] Unit: alt text rendered when present, bare `[image]` otherwise; tasks counted.
- [x] Live: the importer probe Doc reads `[image: alt text]` and "2 checklist items rendered
      as `- [ ]`…".
- [x] build, lint, test.

## Risks / unknowns

None.

## Notes

The help line keeps #84 open in practice: it stays until the API exposes the checked state.

## Follow-ups

None.
