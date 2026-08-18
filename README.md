# pi-setup

Pi package containing the extensions, skills, and themes maintained in this repository. Other independently maintained extensions and skills are installed as separate top-level Pi packages.

## Bootstrap a machine

Prerequisites: Git, Node.js, Pi, and (on Windows) Git Bash. The npm settings below require **npm 11.17.0 or newer**. Check first:

```bash
npm --version
```

If the version is older, upgrade npm (or install a newer Node.js release) before continuing. For example, on a Node installation that supports npm 11:

```bash
npm install --global npm@11.17.0
```

Then add the following to the user npm configuration file shown by `npm config get userconfig`:

```ini
min-release-age=7
min-release-age-exclude[]=@earendil-works/pi-*
legacy-peer-deps=true
```

The first setting delays newly published registry packages. The trusted `@earendil-works/pi-*` namespace is exempt because Pi supplies those host packages itself; Git-distributed extensions may mention them as dev or peer dependencies even though they should not be installed into the extension tree. `legacy-peer-deps` prevents npm from auto-installing those host peers during Git package setup. Keep any existing registry authentication lines in that file unchanged.

`min-release-age` was added before the exclusion setting. npm 11.10.0 through 11.16.x therefore recognize `min-release-age` but warn that `min-release-age-exclude` is unknown and do not apply the exclusion. This is an npm version issue, not a Linux-specific `.npmrc` syntax issue; `min-release-age-exclude[]` is the supported repeated-value syntax in npm 11.17.0+.

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
- `git:github.com/eggmasonvalue/pi-system-prompt-viewer`
- `git:github.com/monotykamary/pi-toggle-skills`
- `git:github.com/patelparth3/pi-annotations`
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

`/system-prompt` comes from `git:github.com/eggmasonvalue/pi-system-prompt-viewer`. Rerunning bootstrap installs that package and removes the older `git:github.com/jandrikus/pi-system-prompt` and `npm:pi-system-prompt` entries.

## Optional: quickly creating a Pi subset

A subset is a convenient way to give a particular kind of session a deliberately smaller resource set. The example below is a work subset: it allows only skills from the current repository, keeps a few explicitly chosen utility extensions, and disables web search (`tavily-web.ts`) and the file-based todo/issue tracker (`todos.ts`). Copy it into `~/.bashrc`, then change the allowlist and exclusions to create another subset quickly:

```bash
pi-work() {
  local agent="$HOME/.pi/agent"
  local root
  local args=(--no-skills --no-extensions)
  local ext

  root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

  # Keep pi-setup extensions except the work-excluded ones.
  for ext in "$agent/git/github.com/eggmasonvalue/pi-setup/extensions/"*.ts; do
    [[ "$(basename "$ext")" != "tavily-web.ts" && "$(basename "$ext")" != "todos.ts" ]] &&
      args+=(--extension "$ext")
  done

  # Keep selected independently-installed extensions.
  [[ -f "$agent/git/github.com/eggmasonvalue/pi-system-prompt-viewer/extensions/system-prompt.ts" ]] &&
    args+=(--extension "$agent/git/github.com/eggmasonvalue/pi-system-prompt-viewer/extensions/system-prompt.ts")

  [[ -f "$agent/git/github.com/monotykamary/pi-toggle-skills/toggle-skills.ts" ]] &&
    args+=(--extension "$agent/git/github.com/monotykamary/pi-toggle-skills/toggle-skills.ts")

  [[ -f "$agent/git/github.com/patelparth3/pi-annotations/annotate.ts" ]] &&
    args+=(--extension "$agent/git/github.com/patelparth3/pi-annotations/annotate.ts")

  # Re-enable work-repository skills only.
  [[ -d "$root/.agents/skills" ]] && args+=(--skill "$root/.agents/skills")
  [[ -d "$root/.pi/skills" ]] && args+=(--skill "$root/.pi/skills")

  command pi "${args[@]}" "$@"
}

alias piw=pi-work
```

This is intentionally a copy-paste recipe rather than a bootstrap feature: subsets are personal, machine-local policies, while the normal setup remains the complete repository configuration. The function is structured as an explicit allowlist:

- `--no-skills --no-extensions` establishes a clean baseline instead of inheriting whatever is installed globally.
- `git rev-parse` scopes repository-local skills to the project from which Pi is launched, with `pwd` as a fallback outside a Git checkout.
- The extension loop starts with the repository's extensions, then excludes capabilities that should not be present in this subset. To make a different subset, edit this condition.
- Independent extensions are added one at a time and only when their files exist, so the function remains portable across machines with different installed packages.
- Skills are added only from the current repository's `.agents/skills` and `.pi/skills` directories; no global skill tree is re-enabled.
- `command pi` avoids recursively invoking the shell function itself and preserves all arguments passed to `piw`.

Reload the shell after adding or changing it, for example with `source ~/.bashrc`.

## Verify

```bash
pi list
pi update --extensions
agent-browser --version
```

Restarting Pi or using `/reload` loads updated resources. The setup package owns only `extensions/`, `skills/`, `themes/`, `AGENTS.md`, and `APPEND_SYSTEM.md`
