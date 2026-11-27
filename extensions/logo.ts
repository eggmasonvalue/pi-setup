import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Custom startup header showing the candle logo in a rotating pastel color.
 * The color index advances once per launch and is persisted in `<agentDir>/logo-state.json`.
 * Adapts to light/dark theme appearance via `theme.appearance`.
 */

const LOGO = [
	"( )",
	")",
	"(",
	"╔╧╗",
	"║█║",
	"║█║",
	"║█║",
	"══╩═╩══",
	"quiet burning time",
];

// Palettes sourced from pastel-dark and pastel-light theme vars
const PASTEL_DARK_HEX = [
	"#f5e0dc", // rosewater
	"#f5c2e7", // pink
	"#cba6f7", // mauve
	"#fab387", // peach
	"#f9e2af", // yellow
	"#a6e3a1", // green
	"#89dceb", // sky
	"#89b4fa", // blue
	"#b4befe", // lavender
] as const;

const PASTEL_LIGHT_HEX = [
	"#dc8a78", // rosewater
	"#ea76cb", // pink
	"#8839ef", // mauve
	"#fe640b", // peach
	"#df8e1d", // yellow
	"#40a02b", // green
	"#04a5e5", // sky
	"#1e66f5", // blue
	"#7287fd", // lavender
] as const;

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
	const value = hex.replace("#", "");
	return [
		Number.parseInt(value.slice(0, 2), 16),
		Number.parseInt(value.slice(2, 4), 16),
		Number.parseInt(value.slice(4, 6), 16),
	];
}

const DARK_COLORS: Rgb[] = PASTEL_DARK_HEX.map(hexToRgb);
const LIGHT_COLORS: Rgb[] = PASTEL_LIGHT_HEX.map(hexToRgb);

function applyTruecolor([red, green, blue]: Rgb, text: string): string {
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[0m`;
}

function centerLine(text: string, width: number): string {
	const fitted = truncateToWidth(text, width, "");
	const padding = Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2));
	return " ".repeat(padding) + fitted;
}

function nextLaunchColorIndex(): number {
	const stateDir = getAgentDir();
	const stateFile = join(stateDir, "logo-state.json");

	let index = 0;
	try {
		if (existsSync(stateFile)) {
			const parsed = JSON.parse(readFileSync(stateFile, "utf-8")) as { colorIndex?: number };
			if (typeof parsed.colorIndex === "number" && Number.isFinite(parsed.colorIndex) && parsed.colorIndex >= 0) {
				index = Math.floor(parsed.colorIndex);
			}
		}
	} catch {
		index = 0;
	}

	const nextIndex = (index + 1) % DARK_COLORS.length;
	try {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(stateFile, JSON.stringify({ colorIndex: nextIndex }, null, 2), "utf-8");
	} catch {
		// Non-fatal: keep running even if state cannot be written.
	}

	return index % DARK_COLORS.length;
}

export default function logoExtension(pi: ExtensionAPI) {
	// Advance once per launch; stays constant within the session/runtime.
	const colorIndex = nextLaunchColorIndex();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				const palette = theme.appearance === "light" ? LIGHT_COLORS : DARK_COLORS;
				const color = palette[colorIndex]!;
				return LOGO.map((line) => centerLine(applyTruecolor(color, line), width));
			},
			invalidate() {},
		}));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader(undefined);
	});
}
