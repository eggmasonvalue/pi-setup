# Subagent

Delegate a task to a subagent that runs in its **own isolated context** (a separate `pi`
process), then hand the result back to the main agent — while keeping the main agent's
context window clean and **every child fully observable**.

This is a deliberately *thin* primitive. The main agent is the intelligence; this tool
just gives it a clean way to spawn isolated work and get a pointer back.

---

## What this is solving for

Pi ships without built-in subagents on purpose. Mario Zechner's objections to the way
other harnesses (e.g. Claude Code) do subagents are specific and worth keeping in mind,
because this extension is built to answer each one:

| The usual complaint | What this extension does |
|---|---|
| **"Black box within a black box."** You can't see what the subagent did. | Each child's **full transcript is persisted to a session JSONL**, and the file path is returned in the result. You (or the main agent) can open it and read every step. |
| **Painful to debug.** If a child makes a mistake, you can't replay its conversation. | The session file is a normal pi session. `read` it, or resume it with `pi --session <file>` / `/tree` to inspect or continue the exact run. |
| **Poor context transfer.** The orchestrator decides what the child sees, opaquely. | Context is explicit: the main agent writes the child's `task` (and optionally an inline `systemPrompt`, `model`, `tools`). Nothing hidden. |
| **Context pollution.** People reach for subagents mid-session to "save context," then dump tool output back into the parent anyway. | The model only sees the child's **final output** (capped), not its streaming internals. Full detail lives in the session file and tool `details`, off to the side. |

The net effect: you get the *one* genuinely useful property of subagents — an **isolated
context window for a focused sub-task** — without giving up observability or steerability.

### Why no persona files

The shipped pi example required every subagent to be a human-written `agent.md` persona.
We removed that as the default. A SOTA supervisor model knows how to frame a sub-task and
adopt a persona far better than a static file written ahead of time. So by default this
tool runs **inline**: the main agent supplies the task (and optionally a system prompt) at
call time. Named agent files are still supported as an *optional* convenience, not a
requirement.

---

## How it works

```
main pi session
   └─ subagent tool call
        └─ spawns:  pi --mode json -p --session-dir <run-dir> [--model ...] [--tools ...] "Task: ..."
              ├─ streams progress to YOU (the human) live, in the tool row
              ├─ writes its full conversation to <run-dir>/<timestamp>_<uuid>.jsonl
              └─ returns a concise final output (+ session path) to the MAIN AGENT
```

Two streams, deliberately separated:

- **To the human:** live streaming of tool calls and progress (observability). This does
  **not** enter the main agent's context.
- **To the main agent:** only the final output, byte-capped, with a `— session: <path>`
  footer so it can read the full trace if it wants to verify or debug.

Child sessions are written under:

```
~/.pi/agent/sessions/subagent/<runId>/<session>.jsonl
```

---

## Usage

You normally don't call this yourself — you ask the main agent in plain language and it
decides to use the tool. Examples:

```
Scan this repo in an isolated context and tell me where auth is handled.

Run 3 subagents in parallel: one to map the data models, one the API routes,
one the background jobs. Summarize each.

Chain: first have a subagent find the rate-limiting code, then have another
propose a fix based on what it found.
```

### Modes

| Mode | Shape | Use when |
|------|-------|----------|
| **Single** | `{ task }` | One focused isolated task. |
| **Parallel** | `{ tasks: [{ task }, ...] }` | Independent tasks that don't touch the same files. |
| **Chain** | `{ chain: [{ task }, ...] }` | Sequential steps; `{previous}` in a task is replaced with the prior step's output. |

### Per-call options (all optional)

- `systemPrompt` — inline persona/instructions for the child.
- `model` — e.g. `sonnet`, `provider/id`.
- `thinking` — optional passthrough to child `--thinking` (no hardcoded validation in this extension).
- `tools` — allowlist, e.g. `["read", "grep", "find", "ls"]` for a read-only scout.
- `cwd` — working directory for the child process.
- `agent` — name of a `*.md` agent file (optional; see below).
- `label` — a correlation tag echoed back in the result envelope (e.g. the repo/feature a task maps to). Removes guesswork when fanning out.
- `resume` — exact JSONL path from a prior result's `session=` field (see **Resume**).
- `timeoutMs` — kill the child after N ms and return its partial output with `status=timeout` (see **Timeouts**).

### Result envelope

Subagent output is consumed by the **main agent**, not a human, so each task's result is
prefixed with one terse machine-parsable line carrying only what the *tool* uniquely knows:

```
[label=harden-repo-3 agent=inline status=done model=github-copilot/gpt-5.3-codex thinking=low timeoutMs=120000 turns=7 cost=0.0413 exit=end session=/…/<id>.jsonl]
<the child's own final output, verbatim, byte-capped>
```

`status` is one of `done` / `failed` / `timeout` / `aborted` / `never-started`. The tool does
**not** wrap or reformat the child's payload — if you want JSON back, tell the child (via
`task`/`systemPrompt`) to emit JSON. The rich TUI rendering for the human lives in tool
`details` and never enters the main agent's context.

### Abort & partial results

On Ctrl+C / `/interrupt`, the tool **no longer discards completed work**. Every task that
finished returns its full output; in-flight tasks return partial output with
`status=aborted`; tasks that hadn't launched return `status=never-started`. **Every task
keeps its own `session=` path**, so nothing requires digging through the sessions dir. The
aggregate header reports the mix (e.g. `2 done · 1 aborted · 1 never-started`) and points
you at `subagent { resume }` for the unfinished ones.

### Resume

Resume continues the **same** session file (appends the next turn via `pi --session`), so the
child keeps its cache-compatible runtime configuration and prior context:

```
subagent {
  resume: "/…/sessions/subagent/<runId>/<id>.jsonl",   // exact session= JSONL path
  task: "You looped on the import. The package is `foo`, not `foo-py`. Fix pyproject and re-run tests.",
  timeoutMs: 120000
}
```

- `resume` must be the exact JSONL path shown in a previous result's `session=` field, not a session id, label, run id, or basename.
- `task` is **required** on a resume (it's the steering prompt) and is appended as the next user turn.
- Only `timeoutMs` and `label` may vary on resume; `agent` / `systemPrompt` / `model` / `thinking` / `tools` / `cwd` are fixed by the original session for provider prefix-cache compatibility.
- Typical loop: a child aborts/times out → `read` its `session` JSONL to diagnose → `subagent { resume: <session-jsonl-path>, task: <correction> }`.
- Works in single, parallel, and chain.

### Timeouts

`timeoutMs` bounds a run: on expiry the child gets `SIGTERM` (then `SIGKILL` after a grace
period) and returns its **partial output** with `status=timeout` and its session path —
never an exception, same flush path as abort. There is **no default timeout**; unbounded
fire-and-await is the default.

> **KV-cache caveat.** Killing a child throws away the provider-side prompt cache (warm KV
> prefix), which has a short idle TTL (~5 min on most labs). A `resume` after the TTL
> lapses re-prefills the whole context at full input price. If you time out and intend to
> continue, **resume promptly** to maximize cache hits. A bare timeout with no resume plan
> pays for work twice — prefer it only as a genuine hang guard.

### Discovering models

```
subagent { listModels: true }
```

Returns compact model-policy JSON: `columns` plus `models` rows, the resolved `default`,
whether the policy is enabled, and the config path. No subagent is spawned.

### Note on progress

Subagent calls are **synchronous fire-and-await**: the main agent's loop is suspended for
the entire call, so there is no live channel back to the model mid-run (a "heartbeat" to
the orchestrator is structurally impossible). The human *does* see live streaming in the
TUI. The synchronous answer to "what if it hangs" is `timeoutMs` + `resume`, not a heartbeat.

### Named agents (optional)

If you *do* want reusable personas, drop markdown files in:

- `~/.pi/agent/agents/*.md` — user-level (always available)
- `.pi/agents/*.md` — project-level (only with `agentScope: "project"` or `"both"`)

```markdown
---
name: scout
description: Fast read-only codebase recon
tools: read, grep, find, ls
model: claude-haiku-4-5
---

You are a fast scout. Find the relevant code and report concise, cited findings.
```

Then: *"use scout to find the auth code"*. Inline `model`/`tools` passed at call time
override the file's values.

### Model allowlist (optional, recommended)

To hard-restrict which child models can be used, configure:

`~/.pi/agent/extensions/subagent/models-allowlist.json`

It supports either plain model ids (strings) or richer objects with an `id` plus **any** metadata you may deem necessary for the main agent to make an informed decision about subagent choice:

```json
{
  "enabled": true,
  "allowed": [
    {
      "id": "github-copilot/gpt-5.3-codex",
      "thinkingLevels": ["low", "medium", "high", "xhigh"],
      "coding_index": 53.1,
      "description": "Great default for most coding tasks"
    },
    "github-copilot/gpt-5.5"
  ],
  "default": "github-copilot/gpt-5.3-codex"
}
```

Behavior when enabled:

- Effective model resolution is: inline `model` → named-agent `model` → allowlist `default`.
- The resolved model must match an allowed `id` exactly.
- If no model resolves and no `default` is set, the call fails early.
- If the file is missing, policy is disabled (legacy behavior).
- `subagent { listModels: true }` returns compact policy JSON as `{ columns, models, default, allowlistEnabled, configPath }`.

**Security:** project-local agents are repo-controlled prompts. By default only user-level
agents load. Enable project agents with `agentScope: "both"` (or `"project"`), and the tool
will prompt for confirmation before running them interactively
(`confirmProjectAgents: false` to disable).

---

## Output & limits

- **Collapsed view:** status, last few items, usage stats (turns, tokens, cost, context).
- **Expanded view (Ctrl+O):** full task, tool calls, final output as Markdown, per-task usage.
- Parallel model-visible output is capped at **50 KB per task**; the full result stays in
  tool `details` and in the child's session file.
- **Abort:** Ctrl+C / `/interrupt` kills child processes but **flushes partial results** — completed tasks return their output, in-flight tasks return partial output, and every task keeps its session path (see **Abort & partial results**).
- Parallel mode is limited to 8 tasks, 4 concurrent.

---

## Debugging a subagent run

When a child's summary looks off, you don't guess — you read the receipts:

```bash
# the session path is shown live in the tool row as soon as the child starts,
# and is included in the final result, e.g.
~/.pi/agent/sessions/subagent/1718000000000-ab12cd/2026....jsonl

# inspect it
pi --session <that-file>      # resume / browse with /tree
# or just have the main agent `read` the file
```

The path is surfaced **at the start** of the child run (not just the end), so you can
open or `tail -f` the JSONL while it's still working. It is also attached to the result
**even if the run is aborted** (Ctrl+C) or crashes — which is exactly when you want the
partial trace.

That file path *is* the whole observability story. No supervisor loop, no telemetry
schema — just a pointer to the full conversation.

---

## Files

```
subagent/
├── index.ts               # tool registration, spawning, rendering
├── agents.ts              # optional named-agent discovery
├── models-allowlist.json  # model policy (optional)
├── enrich.ts              # helper script to enrich allowlist metadata
└── README.md              # this file
```

## Reload

After editing, run `/reload` in pi to pick up changes.
