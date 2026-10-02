# Command group: slides skip, slides unskip

## Summary

Hide slides in presentation mode, or show them again — the editor's *Skip slide* — from issue
#64. The first Slides write that is not a stub. A skipped slide stays in the deck and in every
read ([slides-read.md](slides-read.md) marks it); only presenting passes over it.

## Invocation

```
gws-axi slides skip   <presentation-id> <page-id>... [--account <email>]
gws-axi slides unskip <presentation-id> <page-id>... [--account <email>]
```

Slides are named by `page_id`, as `slides get` lists them — never by position, which shifts as
slides are added or moved. Repeated ids count once.

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| `presentations.get` returns `slideProperties.isSkipped` on skipped slides | **Observed 2026-10-02** |
| `batchUpdate` `updateSlideProperties` with `slideProperties.isSkipped` and `fields: "isSkipped"` sets and clears it | Observed |
| The existing `presentations` scope covers the write | Observed |

## Behavior

- One `presentations.get` decides which named slides are not already in the requested state;
  only those are written, in one `batchUpdate`. **Idempotent**: when none need a change,
  `action: unchanged` and nothing is written.
- Any unknown `page_id` is `PAGE_NOT_FOUND` before anything is written.

## Output

```
account: alice@example.com
action: skipped
changed: 1 of 2
slides[2]{index,page_id,title,skipped}:
  4,g2a1b_0_12,Backup: pricing,✓
  7,g2a1b_0_19,Appendix,✓
help[2]:
  Run `gws-axi slides get 1DeCk…` to see every slide's state
  Run `gws-axi slides unskip 1DeCk… g2a1b_0_12 --account alice@example.com` to undo
```

`action` is `skipped` / `unskipped` when anything changed, else `unchanged`. The table lists
every slide named, in the order given, with its state after the call. The undo line names only
the slides this call changed.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | No presentation id, no page id, or an unknown flag |
| `PRESENTATION_NOT_FOUND` | Unknown deck or no access |
| `PAGE_NOT_FOUND` | A `page_id` not in the deck; nothing is written |
| `FORBIDDEN` (translated) | No edit access |

## Principles

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account) — `mutation: true`.
- [ids-are-first-class](../principles.md#ids-are-first-class) — slides are addressed by `page_id`.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — the undo command
  names exactly what changed.
