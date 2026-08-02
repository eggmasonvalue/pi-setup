import type { AgentMessage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SHAKE_ENTRY = "shake-boundary";
type ReasoningMode = "full" | "text" | "none";

const TOOL_ACTIVITY_START =
	"[Historical tool activity removed by Shake. Tool definitions and outputs are unavailable; do not replay these calls.]";
const TOOL_ACTIVITY_END = "[End historical tool activity]";

interface ShakeBoundary {
	createdAt: string;
	sourceSession?: string;
	messageCount: number;
	reasoningMode: ReasoningMode;
}

function restoreShakeBoundary(ctx: ExtensionContext): ShakeBoundary | undefined {
	let boundary: ShakeBoundary | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== SHAKE_ENTRY) continue;
		const data = entry.data as ShakeBoundary | undefined;
		if (
			typeof data?.createdAt === "string" &&
			typeof data.messageCount === "number" &&
			(data.reasoningMode === "full" || data.reasoningMode === "text" || data.reasoningMode === "none")
		) {
			boundary = data;
		}
	}
	return boundary;
}

function stringifyMetadata(value: unknown): string | undefined {
	try {
		const text = JSON.stringify(value);
		return text && text !== "{}" ? text : undefined;
	} catch {
		return undefined;
	}
}

function describeToolCall(content: any, status: string): string {
	const name = typeof content.name === "string" ? content.name : "unknown";
	const args = content.arguments as Record<string, unknown> | undefined;
	let summary = name;

	if (args && typeof args === "object") {
		const path = ["path", "file", "filePath"].find((key) => typeof args[key] === "string");
		if (path) summary = `${name} ${args[path]}`;
		else if (Array.isArray(args.paths)) summary = `${name} ${args.paths.join(", ")}`;
		else if (typeof args.command === "string") summary = `${name} ${args.command}`;
		else if (typeof args.query === "string") summary = `${name} ${JSON.stringify(args.query)}`;
		else if (typeof args.action === "string") summary = `${name} ${args.action}`;
		else {
			const serialized = stringifyMetadata(args);
			if (serialized) summary = `${name} ${serialized}`;
		}
	}

	return `${summary} — ${status}`;
}

function projectHistoricalMessages(messages: AgentMessage[], reasoningMode: ReasoningMode): AgentMessage[] {
	const resultStatus = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			resultStatus.set(message.toolCallId, message.isError ? "failed" : "completed");
		}
	}

	const projected: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") continue;

		if (message.role === "bashExecution") {
			projected.push({
				role: "assistant",
				content: [
					{ type: "text", text: TOOL_ACTIVITY_START },
					{
						type: "text",
						text: `bash ${message.command} — ${
							message.cancelled ? "cancelled" : `exit ${message.exitCode ?? "unknown"}`
						}`,
					},
					{ type: "text", text: TOOL_ACTIVITY_END },
				],
				api: "shake",
				provider: "shake",
				model: "shake",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: message.timestamp,
			});
			continue;
		}

		if (message.role === "assistant") {
			const content: any[] = [];
			let toolActivityOpen = false;
			for (const block of message.content as any[]) {
				if (block.type === "text") {
					content.push(block);
					continue;
				}
				if (block.type === "thinking") {
					if (reasoningMode === "full") content.push(block);
					if (reasoningMode === "text") content.push({ type: "text", text: block.thinking });
					continue;
				}
				if (block.type === "toolCall") {
					if (!toolActivityOpen) {
						content.push({ type: "text", text: TOOL_ACTIVITY_START });
						toolActivityOpen = true;
					}
					content.push({
						type: "text",
						text: describeToolCall(block, resultStatus.get(block.id) ?? "status unknown"),
					});
				}
			}
			if (toolActivityOpen) content.push({ type: "text", text: TOOL_ACTIVITY_END });

			if (content.length === 0) continue;
			projected.push({ ...message, content });
			continue;
		}

		if (message.role === "compactionSummary") {
			projected.push({
				role: "assistant",
				content: [{ type: "text", text: `[Earlier compaction summary]\n${message.summary}` }],
				api: "shake",
				provider: "shake",
				model: "shake",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: message.timestamp,
			});
			continue;
		}

		if (message.role === "branchSummary") {
			projected.push({
				role: "assistant",
				content: [{ type: "text", text: `[Earlier branch summary]\n${message.summary}` }],
				api: "shake",
				provider: "shake",
				model: "shake",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: message.timestamp,
			});
			continue;
		}

		projected.push(message);
	}

	return projected;
}

function notifyBoundaryStatus(ctx: ExtensionContext, boundary: ShakeBoundary | undefined): void {
	if (!boundary) {
		ctx.ui.notify("Shake: not applied to this session", "info");
		return;
	}

	const source = boundary.sourceSession ? `\nOriginal session: ${boundary.sourceSession}` : "";
	ctx.ui.notify(
		`Shake: already applied\nReasoning: ${boundary.reasoningMode}\nCreated: ${boundary.createdAt}\nProjected messages: ${boundary.messageCount}${source}`,
		"info",
	);
}

export default function shakeExtension(pi: ExtensionAPI) {
	let boundary: ShakeBoundary | undefined;

	pi.on("session_start", async (_event, ctx) => {
		boundary = restoreShakeBoundary(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		boundary = restoreShakeBoundary(ctx);
	});

	pi.registerCommand("shake", {
		description: "Create a shaken session (default: text reasoning). Usage: /shake [full|text|none|status]",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "full", label: "full", description: "Keep readable reasoning and native reasoning state" },
				{ value: "text", label: "text", description: "Keep readable reasoning only (default)" },
				{ value: "none", label: "none", description: "Remove historical reasoning" },
				{ value: "status", label: "status", description: "Show Shake boundary details" },
			];
			return options.filter((option) => option.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const command = (args ?? "").trim().toLowerCase();
			if (command === "status") {
				notifyBoundaryStatus(ctx, boundary);
				return;
			}

			const reasoningMode: ReasoningMode = command === "" ? "text" : command as ReasoningMode;
			if (reasoningMode !== "full" && reasoningMode !== "text" && reasoningMode !== "none") {
				ctx.ui.notify("Usage: /shake [full|text|none|status]", "warning");
				return;
			}

			if (boundary) {
				ctx.ui.notify("This session has already been shaken; raw history will not be restored.", "warning");
				return;
			}

			await ctx.waitForIdle();
			const sessionFile = ctx.sessionManager.getSessionFile();
			const sessionContext = ctx.sessionManager.buildSessionContext();
			const projectedMessages = projectHistoricalMessages(sessionContext.messages, reasoningMode);
			const newBoundary: ShakeBoundary = {
				createdAt: new Date().toISOString(),
				sourceSession: sessionFile,
				messageCount: projectedMessages.length,
				reasoningMode,
			};

			const result = await ctx.newSession({
				parentSession: sessionFile,
				setup: async (sessionManager) => {
					if (sessionContext.model) {
						sessionManager.appendModelChange(sessionContext.model.provider, sessionContext.model.modelId);
					}
					sessionManager.appendThinkingLevelChange(sessionContext.thinkingLevel);
					for (const message of projectedMessages) {
						sessionManager.appendMessage(message as any);
					}
					sessionManager.appendCustomEntry(SHAKE_ENTRY, newBoundary);
				},
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify(
						`Shake complete (${reasoningMode} reasoning): ${projectedMessages.length} projected messages retained; raw history archived in the parent session.`,
						"info",
					);
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("Shake cancelled", "warning");
				return;
			}
		},
	});
}
