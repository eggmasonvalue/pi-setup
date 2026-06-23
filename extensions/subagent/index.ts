/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "...", thinking?: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "...", thinking?: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ...", thinking?: "..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "inline" | "unknown";
	task: string;
	/** Optional caller-supplied correlation label, echoed in the model-facing envelope. */
	label?: string;
	/** True when this item was a resume of an existing session rather than a fresh run. */
	resumed?: boolean;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Absolute path to the child's persisted session JSONL, for observability/debugging. */
	sessionFile?: string;
	/** Child session id from the JSON session header. */
	sessionId?: string;
}

/**
 * A fully-resolved run spec. Either derived from a named agent file or
 * constructed inline from tool params. The main agent is the intelligence:
 * it can author a systemPrompt on the fly without a human-written .md file.
 */
interface ResolvedSpec {
	name: string;
	source: "user" | "project" | "inline";
	model?: string;
	thinking?: string;
	tools?: string[];
	systemPrompt: string;
}

interface ModelAllowlistConfig {
	enabled?: boolean;
	allowed?: string[];
	default?: string;
}

interface ModelPolicy {
	enabled: boolean;
	allowed: Set<string>;
	defaultModel?: string;
	configPath: string;
}

function getModelAllowlistPath(): string {
	return path.join(getAgentDir(), "extensions", "subagent", "models-allowlist.json");
}

function loadModelPolicy(): { policy: ModelPolicy; error?: string } {
	const configPath = getModelAllowlistPath();
	const basePolicy: ModelPolicy = {
		enabled: false,
		allowed: new Set<string>(),
		defaultModel: undefined,
		configPath,
	};

	if (!fs.existsSync(configPath)) return { policy: basePolicy };

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch (error) {
		return {
			policy: basePolicy,
			error: `Invalid JSON in model allowlist: ${configPath} (${error instanceof Error ? error.message : String(error)})`,
		};
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { policy: basePolicy, error: `Model allowlist must be a JSON object: ${configPath}` };
	}

	const config = parsed as ModelAllowlistConfig;
	if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
		return { policy: basePolicy, error: `"enabled" must be boolean in ${configPath}` };
	}
	if (config.allowed !== undefined && !Array.isArray(config.allowed)) {
		return { policy: basePolicy, error: `"allowed" must be an array of model strings in ${configPath}` };
	}
	if (config.default !== undefined && typeof config.default !== "string") {
		return { policy: basePolicy, error: `"default" must be a model string in ${configPath}` };
	}

	const allowed = new Set(
		(config.allowed ?? [])
			.filter((m): m is string => typeof m === "string")
			.map((m) => m.trim())
			.filter(Boolean),
	);
	const enabled = config.enabled ?? true;
	const defaultModel = config.default?.trim() || undefined;

	if (enabled && allowed.size === 0) {
		return { policy: basePolicy, error: `Model allowlist is enabled but "allowed" is empty in ${configPath}` };
	}
	if (enabled && defaultModel && !allowed.has(defaultModel)) {
		return {
			policy: basePolicy,
			error: `"default" model must be present in "allowed" in ${configPath}`,
		};
	}

	return {
		policy: {
			enabled,
			allowed,
			defaultModel,
			configPath,
		},
	};
}

function enforceModelPolicy(spec: ResolvedSpec, policy: ModelPolicy): { spec?: ResolvedSpec; error?: string } {
	if (!policy.enabled) return { spec };

	const model = spec.model ?? policy.defaultModel;
	if (!model) {
		return {
			error: `Model is required by allowlist policy. Provide \"model\" or set \"default\" in ${policy.configPath}.`,
		};
	}
	if (!policy.allowed.has(model)) {
		const allowedPreview = Array.from(policy.allowed).slice(0, 8).join(", ") || "(none)";
		const extra = policy.allowed.size > 8 ? ` (+${policy.allowed.size - 8} more)` : "";
		return {
			error: `Model \"${model}\" is not in allowlist (${policy.configPath}). Allowed: ${allowedPreview}${extra}`,
		};
	}

	return { spec: { ...spec, model } };
}

