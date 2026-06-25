# signals/ — evidence

One file per **signal**: feedback, an idea, or an observation worth remembering. Signals are
deduped and frequency-counted — on recurrence, add a Timeline entry and bump `frequency`.

## Frontmatter
```yaml
---
kind: signal
category: feedback | idea | friction | observation
frequency: 1
sources: []
domain: []
status: open | triaged | actioned | closed
---
```
Body = short statement + optional append-only `## Timeline`. `frequency` = Timeline entries.
Naming: `<short-kebab-slug>.md` or `FB-<n>.md`.
