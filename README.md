# pi-setup

Pi package containing the extensions, skills, and themes maintained in this repository. Other independently maintained extensions and skills are installed as separate top-level Pi packages.

## Bootstrap a machine

Prerequisites: Git, Node.js, Pi, and (on Windows) Git Bash. Before bootstrapping a machine, add the following to the user npm configuration file shown by `npm config get userconfig`:

```ini
min-release-age=7
min-release-age-exclude[]=@earendil-works/pi-*
legacy-peer-deps=true
```

The first setting delays newly published registry packages. The trusted `@earendil-works/pi-*` namespace is exempt because Pi supplies those host packages itself; Git-distributed extensions may mention them as dev or peer dependencies even though they should not be installed into the extension tree. `legacy-peer-deps` prevents npm from auto-installing those host peers during Git package setup. Keep any existing registry authentication lines in that file unchanged.

These are per-machine npm settings; repeat this step on every machine.

From Git Bash, run:

```bash
tmp=$(mktemp -d) && git clone --depth 1 https://github.com/eggmasonvalue/pi-setup "$tmp" && node "$tmp/scripts/bootstrap.mjs"; status=$?; rm -rf "$tmp";
```

The bootstrap is safe to rerun. It installs the unpinned package sources, merges only the managed package entries and Pi-managed npm `PATH` entry into `~/.pi/agent/settings.json`, removes old resource-directory links, and links the installed package's `AGENTS.md` and `APPEND_SYSTEM.md` into the global Pi directory, replacing existing links or files so the repository remains the single source of truth. It never modifies `auth.json`, `models.json`, provider/model settings, or UI preferences.

On Windows, creating the managed `AGENTS.md` and `APPEND_SYSTEM.md` file symlinks may require Developer Mode or a terminal with the `SeCreateSymbolicLinkPrivilege` privilege. The bootstrap stops with an actionable error if it cannot create either link.

## Managed top-level packages

- `git:github.com/eggmasonvalue/pi-setup`
- `git:github.com/eggmasonvalue/pi-subagent`
- `git:github.com/monotykamary/pi-toggle-skills`
- `git:github.com/patelparth3/pi-annotations`
- `git:github.com/jandrikus/pi-system-prompt`
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

Restarting Pi or using `/reload` loads updated resources. The setup package owns only `extensions/`, `skills/`, `themes/`, `AGENTS.md`, and `APPEND_SYSTEM.md`
