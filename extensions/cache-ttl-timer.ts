import {
	CACHE_WARMING_MAX_AGE_MS,
	CACHE_WARMING_MAX_IDLE_AGE_MS,
	evaluateCacheWarming,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ringBell } from "./notify";

/**
 * Prompt-cache status indicator rendered as a right-aligned `belowEditor`
 * widget (sits cleanly between the editor and footer, directly above the
 * model name, without replacing Pi's built-in footer).
 *
 * States shown:
 * - `cache 4:32 ↻`        — warm, and Pi's built-in cache warmer is expected to refresh it
 * - `cache 4:32`          — warm, not being warmed (warming off, below $0.05 savings, or past safety cap)
 * - `cache warmed 4:58 ↻` — recently refreshed by Pi's cache warmer (for 15s after refresh)
 * - `cache 0:18!`         — expiring soon (<= 20s) without auto-warming; rings terminal bell once
 * - `cache cold`          — cache window has expired (dim)
 *
 * Design notes:
 * - Anchored on `before_provider_request` (request-send time) so the countdown
 *   isn't skewed by response streaming duration, and refreshed when
 *   `cache_warming_decision` returns `"warm"`.
 * - TTL comes from Pi's own `getPromptCacheTtlMs(model)` (reads `model.promptCache`
 *   and `PI_CACHE_RETENTION`), falling back to 5m/1h for models that bill caching
 *   without declaring `promptCache`.
 * - Skips entirely for models that neither declare `promptCache` nor bill
 *   cache read/write (`cost.cacheRead === 0 && cost.cacheWrite === 0`).
 * - Adaptive tick cadence: 15s while plenty of time remains, 1s in the final 30s
 *   (or while showing the brief `warmed` badge).
 */

const FALLBACK_SHORT_TTL_MS = 5 * 60 * 1000;
const FALLBACK_LONG_TTL_MS = 60 * 60 * 1000;
const WARN_AT_MS = 20 * 1000;
const FINE_GRAIN_THRESHOLD_MS = 30 * 1000;
const WARMED_BADGE_MS = 15 * 1000;
const COARSE_TICK_MS = 15 * 1000;
const FINE_TICK_MS = 1000;

const WIDGET_KEY = "cache-ttl";

function formatRemaining(ms: number): string {
	const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	if (h > 0) {
		return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
	}
	return `${m}:${s.toString().padStart(2, "0")}`;
}

function resolveTtlMs(model: Model<Api>): number | undefined {
	const declared = getPromptCacheTtlMs(model, undefined);
	if (declared !== undefined) return declared;

	const billsCaching = model.cost.cacheRead > 0 || model.cost.cacheWrite > 0;
	if (!billsCaching) return undefined;

	const longRequested = process.env.PI_CACHE_RETENTION === "long";
	const longSupported = model.compat?.supportsLongCacheRetention !== false;
	return longRequested && longSupported ? FALLBACK_LONG_TTL_MS : FALLBACK_SHORT_TTL_MS;
}

function lastPromptTokens(ctx: ExtensionContext): number {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
	}
	return 0;
}

