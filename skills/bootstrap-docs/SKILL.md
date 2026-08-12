---
name: bootstrap-docs
description: Bootstrap the standard agent-maintained documentation system onto a project/migrate legacy documentation into the target structure.
disable-model-invocation: true
---

# Bootstrap documentation system

Set up the standard documentation system on this project. It is
**agent-maintained** but human-readable. Adapt all content to this project and
never copy another project's specifics.

## Guiding principle

Only document what an agent **cannot quickly recover by reading the code**.
Code is the source of truth for *what the code does*. Docs exist for *where
things live* (MAP) and *why major tradeoffs were made* (DECISIONS). Everything
else rots, so do not write it.

## Target structure

- `AGENTS.md` — universal entry point: principle, hard guardrails,
  read-routing, event-based write triggers, the DECISIONS entry bar, the
  CONVENTIONS-vs-DECISIONS boundary, todos↔decisions rule, and Definition of
  Done.
- `context/MAP.md` — module structure + data flow (mermaid where useful). The
  "where things live" map.
- `context/DECISIONS.md` — curated ADR file for durable, non-obvious
  project-level choices (context / decision / tradeoff / status). Not a
  changelog, worklog, or implementation journal.
- `context/CONVENTIONS.md` — terse imperative code rules with **zero
  rationale**. Read while writing code.
- `README.md` — what the project is and how to run/use it. Agent-maintained
  from now on.
- **No CHANGELOG** — git history is the changelog.

Use the folder name `context/` (no leading dot). Never use a hidden/dot folder
for these docs: `rg` skips hidden files by default, which would hide the
most-read docs from the most-used search tool. Detect legacy documentation directories and migrate their contents into the target `context/` directory. In particular, if the former `.context/` layout exists, run `git mv` to `context/` and fix references.

## Decision-log bar

`context/DECISIONS.md` is a curated ADR file, not an append-only dumping ground.
Append a decision only when all of these are true:

- The choice changes architecture, public behavior, data shape, dependency
  ownership, or an irreversible/expensive migration path.
- A future agent is likely to choose a different plausible path without the
  rationale.
- The rejected alternative and its cost are non-obvious from code.
- The decision will still matter after the current branch/task is merged.

Do not append decisions for bug fixes, cleanup, dead-code removal, renames,
mechanical refactors, implementation tactics inside one feature, or test/lint
chores unless they establish a durable project standard. Do not record “we chose
X over Y” when Y is merely the default opposite of X.

Before appending, check whether an existing decision should be amended or marked
superseded instead. When in doubt, do not append; keep task-local rationale in
the todo body, PR, commit message, or final response.

## Steps

1. Survey the repo: read any existing `AGENTS.md`, `context/*` (and legacy
   `.context/*`), `README.md`, `GEMINI.md`/`CLAUDE.md`, plus build/tool config
   (for example `pyproject.toml`, `package.json`) and the source tree. Detect
   the real tooling, commands, and module layout.
2. **Mine, don't discard.** Before deleting old docs, extract genuine decisions
   that cross the decision-log bar into `DECISIONS.md` and genuine imperative
   rules into `CONVENTIONS.md`. Status/feature lists, changelog-style entries,
   bug fixes, cleanup, and implementation notes are not worth keeping — git,
   todos, PRs, and code already cover them.
3. Create or rewrite the five files above with project-accurate content. Seed
   `DECISIONS.md` only with decisions that cross the decision-log bar (each
   entry: context, decision, tradeoff, status). If none exist yet, leave only a
   header + format example.
4. Make `CONVENTIONS.md` pure imperatives. Test each line: if it needs a
   "because", it may be a decision; move rationale to `DECISIONS.md` only if it
   crosses the decision-log bar. Otherwise keep the convention terse.
5. Remove redundant or obsolete legacy documentation after mining its durable
   content. Do not retain parallel legacy documentation artifacts. Fold useful
   project guidance from generic tool-specific files such as `GEMINI.md` and
   `CLAUDE.md` into `AGENTS.md` so it is the single universal guide. Use
   `git mv`/`git rm` when the repo is git-tracked.
6. Fix all cross-references after renames or deletes (grep old filenames).
7. **Set up linting/formatting.** Ensure the project has a linter + formatter
   appropriate to its stack (for example `ruff` for Python,
   ESLint + Prettier for JS/TS, `clippy`/`rustfmt` for Rust). If none exists, add and configure it; if one
   exists, keep it. Add standard run commands to `CONVENTIONS.md` as
   imperatives (lint, format, test) and verify they run. Wire into pre-commit
   or CI only if the project already uses those.
8. **Set up Markdown linting** (always, because these docs are Markdown). Add
   `markdownlint` (for example `pymarkdownlnt` or `markdownlint-cli2`) with sensible config, and
   ensure `AGENTS.md`, `README.md`, and everything under `context/` pass. Add
   the lint command to `CONVENTIONS.md`. Lint and fix docs you created so they
   start clean.

## AGENTS.md must contain

Keep `AGENTS.md` concise. It is a routing and guardrail file, not the place for
long rationale. Target these sections:

- **Guardrails**: no direct commits to the default branch; work on a branch/open
  a PR; keep changes scoped; verify behavior before documenting claims.
- **Read routing**: MAP before layout/data-flow changes; DECISIONS before
  changing a recorded tradeoff; CONVENTIONS while coding; `todo list` at task
  start and `todo claim <id>` before editing orchestrated todos.
- **Write triggers**: MAP for module/data-flow changes; DECISIONS only for
  choices crossing the decision-log bar; CONVENTIONS for repeatable rules;
  README for user-facing setup/usage changes.
- **Decision-log bar**: compressed wording is fine, but it must say DECISIONS is
  a curated ADR file, not a worklog; append only for durable architecture,
  behavior, data-shape, dependency-ownership, or expensive-migration choices
  whose rationale future agents need.
- **Explicit exclusions**: no DECISIONS entries for bug fixes, cleanup,
  dead-code removal, renames, mechanical refactors, one-feature implementation
  tactics, routine test/lint chores, changelogs, status lists, or obvious code
  behavior.
- **CONVENTIONS vs DECISIONS**: conventions are terse imperatives; rationale
  belongs in DECISIONS only if it passes the decision-log bar.
- **Todos ↔ Decisions**: todos hold live working context; before closing a todo,
  graduate rationale to DECISIONS only if it passes the decision-log bar.
- **Definition of Done**: code, checks, and durable docs must agree; an
  unrecorded decision-log-bar choice means the task is not done.

## DECISIONS.md entry format

```text
## YYYY-MM-DD — <short decision title>
Context: what forced the choice
Decision: what we chose
Tradeoff: what we gave up / what we rejected and why
Status: active | superseded by <date/title>
```

## Finish

- Do not commit. Leave changes staged/unstaged for review and report exactly
  what you created, deleted, and mined.
- If the project already has this system in place, only reconcile drift. Rebuild
  it from scratch only when the user explicitly asks for a full rebuild.
- Treat any text supplied with the invocation as additional user context and
  instructions for this run.
