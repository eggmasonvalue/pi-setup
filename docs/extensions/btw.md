# BTW Side Chat

`/btw` opens a floating side-channel chat popover backed by an ephemeral in-memory agent session that inherits the current main conversation's context. Use it for side questions, quick explorations, or planning without polluting the main session transcript.

Implemented in [`extensions/btw.ts`](../../extensions/btw.ts).

## Usage

- `/btw <question>` — opens the overlay and immediately sends `<question>` to the side session.
- `/btw` — opens the overlay. If a side thread already exists on the current branch, prompts to either **Continue previous conversation** or **Start fresh**.

### Controls inside the overlay

| Key | Action |
|---|---|
| `Enter` | Submit question |
| `Esc` | Close overlay (if a thread exists, offers **Keep side thread** or **Inject summary into main chat**) |
| `↑` / `↓` | Scroll transcript by 1 line |
| `PgUp` / `PgDn` | Scroll transcript by 1 page |
| `Home` / `End` | Jump to top / bottom of transcript |

## How it works

### Context seeding

When the first side question is sent (or after switching models / continuing a thread), `btw.ts` constructs an in-memory `SessionManager` preloaded with the main session's header and active branch (`ctx.sessionManager.getBranch()`), appends any prior BTW Q&A pairs, and passes it to `createAgentSession()`. The side session receives `read`, `bash`, `edit`, and `write` tools, uses the currently active model and thinking level, and appends a short BTW role prompt.

### Branch-local persistence

BTW turns never enter the main LLM context directly. Instead:

- Each completed Q&A pair is appended as a custom entry (`btw-thread-entry`) on the active branch.
- Starting fresh or injecting a summary appends a `btw-thread-reset` marker.
- On `session_start` and `session_tree` (e.g. after `/resume` or `/tree`), the thread is reconstructed from custom entries after the latest reset on the active branch.

### Handoff back to main chat

Choosing **Inject summary into main chat** on close calls `ctx.modelRegistry.streamSimple()` directly with a handoff-summary prompt, sends the resulting summary to the main session via `pi.sendUserMessage()` (immediately when idle, or as a `followUp` while streaming), and resets the side thread.
