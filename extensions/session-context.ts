/**
 * Injects a "session context" message (current date/time, resolved OS/shell,
 * and git line-ending config) once at the start of each fresh session, as a
 * normal visible conversation message rather than into the (cached) system prompt.
 *
 * Why not in the system prompt:
 * - Date changes daily (or per-message, if we included seconds), which would
 *   invalidate the provider's prompt cache on every request. Pi's own
 *   maintainers deliberately removed the date from the default system
 *   prompt for this reason.
 * - Injecting it as a one-time conversation message instead only appends
 *   new content; it never rewrites the cached prefix.
 *
 * Why visible (display: true):
 * - Hidden context injection is undesirable (no hidden control flow). The
 *   user should be able to see exactly what was added to the conversation.
 *
 * Shell/OS detection:
 * - Uses `getShellConfig(pi.getSettings().shellPath)`, matching Pi's bash tool
 *   resolution (configured `shellPath`, Git Bash on Windows, `/bin/bash` on Unix).
 *
 * Line-ending detection:
 * - Reports `core.autocrlf`/`core.eol` git config and whether a
 *   `.gitattributes` file is present in `cwd`, since CRLF/LF mismatches are a
 *   recurring source of edit/diff breakage on Windows.
 *
 * Trigger:
 * - Injected at the first user-initiated agent run of a fresh session (startup
 *   or `/new` with no prior conversation messages). Not injected after `/resume`,
 *   `/reload`, or `/fork`, nor on runs initiated by extension custom messages.
 *
 * Configuration & toggle:
 * - Configured in `settings.json` (global or project override via `pi.getSettings()`):
 *
 *     { "sessionContext": { "enabled": false } }
 *
 * - `/session-context on|off|status` updates the live state and persists
 *   `sessionContext.enabled` to global `settings.json` (leaving all other
 *   fields untouched). Defaults to `true` when unset.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, getShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const COMMAND_OPTIONS = ["on", "off", "status"] as const;

function getGlobalSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Persist only `sessionContext.enabled`, leaving every other settings.json field untouched. */
function writeSessionContextEnabled(enabled: boolean): void {
	const settingsPath = getGlobalSettingsPath();
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		settings = {};
	}
	const sessionContext = (settings.sessionContext as Record<string, unknown> | undefined) ?? {};
	settings.sessionContext = { ...sessionContext, enabled };
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function describeShell(customShellPath?: string): string {
	try {
		const { shell } = getShellConfig(customShellPath);
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
 * `--get` works even outside a git repo (falls through to global/system config).
 * Note: `.gitattributes` check is for `cwd` only, not parent directories.
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
	return [
		`core.autocrlf=${autocrlf ?? "unset"}`,
		`core.eol=${eol ?? "unset"}`,
		`.gitattributes=${hasGitattributes ? "present" : "absent"}`,
	].join(", ");
}

function buildContextMessage(cwd: string, customShellPath?: string): string {
	const now = new Date();
	return [
		"Session context:",
		`- Date/time: ${now.toString()}`,
		`- OS: ${describePlatform()}`,
		`- Shell: ${describeShell(customShellPath)}`,
		`- Line endings: ${describeLineEndings(cwd)}`,
	].join("\n");
}

export default function sessionContextExtension(pi: ExtensionAPI) {
	let injected = false;
	let isFreshSession = false;
	let enabledOverride: boolean | undefined;

	const isEnabled = (): boolean => {
		if (enabledOverride !== undefined) return enabledOverride;
		const configured = (pi.getSettings() as { sessionContext?: { enabled?: unknown } }).sessionContext?.enabled;
		return configured !== false;
	};

	pi.registerCommand("session-context", {
		description:
			"Toggle the one-time date/env/line-ending context message injected at session start (usage: on|off|status)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const normalized = prefix.trim().toLowerCase();
			const matches = COMMAND_OPTIONS.filter((opt) => opt.startsWith(normalized)).map((opt) => ({
				value: opt,
				label: opt,
			}));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();

			if (arg === "on" || arg === "off") {
				const next = arg === "on";
				enabledOverride = next;
				try {
					writeSessionContextEnabled(next);
					ctx.ui.notify(
						`session-context: ${next ? "enabled" : "disabled"} (saved to settings.json)`,
						"info",
					);
				} catch (err) {
					ctx.ui.notify(
						`session-context: ${next ? "enabled" : "disabled"} for this session, but saving to settings.json failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
						"warning",
					);
				}
				return;
			}

			ctx.ui.notify(`session-context: ${isEnabled() ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.on("session_start", (event, ctx) => {
		injected = false;
		enabledOverride = undefined;
		isFreshSession =
			(event.reason === "startup" || event.reason === "new") &&
			ctx.sessionManager
				.getEntries()
				.every((entry) => entry.type !== "message" && entry.type !== "custom_message");
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (injected || !isFreshSession || event.messageType !== "user") return;
		injected = true;

		if (!isEnabled()) return;

		return {
			message: {
				customType: "session-context",
				content: buildContextMessage(ctx.cwd, pi.getSettings().shellPath),
				display: true,
			},
		};
	});

	pi.on("session_shutdown", () => {
		injected = false;
		isFreshSession = false;
		enabledOverride = undefined;
	});
}