function resolveSpec(
	agents: AgentConfig[],
	item: {
		agent?: string;
		systemPrompt?: string;
		model?: string;
		thinking?: string;
		tools?: string[];
	},
	policy: ModelPolicy,
): { spec?: ResolvedSpec; error?: string } {
	if (item.agent) {
		const agent = agents.find((a) => a.name === item.agent);
		if (!agent) {
			const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
			return { error: `Unknown agent: "${item.agent}". Available agents: ${available}.` };
		}
		return enforceModelPolicy(
			{
				name: agent.name,
				source: agent.source,
				model: item.model ?? agent.model,
				thinking: item.thinking,
				tools: item.tools ?? agent.tools,
				systemPrompt: agent.systemPrompt,
			},
			policy,
		);
	}
	return enforceModelPolicy(
		{
			name: "inline",
			source: "inline",
			model: item.model,
			thinking: item.thinking,
			tools: item.tools,
			systemPrompt: item.systemPrompt ?? "",
		},
		policy,
	);
}

function failedSpecResult(name: string, task: string, step: number | undefined, error: string): SingleResult {
	return {
		agent: name,
		agentSource: "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: error,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		step,
	};
}

interface RunItem {
	task: string;
	agent?: string;
	systemPrompt?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	cwd?: string;
	resume?: string;
	timeoutMs?: number;
	label?: string;
}

type RunOpts = { resume?: string; timeoutMs?: number; label?: string };

/**
 * Resolve an item into a runnable spec + per-run opts. Resume bypasses spec
 * resolution (model/tools/systemPrompt are fixed by the original session) and is
 * mutually exclusive with those fields.
 */
function resolveRunPlan(
	agents: AgentConfig[],
	item: RunItem,
	policy: ModelPolicy,
): { spec?: ResolvedSpec; opts: RunOpts; error?: string } {
	const opts: RunOpts = {
		resume: item.resume?.trim() || undefined,
		timeoutMs: item.timeoutMs,
		label: item.label,
	};
	if (opts.resume) {
		if (item.agent || item.systemPrompt || item.model || (item.tools && item.tools.length > 0)) {
			return { opts, error: "resume is mutually exclusive with agent/systemPrompt/model/tools." };
		}
		if (!item.task || !item.task.trim()) {
			return { opts, error: "resume requires a continuation `task` (the steering prompt for the resumed session)." };
		}
		return {
			spec: { name: "resume", source: "inline", thinking: item.thinking, systemPrompt: "" },
			opts,
		};
	}
	const { spec, error } = resolveSpec(agents, item, policy);
	return { spec, opts, error };
}

/** Tally per-status counts for the aggregate header. */
function tallyStatuses(results: SingleResult[]): string {
	const counts = new Map<string, number>();
	for (const r of results) counts.set(statusOf(r), (counts.get(statusOf(r)) ?? 0) + 1);
	const order = ["done", "failed", "timeout", "aborted", "never-started", "running"];
	return order
		.filter((s) => counts.has(s))
		.map((s) => `${counts.get(s)} ${s}`)
		.join(" \u00b7 ");
}

function unfinishedNote(results: SingleResult[]): string {
	const stuck = results.filter((r) => r.stopReason === "aborted" || r.stopReason === "timeout");
	if (stuck.length === 0) return "";
	return `\n\nNote: ${stuck.length} task(s) did not finish. Their partial output + session path are above; inspect the JSONL and continue with subagent { resume: <session>, task: <steer> }.`;
}

function sessionFooter(result: SingleResult): string {
	return result.sessionFile ? `\n\n\u2014 session: ${result.sessionFile}` : "";
}

/** Resolve the child's persisted session JSONL (single file in our run dir). Idempotent. */
function resolveSessionFile(sessionDir: string, result: SingleResult): void {
	if (result.sessionFile) return;
	try {
		const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
		if (files.length > 0) result.sessionFile = path.join(sessionDir, files[0]);
	} catch {
		/* ignore */
	}
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

const NON_SUCCESS_STOP_REASONS = new Set(["error", "aborted", "timeout", "never-started"]);

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || NON_SUCCESS_STOP_REASONS.has(result.stopReason ?? "");
}

/** Single-word status for the model-facing envelope. */
function statusOf(result: SingleResult): string {
	switch (result.stopReason) {
		case "never-started":
			return "never-started";
		case "aborted":
			return "aborted";
		case "timeout":
			return "timeout";
	}
	if (result.exitCode === -1) return "running";
	return isFailedResult(result) ? "failed" : "done";
}

