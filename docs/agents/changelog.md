# Changelog

`CHANGELOG.md` is the release history. Record every user-visible change under `## Unreleased` in the same change that introduces it.

## Update triggers

Update the changelog when a change affects:

- extension behavior or failure semantics;
- supported Pi, model, API, or provider compatibility;
- installation, requirements, or configuration;
- compaction protocol or persisted session data;
- user-visible cost, performance, or data handling;
- a known limitation or its resolution.

Internal refactors, tests, benchmark execution, and documentation-only changes do not need an entry unless they alter one of these user-visible contracts.

## Procedure

1. Read the existing `## Unreleased` entries before editing.
2. Add or amend a concise bullet describing the observable change and its consequence.
3. Follow the existing lowercase bullet style and avoid duplicating another entry.
4. Keep released sections immutable; corrections and follow-up behavior belong under `## Unreleased`.

Before completing a task, account for every user-visible change in the diff with an `Unreleased` entry. If no trigger applies, leave `CHANGELOG.md` unchanged.
