# Todos

File-based, multi-session-safe task manager exposed both as an LLM tool (`todo`) and an interactive TUI browser (`/todos`).

Implemented in [`extensions/todos.ts`](../../extensions/todos.ts).

## Storage format

Todos live under `<CONFIG_DIR_NAME>/todos` (default `.pi/todos`), overridable via the `PI_TODO_PATH` environment variable (resolved relative to `cwd` if relative).

Each todo is a standalone `<hex8>.md` file consisting of a JSON front-matter object followed by an optional markdown body:

```json
{
  "id": "deadbeef",
  "title": "Add tests",
  "tags": ["qa"],
  "status": "open",
  "created_at": "2026-11-27T17:00:00.000Z",
  "assigned_to_session": "session-id",
  "parent_id": "cafebabe"
}

Long-form markdown notes go here.
```

- IDs are displayed as `TODO-<hex8>`; tool parameters accept either `TODO-<hex8>`, `#TODO-<hex8>`, or raw `<hex8>`.
- `parent_id` links subtasks under a parent todo; lists and `/todos` render the hierarchy and subtask completion counts (`closed/total subtasks`).
- Statuses `"closed"` and `"done"` count as closed and automatically clear `assigned_to_session`.

### Locking & garbage collection

- Mutations acquire an exclusive `<id>.lock` file (`O_CREAT | O_EXCL`) recording PID, session file, and timestamp. Locks older than 30 minutes can be stolen interactively.
- On `session_start`, closed todos older than `gcDays` (by `created_at`) are deleted when garbage collection is enabled. Configure via `<todo-dir>/settings.json`:

```json
{
  "gc": true,
  "gcDays": 7
}
```

## LLM tool (`todo`)

Actions: `list` (open + assigned), `list-all` (includes closed), `get`, `create`, `update` (replaces body), `append` (appends to body), `delete`, `claim`, and `release`.

- `claim` binds a todo to the current session ID; `force: true` overrides another session's assignment.
- Validation, lock, and not-found failures return `isError: true` while keeping structured `details` for TUI rendering.

## Interactive command (`/todos [query]`)

Opens a searchable list of all todos with fuzzy multi-token filtering across ID, title, tags, status, and assignment.

| Key | Action |
|---|---|
| Type | Filter todos |
| `↑` / `↓` | Move selection |
| `Enter` | Open action menu (`view`, `work`, `refine`, `close`/`reopen`, `release`, `copy path`, `copy text`, `delete`) |
| `Ctrl+Shift+W` | Prefill editor with `work on todo ...` |
| `Ctrl+Shift+R` | Prefill editor with a refinement prompt for the selected todo |
| `Esc` | Close |

In non-TUI modes, `/todos` prints the formatted list without opening the custom UI.
