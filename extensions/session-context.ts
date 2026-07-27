/**
 * Injects a "session context" message (current date/time, resolved OS/shell,
 * and git line-ending config) once at the start of each session, as a normal
 * visible conversation message rather than into the (cached) system prompt.
 *
 * Why not in the system prompt:
 * - Date changes daily (or per-message, if we included seconds), which would
 *   invalidate the provider's prompt cache on every request. Pi's own
 *   maintainers deliberately removed the date from the default system
 *   prompt for this reason (CHANGELOG.md, issue #6621). Putting it back in
 *   the system prompt would reintroduce that regression.
 * - Injecting it as a one-time conversation message instead only appends
 *   new content; it never rewrites the cached prefix.
 *
 * Why visible (display: true):
 * - Hidden context injection is undesirable (no hidden control flow). The
 *   user should be able to see exactly what was added to the conversation.
 *
 * Shell/OS detection:
 * - Uses `getShellConfig()`, the same public helper pi's own bash tool uses
 *   internally to resolve the actual shell (Git Bash on Windows, /bin/bash
 *   on Unix, or a user-configured shellPath), instead of re-guessing.
 *
 * Line-ending detection:
 * - Reports `core.autocrlf`/`core.eol` git config and whether a
 *   `.gitattributes` file is present, since CRLF/LF mismatches are a
 *   recurring source of edit/diff breakage on Windows.
 *
 * Trigger:
 * - The message is injected at the first agent run only for a fresh session:
 *   a startup session with no entries, or a `/new` session. It is not injected
 *   after `/resume`, `/reload`, or `/fork`.
 *
 * Toggle:
 * - `/session-context on|off|status` persists the enabled flag to
 *   ~/.pi/agent/session-context.json so the choice survives across
 *   sessions (the injection only happens once per session, so an
 *   in-memory-only toggle would be useless). The command's own
 *   `description` (shown in autocomplete/help) documents usage, so the
 *   handler itself stays minimal.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATE_PATH = join(homedir(), ".pi", "agent", "session-context.json");

interface State {
	enabled: boolean;
}

function readState(): State {
	try {
		const raw = readFileSync(STATE_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		return { enabled: parsed.enabled !== false };
	} catch {
		return { enabled: true };
	}
}

function writeState(state: State): void {
	mkdirSync(dirname(STATE_PATH), { recursive: true });
	writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function describeShell(): string {
	try {
		const { shell } = getShellConfig();
		return shell;
	} catch {
		return "unknown shell";
	}
}

function describePlatform(): string {
	switch (process.platform) {
		case "win32":
			return "Windows";
		case "darwin":
			return "macOS";
		case "linux":
			return "Linux";
		default:
			return process.platform;
	}
}

/**
 * Reads an effective (merged local+global+system) git config value.
 * `--get` (no --local/--global/--system) works even when `cwd` is not
 * inside a git repo: git just skips the local layer and falls through to
 * global/system config, unlike commands such as `git status` that require
 * a repo. If the key is unset anywhere, `git config --get` exits non-zero
 * and we report "unset" rather than throwing.
 *
 * Note: this only checks `cwd` itself, not parent directories, so a
 * `.gitattributes` in a parent of a monorepo subdirectory won't be seen.
 */
function gitConfig(key: string, cwd: string): string | undefined {
	try {
		return execFileSync("git", ["config", "--get", key], { cwd, encoding: "utf-8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function describeLineEndings(cwd: string): string {
	const autocrlf = gitConfig("core.autocrlf", cwd);
	const eol = gitConfig("core.eol", cwd);
	const hasGitattributes = existsSync(join(cwd, ".gitattributes"));
	const parts = [
		`core.autocrlf=${autocrlf ?? "unset"}`,
		`core.eol=${eol ?? "unset"}`,
		`.gitattributes=${hasGitattributes ? "present" : "absent"}`,
	];
	return parts.join(", ");
}

function buildContextMessage(cwd: string): string {
	const now = new Date();
	return [
		"Session context:",
		`- Date/time: ${now.toString()}`,
		`- OS: ${describePlatform()}`,
		`- Shell: ${describeShell()}`,
		"- Paths: use shell-specific path syntax only in bash tool commands; use native OS path syntax for every other tool call.",
		`- Line endings: ${describeLineEndings(cwd)}`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	let injected = false;
	let isFreshSession = false;

	pi.registerCommand("session-context", {
		description: "Toggle the one-time date/env/line-ending context message injected at session start (usage: on|off|status)",
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();

			if (arg === "on") {
				writeState({ enabled: true });
				ctx.ui.notify("session-context: enabled (takes effect next session)", "info");
				return;
			}

			if (arg === "off") {
				writeState({ enabled: false });
				ctx.ui.notify("session-context: disabled (takes effect next session)", "info");
				return;
			}

			ctx.ui.notify(`session-context: ${readState().enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.on("session_start", (event, ctx) => {
		isFreshSession =
			(event.reason === "startup" || event.reason === "new") &&
			ctx.sessionManager.getEntries().length === 0;
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (injected || !isFreshSession) return;
		injected = true;

		if (!readState().enabled) return;

		return {
			message: {
				customType: "session-context",
				content: buildContextMessage(ctx.cwd),
				display: true,
			},
		};
	});

	pi.on("session_shutdown", () => {
		injected = false;
		isFreshSession = false;
	});
}
