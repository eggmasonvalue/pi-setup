# Shake

`/shake` is a deterministic Pi compaction: no model is asked to summarize. It compacts the current session in place, replacing the history with a condensed transcript in which every tool call is a one-line record. User messages and the assistant's replies are kept word for word; tool outputs, reasoning, and images are dropped. The session stays the same, and the full history is still available through `/tree`.

Two extensions work together:

- [`extensions/shake.ts`](../../extensions/shake.ts) provides the `/shake` command and the compaction it triggers.
- [`extensions/tool-descriptions.ts`](../../extensions/tool-descriptions.ts) makes every `bash` and `codemode` call carry a short description, which becomes that call's record.

## How it works

`/shake` calls `ctx.compact()` with a fixed marker as `customInstructions`. A `session_before_compact` handler recognizes the marker and returns its own compaction:

- `summary`: the condensed transcript (below).
- `firstKeptEntryId: null`: no earlier entries are kept; the summary replaces all of them. (`SessionManager.appendCompaction` stores `firstKeptEntryId ?? id`.)

Without the marker the handler does nothing, so `/compact` and automatic compaction keep Pi's default behavior.

Shaking again works: the previous summary becomes an `[Earlier summary]` line and newer messages are condensed after it.

## Summary format

Pi wraps the summary in its usual compaction preamble. The summary itself looks like this:

```
Earlier conversation, condensed. Tool outputs were removed; each tool call is a one-line record `[tool] summary → outcome`. The calls ran and their effects, such as file edits, persist. Rerun tools when you need their output.

[Earlier summary]: …
[User]: Find out why the config loader is slow.
[Assistant]: I'll start with the loader.
[Tool calls]: [read] src/config/loader.ts; [bash] Time config loading on the sample project; [bash] Find callers of parseConfig in src → no output
[Tool calls]: [edit] src/config/loader.ts; [bash] Run the config test suite → exit 1
[Assistant]: The cache key ignored the profile name; fixed, one test still fails.
[User ran]: git status --porcelain
```

| Line | Source |
|---|---|
| `[User]` | Text of a user message |
| `[Assistant]` | Text blocks of an assistant message |
| `[Assistant's thinking summary]` | Only with the `thinking` option (below): the readable thinking summary shown in the transcript |
| `[Tool calls]` | The assistant message's tool calls, as records joined with `; ` |
| `[User ran]` | A `!` command and its outcome; `!!` commands, which are never shown to the model, are skipped |
| `[Earlier summary]` | A previous compaction or branch summary |

## Thinking summaries

By default, reasoning is dropped. To keep the readable thinking summaries that the transcript shows you, set this in `settings.json` (global or project):

```json
{ "shake": { "thinking": true } }
```

Each non-redacted thinking block then becomes an `[Assistant's thinking summary]` line before that message's `[Assistant]` line. The opening paragraph gains one sentence saying these lines are short summaries written for the user, not the reasoning itself. That way the model doesn't mistake them for its own words or its actual reasoning. The setting is read each time `/shake` runs. It makes summaries larger: in one session, about 40%.

## Records

Records have the form `[<tool>] <summary> → <outcome>`.

The summary is the call's main argument:

| Tool | Summary |
|---|---|
| `bash`, `codemode` | The call's `description` |
| Tools with a `path`, `file`, `filePath`, or `paths` argument | The path(s) |
| Others | `command`, `query`, or `action` if present, otherwise the arguments as JSON |

The outcome is left out when the call succeeded with output, because that is the normal case:

| Outcome | Meaning |
|---|---|
| `no output` | Bash succeeded and printed nothing |
| `exit <code>` | Bash exited with a non-zero code |
| `timed out` | Bash hit its timeout |
| `aborted` | The call was interrupted |
| `error` | Any other tool failure |
| `no result` | The call never got a result (for example, the session was interrupted mid-call) |

## Tool descriptions

`tool-descriptions.ts` replaces the built-in `bash` and `codemode` tools with the same tools plus one required argument, `description`: what the command or script does, in 5–10 words. The model is told why: long conversations may later be abridged, and the description is then the only record of the call. That makes it a note to its future self, which pushes it to be specific.

The extension is always on and changes nothing else:

- **Execution:** `bash` runs through Pi's own bash implementation (using `shellCommandPrefix` and `shellPath`), and `codemode` delegates to Pi's built-in `codemode` extension (keeping `defaultActive: false` and switching constrained sampling to strict JSON Schema since grammar mode only supports a single parameter).
- **Display:** the description appears as a `# comment` line above the call, which also makes long command and script chains easy to follow as they happen.
- **Outcome:** `bash` exit codes are not saved in the session file, so the tool records the outcome word itself in the result's `details.outcome`. Shake uses any tool's `details.outcome` this way.

## Maintaining

- **The summary is read by models that know nothing about Shake.** Its opening paragraph and the `description` help text must make sense to a reader with no context. Don't mention "Shake", "pruning", or other internal terms in them.
- Existing compactions are not rewritten. If the format changes, earlier summaries keep the old wording.
