import type { AgentMessage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface ShakeState {
	enabled: boolean;
}

function restoreEnabled(ctx: ExtensionContext): boolean {
	let enabled = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "shake-config") {
			const data = entry.data as ShakeState | undefined;
			if (typeof data?.enabled === "boolean") enabled = data.enabled;
		}
	}
	return enabled;
}

function pruneHistoricalToolTraffic(messages: AgentMessage[]): AgentMessage[] {
	if (messages.length === 0) return messages;

	// Keep the active turn untouched so tool loops still work.
	let lastUserIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			lastUserIndex = i;
			break;
		}
	}

	const out: AgentMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const inActiveTurn = lastUserIndex >= 0 && i >= lastUserIndex;
		if (inActiveTurn) {
			out.push(msg);
			continue;
		}

		// Drop historical tool results (largest token source).
		if (msg.role === "toolResult") continue;

		// Optionally strip historical assistant tool calls/thinking, keep text only.
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const kept = msg.content.filter((c) => c.type === "text");
			if (kept.length === 0) continue;
			out.push({ ...msg, content: kept });
			continue;
		}

		out.push(msg);
	}

	return out;
}

export default function shakeExtension(pi: ExtensionAPI) {
	let enabled = false;

	const persist = () => {
		pi.appendEntry<ShakeState>("shake-config", { enabled });
	};

	const setEnabled = (next: boolean, ctx: ExtensionContext) => {
		enabled = next;
		persist();
		ctx.ui.notify(`Shake ${enabled ? "enabled" : "disabled"}`, "info");
	};

	pi.on("session_start", async (_event, ctx) => {
		enabled = restoreEnabled(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		enabled = restoreEnabled(ctx);
	});

	pi.registerCommand("shake", {
		description: "Prune historical tool traffic from LLM context (on/off/toggle/status)",
		handler: async (args, ctx) => {
			const cmd = (args ?? "").trim().toLowerCase();
			if (!cmd || cmd === "toggle") {
				setEnabled(!enabled, ctx);
				return;
			}
			if (cmd === "on") return setEnabled(true, ctx);
			if (cmd === "off") return setEnabled(false, ctx);
			if (cmd === "status") {
				ctx.ui.notify(`Shake is ${enabled ? "ON" : "OFF"}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /shake [on|off|toggle|status]", "warning");
		},
	});

	pi.on("context", async (event) => {
		if (!enabled) return;
		return { messages: pruneHistoricalToolTraffic(event.messages) };
	});
}
