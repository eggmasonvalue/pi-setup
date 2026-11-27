# Annotate

`/annotate` (or `Ctrl+Shift+A`) opens the last assistant message in a floating review overlay rendered with Pi's own Markdown formatting — so headings, tables, code blocks, lists, and emphasis stay readable — lets you attach notes to specific lines/spans plus an optional general summary message for the whole batch, and sends everything as one clean message.

Implemented in [`extensions/annotate.ts`](../../extensions/annotate.ts). Originally inspired by `patelparth3/pi-annotations` (MIT).

## Keybindings

| Context | Key | Action |
|---|---|---|
| Open | `/annotate` or `Ctrl+Shift+A` | Open overlay on the last assistant message |
| Navigate | `j` / `k` / `↑` / `↓` / mouse wheel | Move cursor line by line |
| Navigate | `PgUp` / `PgDn` / `g` (`Home`) / `G` (`End`) | Jump by page or to top/bottom |
| Annotate | `v` | Start/extend a multi-line span; `s` or `Enter` opens the note editor |
| Annotate | `i` / `a` / `Enter` | Add a note on the current line, or edit the existing annotation under the cursor |
| Summary | `m` | Add or edit the batch-level general message |
| Manage | `x` / `d` | Delete the annotation under the cursor |
| Manage | `C` | Clear all annotations and the general message |
| Editor | `Enter` | Save note or summary (empty text deletes it) |
| Editor | `Shift+Enter` | Insert a newline (input wraps automatically) |
| Editor | `Esc` | Cancel edit without modifying |
| Send | `Ctrl+S` | Send batch (works from both navigation and editor mode, matching `ask_user_questions`) |
| Close | `Esc` | Close overlay; unsent annotations and summary are saved as an in-memory draft for that message |

If the agent is still running when you send, the batch is queued as a `followUp`.

## Output format

No boilerplate preamble is injected. The message contains your general summary (if provided) followed by your quoted passages and notes:

```markdown
Overall direction looks right, two small tweaks before implementing:

[1]
> Store sessions in Redis with a 24h TTL and refresh the expiry on every request.
Refreshing on read means idle users never time out — is that intended?

[2]
> Delete the legacy /v1/auth endpoint once the migration ships.
Keep it behind a flag for one release instead of deleting outright.
```

- When there is only a single line annotation, `[1]` is omitted.
- Long quoted spans (> 4 lines or > 300 chars) are trimmed to their edges with `…` since the agent already has its full message in context.
- Sending only a general summary (without line annotations) sends just that summary.

## Configuration

Override the default shortcut (`ctrl+shift+a`) in `settings.json` or via environment variable:

```json
{ "annotate": { "shortcut": "f2" } }
```

or `PI_ANNOTATE_SHORTCUT=f2`. (`settings.json` takes precedence when set.)
