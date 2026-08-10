# pi-setup

Pi package containing the extensions, prompt templates, and themes maintained in this repository. Independently maintained extensions and skills are installed as separate top-level Pi packages.

## Bootstrap a machine

Prerequisites: Git, Node.js, Pi, and (on Windows) Git Bash. From Git Bash, run:

```bash
tmp=$(mktemp -d) && git clone --depth 1 https://github.com/eggmasonvalue/pi-setup "$tmp" && node "$tmp/scripts/bootstrap.mjs"; status=$?; rm -rf "$tmp";
```

The bootstrap is safe to rerun. It installs the unpinned package sources, merges only the managed package entries and Pi-managed npm `PATH` entry into `~/.pi/agent/settings.json`, removes old resource-directory links, and links the installed package's `APPEND_SYSTEM.md` into the global Pi directory. It never modifies `auth.json`, `models.json`, provider/model settings, or UI preferences.

On Windows, creating the `APPEND_SYSTEM.md` file symlink may require Developer Mode or a terminal with the `SeCreateSymbolicLinkPrivilege` privilege. The bootstrap stops with an actionable error rather than silently replacing it with a stale copy.

## Managed top-level packages

- `git:github.com/eggmasonvalue/pi-setup`
- `git:github.com/eggmasonvalue/pi-subagent`
- `npm:pi-annotations`
- `npm:pi-system-prompt`
- `npm:pi-toggle-skills`
- `npm:agent-browser`
- `git:github.com/vercel-labs/skills` (only `skills/find-skills`)
- `git:github.com/anthropics/skills` (only `skills/skill-creator`)

All sources intentionally omit versions, tags, and commit refs. Update everything with:

```bash
pi update --extensions
```

The Pi-managed npm binaries are placed under `~/.pi/agent/npm/node_modules/.bin` and added to `shellCommandPrefix`. After the package update, verify the CLI with:

```bash
agent-browser --version
```

`agent-browser install` is a separate one-time per-machine browser/runtime setup step. The bootstrap reports the command; run it if needed.

## Verify

```bash
pi list
pi update --extensions
agent-browser --version
```

Restarting Pi or using `/reload` loads updated resources. The setup package owns only `extensions/`, `prompts/`, `themes/`, and `APPEND_SYSTEM.md`; skills and the subagent extension are not copied into this repository.
