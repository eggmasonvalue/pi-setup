import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ringBell } from "./notify";

/**
 * Countdown to prompt-cache expiry, so you don't accidentally let the
 * provider's cache breakpoint go cold and eat a full-price re-read on your
 * next message.
 *
 * Design notes:
 * - Anchored on `before_provider_request` (request-send time), NOT
 *   `after_provider_response` or `turn_end` — those fire too late and would
 *   under-count the remaining window by the response/streaming duration.
 * - TTL is derived per-model/provider, not hardcoded: short (default ~5min)
 *   vs long (~1h/24h) based on `PI_CACHE_RETENTION` env + model capability
 *   flags, falling back to the 5-minute short default.
 * - Skips entirely for models that don't bill/support cache read+write
 *   (cost.cacheRead === 0 && cost.cacheWrite === 0) — no point showing a
 *   countdown for a cache window that's never opened.
 * - Does NOT try to confirm actual cache hit/miss from response usage —
 *   pi already does that (see `showCacheMissNotices` setting). This
 *   extension only predicts the deadline; it doesn't audit what happened.
 * - Adaptive render cadence: coarse (15s) most of the window, fine (1s) in
 *   the final 30s, to avoid needless re-renders for 4+ minutes of a 5m TTL.
 * - One bell (via notify.ts's ringBell, not ctx.ui.notify — see notify.ts
 *   for why) fired once per window at ~20s remaining.
 * - Timer/state is closure-local: pi gives each session a fresh extension
 *   instance, so no manual per-session keying or leakage across sessions.
 */

const SHORT_TTL_MS = 5 * 60 * 1000;
const LONG_TTL_MS = 60 * 60 * 1000;
const WARN_AT_MS = 20 * 1000;
const FINE_GRAIN_THRESHOLD_MS = 30 * 1000;
const COARSE_TICK_MS = 15 * 1000;
const FINE_TICK_MS = 1000;

const STATUS_KEY = "cache-ttl";

function formatRemaining(ms: number): string {
	const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
	const m = Math.floor(totalSeconds / 60);
	const s = totalSeconds % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function cacheTtlTimerExtension(pi: ExtensionAPI) {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let deadline = 0;
	let warned = false;

	const clear = (ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) => {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
			timeoutHandle = undefined;
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const tick = (ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) => {
		const remaining = deadline - Date.now();

		if (remaining <= 0) {
			clear(ctx);
			return;
		}

		ctx.ui.setStatus(STATUS_KEY, `cache: ${formatRemaining(remaining)}`);

		if (!warned && remaining <= WARN_AT_MS) {
			warned = true;
			ringBell();
		}

		const nextTick = remaining <= FINE_GRAIN_THRESHOLD_MS ? FINE_TICK_MS : COARSE_TICK_MS;
		timeoutHandle = setTimeout(() => tick(ctx), Math.min(nextTick, remaining));
	};

	pi.on("before_provider_request", (_event, ctx) => {
		const model = ctx.model;
		if (!model) return;

		// No point tracking a cache window for a model that doesn't bill
		// (and by proxy, doesn't support) prompt caching.
		const cachingSupported = model.cost.cacheRead > 0 || model.cost.cacheWrite > 0;
		if (!cachingSupported) {
			clear(ctx);
			return;
		}

		const longRetentionRequested = process.env.PI_CACHE_RETENTION === "long";
		const longRetentionSupported = model.compat?.supportsLongCacheRetention !== false;
		const ttlMs = longRetentionRequested && longRetentionSupported ? LONG_TTL_MS : SHORT_TTL_MS;

		if (timeoutHandle) clearTimeout(timeoutHandle);
		deadline = Date.now() + ttlMs;
		warned = false;
		tick(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clear(ctx);
	});
}