export default function cacheTtlTimerExtension(pi: ExtensionAPI) {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let requestStartedAt = 0;
	let ttlMs = 0;
	let deadline = 0;
	let phase: "streaming" | "idle" = "idle";
	let warned = false;
	let warmingStopped = false;
	let warmedUntil = 0;
	let modelSupportsWarming = false;
	let activeModel: Model<Api> | undefined;
	let lastCtx: ExtensionContext | undefined;

	// Widget render callback reads currentText; requestRender triggers repaint without recreating the widget.
	let widgetMounted = false;
	let requestWidgetRender: (() => void) | undefined;
	let renderText: ((theme: Theme) => string) | undefined;

	const stopTimer = () => {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
			timeoutHandle = undefined;
		}
	};

	const unmount = (ctx?: ExtensionContext) => {
		stopTimer();
		renderText = undefined;
		if (widgetMounted) {
			widgetMounted = false;
			requestWidgetRender = undefined;
			(ctx ?? lastCtx)?.ui.setWidget(WIDGET_KEY, undefined);
		}
	};

	const paint = (ctx: ExtensionContext, builder: (theme: Theme) => string) => {
		if (ctx.mode !== "tui") return;
		renderText = builder;
		if (!widgetMounted) {
			widgetMounted = true;
			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					requestWidgetRender = () => tui.requestRender();
					return {
						render(width: number): string[] {
							if (!renderText) return [];
							const content = truncateToWidth(renderText(theme), width, "");
							const pad = Math.max(0, width - visibleWidth(content));
							return [`${" ".repeat(pad)}${content}`];
						},
						invalidate() {},
					};
				},
				{ placement: "belowEditor" },
			);
		} else {
			requestWidgetRender?.();
		}
	};

	const isAutoWarmingExpected = (ctx: ExtensionContext, now: number): boolean => {
		if (!activeModel || !modelSupportsWarming || warmingStopped) return false;
		const mode = pi.getSettings().cacheWarming ?? "idle";
		if (mode === "off") return false;
		if (mode === "streaming" && phase === "idle") return false;

		const delayMs = getCacheWarmingDelayMs(ttlMs);
		if (delayMs === undefined) return false;

		// Check Pi's fixed safety horizon (60m streaming, 30m idle).
		const horizon = requestStartedAt + (phase === "idle" ? CACHE_WARMING_MAX_IDLE_AGE_MS : CACHE_WARMING_MAX_AGE_MS);
		const nextWarmAt = deadline - (ttlMs - delayMs);
		if (now >= horizon || nextWarmAt > horizon) return false;

		// Mirror Pi's $0.05 expected-savings gate when prompt token count is known.
		const tokens = lastPromptTokens(ctx);
		if (tokens <= 0) return false;
		const decision = evaluateCacheWarming(activeModel, tokens, phase);
		return decision.economicsAvailable && decision.action === "warm";
	};

	const tick = (ctx: ExtensionContext) => {
		stopTimer();
		const now = Date.now();
		const remaining = deadline - now;

		if (remaining <= 0) {
			paint(ctx, (theme) => theme.fg("dim", "cache cold"));
			return;
		}

		const autoWarm = isAutoWarmingExpected(ctx, now);
		const recentlyWarmed = now < warmedUntil;
		const formatted = formatRemaining(remaining);

		if (remaining <= WARN_AT_MS && !autoWarm) {
			if (!warned) {
				warned = true;
				ringBell();
			}
			paint(ctx, (theme) => theme.fg("warning", `cache ${formatted}!`));
		} else if (recentlyWarmed) {
			paint(ctx, (theme) => theme.fg("success", `cache warmed ${formatted}${autoWarm ? " ↻" : ""}`));
		} else if (autoWarm) {
			paint(ctx, (theme) => theme.fg("dim", `cache ${formatted} `) + theme.fg("accent", "↻"));
		} else {
			paint(ctx, (theme) => theme.fg("dim", `cache ${formatted}`));
		}

		const nextTick =
			remaining <= FINE_GRAIN_THRESHOLD_MS || recentlyWarmed ? FINE_TICK_MS : COARSE_TICK_MS;
		timeoutHandle = setTimeout(() => tick(ctx), Math.min(nextTick, remaining));
		timeoutHandle.unref?.();
	};

	pi.on("before_provider_request", (_event, ctx) => {
		lastCtx = ctx;
		const model = ctx.model;
		if (!model) {
			unmount(ctx);
			return;
		}

		const resolvedTtl = resolveTtlMs(model);
		if (resolvedTtl === undefined) {
			unmount(ctx);
			return;
		}

		const now = Date.now();
		activeModel = model;
		ttlMs = resolvedTtl;
		modelSupportsWarming = getPromptCacheTtlMs(model, undefined) !== undefined;
		requestStartedAt = now;
		deadline = now + resolvedTtl;
		phase = "streaming";
		warned = false;
		warmingStopped = false;
		warmedUntil = 0;

		tick(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		phase = "idle";
		if (deadline > 0) tick(ctx);
	});

	pi.on("cache_warming_decision", (event, ctx) => {
		lastCtx = ctx;
		if (event.action === "warm" && ttlMs > 0) {
			const now = Date.now();
			deadline = now + ttlMs;
			warned = false;
			warmingStopped = false;
			warmedUntil = now + WARMED_BADGE_MS;
			tick(ctx);
		} else if (event.action === "stop") {
			warmingStopped = true;
			if (deadline > 0) tick(ctx);
		}
	});

	pi.on("model_select", (event, ctx) => {
		lastCtx = ctx;
		// Switching models invalidates the previous model's prompt cache.
		if (
			activeModel &&
			(event.model.provider !== activeModel.provider || event.model.id !== activeModel.id)
		) {
			activeModel = undefined;
			deadline = 0;
			unmount(ctx);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		unmount(ctx);
	});
}
