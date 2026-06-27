---
description: Bootstrap the standard agent-maintained documentation system onto
  this project
argument-hint: "[--force]"
---

# Bootstrap documentation system

Set up the standard documentation system on this project. It is
**agent-maintained** but human-readable. Adapt all content to this project and
never copy another project's specifics.

## Guiding principle

Only document what an agent **cannot quickly recover by reading the code**.
Code is the source of truth for *what the code does*. Docs exist for *where
things live* (MAP) and *why the tradeoffs were made* (DECISIONS). Everything
else rots, so do not write it.

## Target structure

- `AGENTS.md` — universal entry point: principle, hard guardrails,
  read-routing, event-based write triggers, the CONVENTIONS-vs-DECISIONS
  boundary, todos↔decisions rule, and Definition of Done.
- `context/MAP.md` — module structure + data flow (mermaid where useful). The
  "where things live" map.
- `context/DECISIONS.md` — append-only log of intentional tradeoffs (context /
  decision / tradeoff / status). The home for non-obvious choices code cannot
  explain.
- `context/CONVENTIONS.md` — terse imperative code rules with **zero
  rationale**. Read while writing code.
- `README.md` — what the project is and how to run/use it. Agent-maintained
  from now on.
- **No CHANGELOG** — git history is the changelog.

Use the folder name `context/` (no leading dot). Never use a hidden/dot folder
for these docs: `rg` skips hidden files by default, which would hide the
most-read docs from the most-used search tool. If a legacy `.context/` exists,
run `git mv` to `context/` and fix references.

## Steps

1. Survey the repo: read any existing `AGENTS.md`, `context/*` (and legacy
   `.context/*`), `README.md`, `GEMINI.md`/`CLAUDE.md`, plus build/tool config
   (for example `pyproject.toml`, `package.json`) and the source tree. Detect
   the real tooling, commands, and module layout.
2. **Mine, don't discard.** Before deleting old docs, extract genuine tradeoffs
   into `DECISIONS.md` and genuine imperative rules into `CONVENTIONS.md`.
   Status/feature lists and changelog-style entries are not worth keeping — git
   and code already cover them.
3. Create or rewrite the five files above with project-accurate content. Seed
   `DECISIONS.md` with real decisions found in old docs, code comments, and
   notable git history (each entry: context, decision, tradeoff, status). If
   none exist yet, leave only a header + format example.
4. Make `CONVENTIONS.md` pure imperatives. Test each line: if it needs a
   "because", it is a decision. Move rationale to `DECISIONS.md` and let the
   convention link to it instead.
5. Delete redundant or obsolete docs: any `CHANGELOG.md` under `context/`,
   feature/status files (for example `DESIGN.md`), `OVERVIEW.md` if it only
   duplicates README, and stray per-tool agent files (`GEMINI.md`,
   `CLAUDE.md`). Fold their substance into `AGENTS.md` so it is the single
   universal guide. Use `git mv`/`git rm` when the repo is git-tracked.
6. Fix all cross-references after renames or deletes (grep old filenames).
7. **Set up linting/formatting.** Ensure the project has a linter + formatter
   appropriate to its stack (for example `ruff` for Python,
   ESLint + Prettier for JS/TS, `golangci-lint` for Go,
   `clippy`/`rustfmt` for Rust). If none exists, add and configure it; if one
   exists, keep it. Add standard run commands to `CONVENTIONS.md` as
   imperatives (lint, format, test) and verify they run. Wire into pre-commit
   or CI only if the project already uses those.
8. **Set up Markdown linting** (always, because these docs are Markdown). Add
   `markdownlint` (for example `markdownlint-cli2`) with sensible config, and
   ensure `AGENTS.md`, `README.md`, and everything under `context/` pass. Add
   the lint command to `CONVENTIONS.md`. Lint and fix docs you created so they
   start clean.

## AGENTS.md must contain

- **Hard guardrails** near the top, including: **never commit to `main`
  directly — always work on a branch / open a PR** (adapt for the project's
  actual default branch and workflow).
- **Read routing**: read MAP before touching data flow/structure; read
  DECISIONS before changing or re-litigating a tradeoff; read CONVENTIONS while
  writing code; check the `todo` tool (`todo list`) when starting work, and
  `todo claim` a task before working it so parallel sessions don't collide. Do
  not read everything by default.
- **Write triggers (event-based)**: module added/moved/removed or data-flow
  change → MAP; intentional tradeoff → append to DECISIONS (mandatory — most
  forgotten artifact); new repeatable pattern/standard → CONVENTIONS;
  user-facing behavior/usage changed → README.
- **Do NOT document**: changelog/worklog (that's git), feature/status lists,
  restatements of what code plainly does, or decisions with no real tradeoff.
- **CONVENTIONS vs DECISIONS**: a convention is one imperative line with no
  "because"; once it needs a "because", it is a decision.
- **Todos ↔ Decisions**: the `todo` tool is stateful, not a scratchpad — todos
  are real files under `.pi/todos` with a markdown body for working notes,
  a status lifecycle (`open`/`closed`/`done`), tags, subtasks (`parent_id`),
  and per-session `claim`/`release`. Keep working context in the todo body
  while a task is live. But closed/done todos are **garbage-collected ~7 days
  after creation**, so before you close a todo that involved a real tradeoff,
  graduate the durable part into DECISIONS — closing is not archiving.
- **Definition of Done**: a task is done only when matching durable artifacts
  reflect the change; an unrecorded tradeoff means not done.

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
- If the project already has this system in place, only reconcile drift —
  unless `$1` is `--force`, in which case rebuild from scratch.
