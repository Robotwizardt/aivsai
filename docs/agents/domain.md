# Domain Docs

This repository uses a single-context domain documentation layout.

## Before exploring, read these

- Root `CONTEXT.md`: the project's domain vocabulary.
- `docs/adr/`: decisions relevant to the area being explored.

If these files do not exist, proceed silently. Do not flag their
absence or suggest creating empty placeholders.

The `/domain-modeling` skill, including when invoked through
`/grill-with-docs`, creates them lazily when terms or decisions
are actually resolved.

## File structure

- `CONTEXT.md`: shared domain glossary at the repository root.
- `docs/adr/`: architectural decision records, numbered sequentially
  with descriptive filenames such as `0001-<decision-slug>.md`.

## Use the glossary's vocabulary

When naming domain concepts in issue titles, proposals, hypotheses,
tests, or code, use the terms defined in `CONTEXT.md`.
Do not drift to synonyms the glossary explicitly avoids.

If a needed concept is missing, reconsider whether the proposed term
fits the domain. Note genuine gaps for `/domain-modeling`.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, identify the conflict
explicitly and explain why reopening that decision may be worthwhile.
Do not silently override recorded decisions.
