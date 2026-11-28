import { buildSessionContext, type ExtensionAPI, type SessionContext } from "@earendil-works/pi-coding-agent";

type AgentMessage = SessionContext["messages"][number];

const SHAKE_MARKER = "shake: deterministic condensed compaction";

// Read by future models that know nothing about Shake; keep it self-explanatory.
const PREAMBLE =
	"Earlier conversation, condensed. Tool outputs were removed; each tool call is a one-line record `[tool] summary → outcome`. The calls ran and their effects, such as file edits, persist. Rerun tools when you need their output.";
const THINKING_LABEL = "Assistant's thinking summary";
const THINKING_NOTE = `[${THINKING_LABEL}] lines are short summaries of the assistant's reasoning written for the user to read, not the reasoning itself.`;

export interface CondenseOptions {
	/** Include the readable thinking summaries shown in the transcript. Set via `"shake": { "thinking": true }` in settings.json. */
	thinking?: boolean;
}

function record(tool: string, summary: string, outcome: string | undefined): string {
	return `[${tool}]${summary ? ` ${summary}` : ""}${outcome ? ` → ${outcome}` : ""}`;
}

function summarizeArgs(args: Record<string, unknown> | undefined): string {
	if (!args || typeof args !== "object") return "";
	if (typeof args.description === "string") return args.description;
	const path = ["path", "file", "filePath"].find((key) => typeof args[key] === "string");
	if (path) return String(args[path]);
	if (Array.isArray(args.paths)) return args.paths.join(", ");
	if (typeof args.command === "string") return args.command;
	if (typeof args.query === "string") return JSON.stringify(args.query);
	if (typeof args.action === "string") return args.action;
	try {
		const text = JSON.stringify(args);
		return text && text !== "{}" ? text : "";
	} catch {
		return "";
	}
}

function bashOutcome(exitCode: number | undefined, cancelled: boolean, output: string): string | undefined {
	if (cancelled) return "aborted";
	if (exitCode === undefined) return "no result";
	if (exitCode !== 0) return `exit ${exitCode}`;
	return output.trim() ? undefined : "no output";
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content.trim();
	return content
		.flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
		.join("\n")
		.trim();
}

/** Condense history into text: tool calls become one-line records; tool outputs and images are dropped, reasoning unless opted in. */
export function condense(messages: AgentMessage[], { thinking = false }: CondenseOptions = {}): string {
	const outcomes = new Map<string, string | undefined>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const outcome = (message.details as { outcome?: unknown } | undefined)?.outcome;
		outcomes.set(message.toolCallId, typeof outcome === "string" ? outcome : message.isError ? "error" : undefined);
	}

	const lines = [thinking ? `${PREAMBLE} ${THINKING_NOTE}` : PREAMBLE, ""];
	const line = (label: string, text: string) => text && lines.push(`[${label}]: ${text}`);
	for (const message of messages) {
		switch (message.role) {
			case "user":
				line("User", textOf(message.content));
				break;
			case "assistant": {
				if (thinking)
					for (const block of message.content)
						if (block.type === "thinking" && !block.redacted) line(THINKING_LABEL, block.thinking.trim());
				line("Assistant", textOf(message.content));
				const calls = message.content.flatMap((block) =>
					block.type === "toolCall"
						? [record(block.name, summarizeArgs(block.arguments), outcomes.has(block.id) ? outcomes.get(block.id) : "no result")]
						: [],
				);
				line("Tool calls", calls.join("; "));
				break;
			}
			case "bashExecution": {
				if (message.excludeFromContext) break;
				const outcome = bashOutcome(message.exitCode, message.cancelled, message.output);
				line("User ran", `${message.command}${outcome ? ` → ${outcome}` : ""}`);
				break;
			}
			case "compactionSummary":
			case "branchSummary":
				line("Earlier summary", message.summary.trim());
				break;
		}
	}
	return lines.join("\n");
}

export default function shakeExtension(pi: ExtensionAPI) {
	pi.on("session_before_compact", (event) => {
		if (event.customInstructions !== SHAKE_MARKER) return;
		const options = (pi.getSettings() as { shake?: CondenseOptions }).shake;
		const summary = condense(buildSessionContext(event.branchEntries).messages, options);
		// null keeps no earlier entries: SessionManager.appendCompaction stores `firstKeptEntryId ?? id`.
		return { compaction: { summary, firstKeptEntryId: null as unknown as string, tokensBefore: event.preparation.tokensBefore } };
	});

	pi.registerCommand("shake", {
		description: "Compact the session deterministically: tool calls become one-line records, outputs are dropped",
		handler: async (_args, ctx) => {
			ctx.compact({
				customInstructions: SHAKE_MARKER,
				onComplete: () => ctx.ui.notify("Shaken. Full history stays available via /tree.", "info"),
				onError: (error) => ctx.ui.notify(`Shake failed: ${error.message}`, "error"),
			});
		},
	});
}
