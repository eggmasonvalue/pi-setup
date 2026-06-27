import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

// Palette sourced from your pastel-dark theme vars
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

function hexToRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return [red, green, blue];
}

const PASTEL_COLORS: Rgb[] = PASTEL_DARK_HEX.map(hexToRgb);

type Rgb = [number, number, number];

function applyTruecolor(rgb: Rgb, text: string): string {
  const [red, green, blue] = rgb;
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[0m`;
}

function centerText(text: string, width: number): string {
  const visibleLength = text.replace(/\x1b\[[0-9;]*m/g, '').length;
  const padding = Math.max(0, Math.floor((width - visibleLength) / 2));
  return ' '.repeat(padding) + text;
}

function getLaunchColor(): Rgb {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return PASTEL_COLORS[0]!;

  const stateDir = join(home, ".pi", "agent");
  const stateFile = join(stateDir, "logo-state.json");

  let index = 0;
  try {
    if (existsSync(stateFile)) {
      const parsed = JSON.parse(readFileSync(stateFile, "utf-8")) as { colorIndex?: number };
      if (typeof parsed.colorIndex === "number" && Number.isFinite(parsed.colorIndex)) {
        index = parsed.colorIndex;
      }
    }
  } catch {
    index = 0;
  }

  const color = PASTEL_COLORS[index % PASTEL_COLORS.length]!;
  const nextIndex = (index + 1) % PASTEL_COLORS.length;

  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ colorIndex: nextIndex }, null, 2), "utf-8");
  } catch {
    // Non-fatal: keep running even if state cannot be written.
  }

  return color;
}

export default function matrixTicker(pi: ExtensionAPI) {
  // Choose once per app launch; stays constant within the session/runtime.
  const launchColor = getLaunchColor();

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setHeader((_tui, _theme) => ({
      render(width: number): string[] {
        const coloredLogo = LOGO.map((line) => centerText(applyTruecolor(launchColor, line), width));
        return coloredLogo;
      },
      invalidate() {},
    }));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setHeader(undefined);
  });
}
