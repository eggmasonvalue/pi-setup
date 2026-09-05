import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Meta Model API provider with dynamic self-discovery.
 * Fetches available models directly from GET /v1/models using the configured API key.
 * No hardcoded model list or fallbacks.
 */
const BASE_URL = process.env.META_BASE_URL || "https://api.meta.ai/v1";

const thinkingLevelMap = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "xhigh",
} as const;

const compat = {
	supportsReasoningEffort: true,
	supportsDeveloperRole: true,
	maxTokensField: "max_completion_tokens",
	supportsLongCacheRetention: true,
} as const;

interface MetaModelEntry {
	id: string;
	name?: string;
	context_window?: number;
	max_tokens?: number;
}

export default async function (pi: ExtensionAPI) {
	const apiKey = process.env.MODEL_API_KEY || process.env.META_API_KEY;
	if (!apiKey) {
		return;
	}

	let modelsData: MetaModelEntry[] = [];
	try {
		const res = await fetch(`${BASE_URL}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(5000),
		});

		if (res.ok) {
			const body = (await res.json()) as { data?: MetaModelEntry[] };
			if (Array.isArray(body.data)) {
				modelsData = body.data;
			}
		}
	} catch {
		return;
	}

	if (modelsData.length === 0) {
		return;
	}

	pi.registerProvider("meta", {
		name: "Meta",
		baseUrl: BASE_URL,
		apiKey: process.env.MODEL_API_KEY ? "$MODEL_API_KEY" : "$META_API_KEY",
		api: "openai-completions",
		models: modelsData.map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			reasoning: true,
			thinkingLevelMap,
			input: ["text", "image"],
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0.15 },
			contextWindow: m.context_window ?? 1_048_576,
			maxTokens: m.max_tokens ?? 131_072,
			compat,
		})),
	});
}
