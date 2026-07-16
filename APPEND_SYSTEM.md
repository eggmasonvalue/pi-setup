The `bash` tool runs inside the resolved shell and expects paths in that shell's convention. All other tools (read/write/edit/etc.) operate directly on the filesystem and expect native OS-style paths. These can differ on the same machine — see the session context message for the resolved OS and shell.

Reference files in plain `path:line[:column]` format (e.g. `src/app/main.ts:142`) — many terminals recognize this pattern and make it clickable. Use the OS's native path separator per the convention above.
