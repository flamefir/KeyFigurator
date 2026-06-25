# docs/ — durable knowledge

One file per **doc**: something learned, analyzed, or decided. A worked-through artifact:
analysis, writeup, decision + rationale, how-it-works note.

## Frontmatter
```yaml
---
kind: doc
domain: []
status: draft | adopted | superseded   # optional
links: []
---
```
Optionally add `type:` (analysis | decision | learning). Body = what's true now + optional
`## Timeline` for what happened. Naming: `<short-kebab-slug>.md` or `<TOPIC>-<YYYY-MM>.md`.
