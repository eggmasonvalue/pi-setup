import type { AgentMessage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SHAKE_ENTRY = "shake-boundary";

interface ShakeBoundary {
	createdAt: string;
	sourceSession?: string;
	messageCount: number;
}

function restoreShakeBoundary(ctx: ExtensionContext): ShakeBoundary | undefined {
	let boundary: ShakeBoundary | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== SHAKE_ENTRY) continue;
		const data = entry.data as ShakeBoundary | undefined;
		if (typeof data?.createdAt === "string" && typeof data.messageCount === "number") {
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

function describeToolCall(content: any): string {
	const name = typeof content.name === "string" ? content.name : "unknown";
	const args = content.arguments as Record<string, unknown> | undefined;
	if (!args || typeof args !== "object") return name;

	const path = ["path", "file", "filePath"].find((key) => typeof args[key] === "string");
	if (path) return `${name} ${args[path]}`;
	if (Array.isArray(args.paths)) return `${name} ${args.paths.join(", ")}`;
	if (typeof args.command === "string") return `${name} ${args.command}`;
	if (typeof args.query === "string") return `${name} ${JSON.stringify(args.query)}`;
	if (typeof args.action === "string") return `${name} ${args.action}`;

	const serialized = stringifyMetadata(args);
	return serialized ? `${name} ${serialized}` : name;
}

function projectHistoricalMessages(messages: AgentMessage[]): AgentMessage[] {
	const projected: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") continue;

		if (message.role === "bashExecution") {
			projected.push({
				role: "assistant",
				content: [
					{
						type: "text",
						text: `bash ${message.command}${
							message.cancelled ? " (cancelled)" : ` (exit ${message.exitCode ?? "unknown"})`
						}`,
					},
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
			const content = message.content.flatMap((block: any) => {
				if (block.type === "text" || block.type === "thinking") return [block];
				if (block.type === "toolCall") {
					return [{ type: "text", text: describeToolCall(block) }];
				}
				return [];
			});

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
		`Shake: already applied\nCreated: ${boundary.createdAt}\nProjected messages: ${boundary.messageCount}${source}`,
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
		description: "Replace the current session with a deterministic historical-tool projection",
		handler: async (args, ctx) => {
			const command = (args ?? "").trim().toLowerCase();
			if (command === "status") {
				notifyBoundaryStatus(ctx, boundary);
				return;
			}

			if (command) {
				ctx.ui.notify("Usage: /shake [status]", "warning");
				return;
			}

			if (boundary) {
				ctx.ui.notify("This session has already been shaken; raw history will not be restored.", "warning");
				return;
			}

			await ctx.waitForIdle();
			const sessionFile = ctx.sessionManager.getSessionFile();
			const sessionContext = ctx.sessionManager.buildSessionContext();
			const projectedMessages = projectHistoricalMessages(sessionContext.messages);
			const boundary: ShakeBoundary = {
				createdAt: new Date().toISOString(),
				sourceSession: sessionFile,
				messageCount: projectedMessages.length,
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
					sessionManager.appendCustomEntry(SHAKE_ENTRY, boundary);
				},
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify(
						`Shake complete: ${projectedMessages.length} projected messages retained; raw history archived in the parent session.`,
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