/**
 * The terse, model-facing header line. Carries only what the *tool* uniquely
 * knows (status, model, label, session, cost). The child's own output is passed
 * through verbatim by the caller — the tool does not impose a payload format.
 */
function buildEnvelope(result: SingleResult): string {
	const parts: string[] = [];
	if (result.label) parts.push(`label=${result.label}`);
	parts.push(`agent=${result.agent}`);
	if (result.resumed) parts.push("resumed=true");
	parts.push(`status=${statusOf(result)}`);
	if (result.step) parts.push(`step=${result.step}`);
	if (result.model) parts.push(`model=${result.model}`);
	if (result.usage.turns) parts.push(`turns=${result.usage.turns}`);
	if (result.usage.cost) parts.push(`cost=${result.usage.cost.toFixed(4)}`);
	parts.push(`exit=${result.stopReason ?? "end"}`);
	if (result.sessionFile) parts.push(`session=${result.sessionFile}`);
	return `[${parts.join(" ")}]`;
}

/** Envelope header + the child's verbatim (byte-capped) output. */
function buildTaskBlock(result: SingleResult): string {
	return `${buildEnvelope(result)}\n${truncateParallelOutput(getResultOutput(result))}`;
}

function neverStartedResult(
	name: string,
	agentSource: SingleResult["agentSource"],
	task: string,
	label: string | undefined,
	step: number | undefined,
): SingleResult {
	return {
		agent: name,
		agentSource,
		task,
		label,
		exitCode: 1,
		messages: [],
		stderr: "",
		stopReason: "never-started",
		errorMessage: "Did not start: run was aborted before this task launched.",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		step,
	};
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	spec: ResolvedSpec,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	opts?: { resume?: string; timeoutMs?: number; label?: string },
): Promise<SingleResult> {
	const resumePath = opts?.resume?.trim() || undefined;
	// Persist the child's session so the main agent can read the full transcript
	// for debugging. This is the observability bridge: a path, not a framework.
	const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const sessionDir = path.join(getAgentDir(), "sessions", "subagent", runId);
	if (!resumePath) {
		try {
			await fs.promises.mkdir(sessionDir, { recursive: true });
		} catch {
			/* best effort; pi will fall back to its default session dir */
		}
	}

	// Resume continues the *same* session (appends turns) via --session; a fresh
	// run gets its own --session-dir. Resume ignores model/tools/systemPrompt
	// (fixed by the original session) but still honors thinking/cwd/timeout.
	const args: string[] = ["--mode", "json", "-p"];
	if (resumePath) args.push("--session", resumePath);
	else args.push("--session-dir", sessionDir);
	if (!resumePath && spec.model) args.push("--model", spec.model);
	if (spec.thinking) args.push("--thinking", spec.thinking);
	if (!resumePath && spec.tools && spec.tools.length > 0) args.push("--tools", spec.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: spec.name,
		agentSource: spec.source,
		task,
		label: opts?.label,
		resumed: Boolean(resumePath),
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: resumePath ? undefined : spec.model,
		step,
	};
	// For a resume we already know which session is being continued; surface it
	// immediately so it is attached even if the resume is aborted early.
	if (resumePath) {
		currentResult.sessionFile = resumePath;
	}

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (!resumePath && spec.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(spec.name, spec.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;
		let wasTimeout = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

			const killProc = (timeout: boolean) => {
				if (timeout) wasTimeout = true;
				else wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "session" && event.id) {
					currentResult.sessionId = event.id;
					// The child writes its JSONL at session start, so the path is
					// available immediately \u2014 surface it live (for the human) and so it
					// is already attached if the run is aborted mid-flight.
					if (!resumePath) resolveSessionFile(sessionDir, currentResult);
					emitUpdate();
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (timeoutTimer) clearTimeout(timeoutTimer);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				if (timeoutTimer) clearTimeout(timeoutTimer);
				resolve(1);
			});

			if (opts?.timeoutMs && opts.timeoutMs > 0) {
				timeoutTimer = setTimeout(() => killProc(true), opts.timeoutMs);
			}

			if (signal) {
				const onAbort = () => killProc(false);
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		// Resolve the persisted session file path (fallback if the start event was missed).
		if (!resumePath) resolveSessionFile(sessionDir, currentResult);
		// Abort/timeout no longer throw: return the partial result so completed work
		// is never discarded and the session path stays inspectable/resumable.
		if (wasTimeout) currentResult.stopReason = "timeout";
		else if (wasAborted) currentResult.stopReason = "aborted";
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	task: Type.String({ description: "Task to delegate to the subagent" }),
	label: Type.Optional(Type.String({ description: "Correlation label echoed in the result envelope (e.g. repo/feature name)." })),
	agent: Type.Optional(Type.String({ description: "Optional named agent. If omitted, runs inline." })),
	systemPrompt: Type.Optional(Type.String({ description: "Inline system prompt (appended). Used when no agent is named." })),
	model: Type.Optional(Type.String({ description: "Model for the subagent, e.g. 'sonnet' or 'provider/id'." })),
	thinking: Type.Optional(Type.String({ description: "Thinking level for the subagent model." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist, e.g. ['read','grep','bash']." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	resume: Type.Optional(
		Type.String({
			description:
				"Resume an existing child session (path or partial id) and append `task` as the next turn. Mutually exclusive with agent/systemPrompt/model/tools.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({ description: "Kill the child after this many ms and return partial output (stopReason=timeout). No default." }),
	),
});

const ChainItem = Type.Object({
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	label: Type.Optional(Type.String({ description: "Correlation label echoed in the result envelope." })),
	agent: Type.Optional(Type.String({ description: "Optional named agent. If omitted, runs inline." })),
	systemPrompt: Type.Optional(Type.String({ description: "Inline system prompt (appended). Used when no agent is named." })),
	model: Type.Optional(Type.String({ description: "Model for the subagent, e.g. 'sonnet' or 'provider/id'." })),
	thinking: Type.Optional(Type.String({ description: "Thinking level for the subagent model." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist, e.g. ['read','grep','bash']." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	resume: Type.Optional(
		Type.String({
			description:
				"Resume an existing child session (path or partial id) and append `task` as the next turn. Mutually exclusive with agent/systemPrompt/model/tools.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({ description: "Kill the child after this many ms and return partial output (stopReason=timeout). No default." }),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	label: Type.Optional(Type.String({ description: "Correlation label echoed in the result envelope (single mode)." })),
	agent: Type.Optional(Type.String({ description: "Optional named agent (single mode). If omitted, runs inline." })),
	systemPrompt: Type.Optional(Type.String({ description: "Inline system prompt (single mode). Used when no agent is named." })),
	model: Type.Optional(Type.String({ description: "Model for the subagent (single mode)." })),
	thinking: Type.Optional(Type.String({ description: "Thinking level for the subagent model (single mode)." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist (single mode)." })),
	resume: Type.Optional(
		Type.String({
			description:
				"Resume an existing child session (path or partial id) and append `task` as the next turn (single mode). Mutually exclusive with agent/systemPrompt/model/tools.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({ description: "Kill the child after this many ms and return partial output (stopReason=timeout). No default." }),
	),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of tasks for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of steps for sequential execution" })),
	listModels: Type.Optional(
		Type.Boolean({ description: "Return the model allowlist + resolved default and exit (no subagent is spawned)." }),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	const { policy: registrationPolicy } = loadModelPolicy();
	const defaultModelNote =
		registrationPolicy.enabled && registrationPolicy.defaultModel
			? ` Default child model: ${registrationPolicy.defaultModel} (allowlist active; call with {listModels:true} to see options).`
			: " Call with {listModels:true} to see allowed child models and the default.";
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a task to a subagent running in an isolated context (separate pi process).",
			"Provide `task` plus optional inline `systemPrompt`, `model`, `thinking`, and `tools`. Named agents are optional, not required.",
			"Modes: single (task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Resume an interrupted/aborted child with {resume:<session>, task:<steer>}; bound a run with {timeoutMs}.",
			"On abort/timeout, completed tasks still return their output and every task keeps its session path (per-task status: done/failed/timeout/aborted/never-started).",
			"Each result is prefixed with a terse [key=value] envelope (status, model, label, session); the child's own output follows verbatim.",
			"Optional model allowlist: ~/.pi/agent/extensions/subagent/models-allowlist.json (exact model strings, optional default).",
			"Each subagent's full transcript is persisted; the session file path is returned so you can read it to verify or debug." +
				defaultModelNote,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const { policy: modelPolicy, error: modelPolicyError } = loadModelPolicy();

			if (params.listModels) {
				const allowed = Array.from(modelPolicy.allowed);
				const payload = {
					allowlistEnabled: modelPolicy.enabled,
					default: modelPolicy.defaultModel ?? null,
					allowed,
					configPath: modelPolicy.configPath,
					note: modelPolicy.enabled
						? "Set `model` per task to one of `allowed`; omit to use `default`."
						: "Allowlist disabled: any model the harness supports may be used; omitting `model` inherits the harness default.",
				};
				return {
					content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
					details: {
						mode: "single" as const,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results: [],
					},
				};
			}

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modelPolicyError) {
				return {
					content: [{ type: "text", text: modelPolicyError }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) if (step.agent) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) if (t.agent) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					if (signal?.aborted) {
						results.push(neverStartedResult(step.agent ?? "inline", "unknown", taskWithContext, step.label, i + 1));
						break;
					}

					const { spec, opts, error } = resolveRunPlan(agents, { ...step, task: taskWithContext }, modelPolicy);
					if (error || !spec) {
						results.push(failedSpecResult(step.agent ?? "inline", taskWithContext, i + 1, error ?? "resolve failed"));
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1}: ${error ?? "resolve failed"}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						spec,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						opts,
					);
					results.push(result);

					if (isFailedResult(result)) {
						// Flush every completed step's block, not just the failing one.
						const blocks = results.map(buildTaskBlock).join("\n\n---\n\n");
						const header = `chain stopped at step ${i + 1} (${statusOf(result)}) \u00b7 ${tallyStatuses(results)}`;
						return {
							content: [{ type: "text", text: `${header}\n\n${blocks}${unfinishedNote(results)}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				const last = results[results.length - 1];
				return {
					content: [{ type: "text", text: buildTaskBlock(last) }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].resume ? "resume" : (params.tasks[i].agent ?? "inline"),
						agentSource: "unknown",
						task: params.tasks[i].task,
						label: params.tasks[i].label,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					if (signal?.aborted) {
						const ns = neverStartedResult(t.resume ? "resume" : (t.agent ?? "inline"), "unknown", t.task, t.label, undefined);
						allResults[index] = ns;
						emitParallelUpdate();
						return ns;
					}
					const { spec, opts, error } = resolveRunPlan(agents, t, modelPolicy);
					if (error || !spec) {
						const failed = failedSpecResult(t.agent ?? "inline", t.task, undefined, error ?? "resolve failed");
						failed.label = t.label;
						allResults[index] = failed;
						emitParallelUpdate();
						return failed;
					}
					const result = await runSingleAgent(
						ctx.cwd,
						spec,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						opts,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const blocks = results.map(buildTaskBlock);
				const header = `subagent parallel \u00b7 ${tallyStatuses(results)} (of ${results.length})`;
				return {
					content: [
						{
							type: "text",
							text: `${header}\n\n${blocks.join("\n\n---\n\n")}${unfinishedNote(results)}`,
						},
					],
					details: makeDetails("parallel")(results),
					isError: successCount === 0,
				};
			}

			if (params.task) {
				const { spec, opts, error } = resolveRunPlan(agents, params as RunItem, modelPolicy);
				if (error || !spec) {
					const failed = failedSpecResult(params.agent ?? "inline", params.task, undefined, error ?? "resolve failed");
					failed.label = params.label;
					return {
						content: [{ type: "text", text: error ?? "resolve failed" }],
						details: makeDetails("single")([failed]),
						isError: true,
					};
				}
				const result = await runSingleAgent(
					ctx.cwd,
					spec,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					opts,
				);
				return {
					content: [{ type: "text", text: buildTaskBlock(result) }],
					details: makeDetails("single")([result]),
					isError: isFailedResult(result),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent ?? "inline") +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent ?? "inline")}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "inline";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					if (r.sessionFile) container.addChild(new Text(theme.fg("dim", `session: ${r.sessionFile}`), 0, 0));
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				if (r.sessionFile) text += `\n${theme.fg("dim", `session: ${r.sessionFile}`)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
						if (r.sessionFile) container.addChild(new Text(theme.fg("dim", `session: ${r.sessionFile}`), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					if (r.sessionFile) text += `\n${theme.fg("dim", `session: ${r.sessionFile}`)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
						if (r.sessionFile) container.addChild(new Text(theme.fg("dim", `session: ${r.sessionFile}`), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					if (r.sessionFile) text += `\n${theme.fg("dim", `session: ${r.sessionFile}`)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
