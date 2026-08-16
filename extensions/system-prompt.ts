/**
 * /system-prompt — show the assembled system prompt and active tool schemas.
 *
 * Snapshots the prompt on agent_start, after other before_agent_start handlers
 * have rewritten it. The command handler would only see the base prompt,
 * because Pi clears a per-turn override after the run.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const CHROME_ROWS = 7;

export default function systemPromptViewer(pi: ExtensionAPI) {
  let lastPrompt: string | undefined;

  pi.on("agent_start", (_event, ctx) => {
    lastPrompt = ctx.getSystemPrompt();
  });

  pi.registerCommand("system-prompt", {
    description: "Show the system prompt and tool definitions sent with the last run",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/system-prompt is available in interactive Pi only.", "warning");
        return;
      }

      await ctx.waitForIdle();
      const prompt = lastPrompt ?? ctx.getSystemPrompt();
      const promptSource = lastPrompt
        ? "final prompt from the last agent run"
        : "base prompt; no agent run yet";
      const active = new Set(pi.getActiveTools());
      const activeTools = pi.getAllTools().filter((tool) => active.has(tool.name));
      const promptLines = prompt.split("\n");
      const schemaLines = formatToolSchemas(activeTools);
      const lines = [
        ...promptLines,
        "",
        "────────────────────────────────────────",
        "",
        ...schemaLines,
      ];

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new SystemPromptViewer(
            tui,
            theme,
            lines,
            promptLines.length,
            prompt.length,
            activeTools.length,
            promptSource,
            done,
          ),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "95%",
            maxHeight: "92%",
            margin: 0,
          },
        },
      );
    },
  });
}

function formatToolSchemas(tools: ToolInfo[]): string[] {
  if (tools.length === 0) return ["Tool definitions (0 tools)", "", "No tools."];

  const lines = [
    `Tool definitions (${tools.length} tools)`,
    "",
  ];
  for (const tool of tools) {
    lines.push(`name: ${tool.name}`);
    lines.push(`  description: ${tool.description}`);
    lines.push(`  source: ${formatSource(tool.sourceInfo.source)}`);
    lines.push("  parameters:");
    for (const line of (JSON.stringify(tool.parameters, null, 2) ?? "undefined").split("\n")) {
      lines.push(`    ${line}`);
    }
    lines.push("");
  }
  return lines;
}

function formatSource(source: string): string {
  if (source === "builtin") return "built-in";
  if (source === "sdk") return "SDK";
  return source;
}

interface DisplayLine {
  text: string;
  sourceIndex: number;
  continuation: boolean;
}

type LineStyle = "heading" | "bullet" | "section" | "tool" | "plain";

function styleFor(line: string): LineStyle {
  if (line.startsWith("Available tools:") || line.startsWith("Guidelines:")) return "section";
  if (line.startsWith("Tool definitions")) return "section";
  if (line.startsWith("name:") || line.startsWith("  description:") || line.startsWith("  source:")) {
    return "tool";
  }
  if (/^#+\s/.test(line)) return "heading";
  if (line.startsWith("- ")) return "bullet";
  return "plain";
}

class SystemPromptViewer {
  private scrollOffset = 0;
  private copiedAt = 0;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
  private totalDisplayLines = 0;
  private readonly fullText: string;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly lines: string[],
    private readonly promptLineCount: number,
    private readonly promptCharCount: number,
    private readonly toolCount: number,
    private readonly promptSource: string,
    private readonly done: () => void,
  ) {
    this.fullText = lines.join("\n");
  }

  handleInput(data: string): void {
    const visible = this.visibleLineCount();
    const maximumOffset = Math.max(0, this.totalDisplayLines - visible);

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollOffset = Math.min(maximumOffset, this.scrollOffset + 1);
    } else if (matchesKey(data, "pageUp")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - visible);
    } else if (matchesKey(data, "pageDown")) {
      this.scrollOffset = Math.min(maximumOffset, this.scrollOffset + visible);
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maximumOffset;
    } else if (matchesKey(data, "c")) {
      this.copyToClipboard();
    } else if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.dispose();
      this.done();
      return;
    } else {
      return;
    }

    this.tui.requestRender();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const contentWidth = Math.max(1, innerWidth - 1);
    const visible = this.visibleLineCount();
    const displayLines = this.buildDisplayLines(contentWidth);
    this.totalDisplayLines = displayLines.length;
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, displayLines.length - visible));

    const border = (text: string) => this.theme.fg("border", text);
    const row = (content: string) =>
      `${border("│")}${pad(content, innerWidth)}${border("│")}`;
    const output = [border(`╭${"─".repeat(innerWidth)}╮`)];
    const title = this.theme.fg("accent", this.theme.bold("System Prompt"));
    const metadata = this.theme.fg(
      "dim",
      `— ${this.promptLineCount} lines, ${this.promptCharCount.toLocaleString()} chars | ${this.toolCount} tools`,
    );
    output.push(row(` ${title}  ${metadata}`));
    output.push(row(` ${this.theme.fg("dim", this.promptSource)}`));
    output.push(row(""));

    const end = Math.min(this.scrollOffset + visible, displayLines.length);
    for (let index = this.scrollOffset; index < end; index++) {
      const displayLine = displayLines[index]!;
      const style = styleFor(this.lines[displayLine.sourceIndex]!);
      output.push(row(` ${styleLine(this.theme, displayLine.text, style, displayLine.continuation)}`));
    }
    for (let index = end - this.scrollOffset; index < visible; index++) output.push(row(""));

    const range = `${this.scrollOffset + 1}-${end}/${displayLines.length}`;
    const percent = displayLines.length
      ? Math.round((this.scrollOffset / Math.max(1, displayLines.length - visible)) * 100)
      : 0;
    const copied = Date.now() - this.copiedAt < 2_000 ? this.theme.fg("success", "copied") : "copy";
    const footerLeft = this.theme.fg("dim", `${range} (${percent}%)`);
    const footerRight = this.theme.fg("dim", `c ${copied}  ↑↓/jk pgup/pgdn home/end  Esc/q`);
    const spacing = Math.max(1, innerWidth - 1 - visibleWidth(footerLeft) - visibleWidth(footerRight));
    output.push(row(""));
    output.push(row(` ${footerLeft}${" ".repeat(spacing)}${footerRight}`));
    output.push(border(`╰${"─".repeat(innerWidth)}╯`));
    return output;
  }

  invalidate(): void {}

  private visibleLineCount(): number {
    return Math.max(1, Math.floor(this.tui.terminal.rows * 0.92) - CHROME_ROWS);
  }

  private buildDisplayLines(width: number): DisplayLine[] {
    const displayLines: DisplayLine[] = [];
    for (const [sourceIndex, line] of this.lines.entries()) {
      const wrapped = wrapTextWithAnsi(line, width);
      for (const [index, text] of (wrapped.length ? wrapped : [""]).entries()) {
        displayLines.push({ text, sourceIndex, continuation: index > 0 });
      }
    }
    return displayLines;
  }

  private copyToClipboard(): void {
    const base64 = Buffer.from(this.fullText, "utf-8").toString("base64");
    process.stdout.write(`\x1b]52;c;${base64}\x07`);
    this.copiedAt = Date.now();
    clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => this.tui.requestRender(), 2_000);
  }

  dispose(): void {
    clearTimeout(this.copiedTimer);
    this.copiedTimer = undefined;
  }
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function styleLine(theme: Theme, text: string, style: LineStyle, continuation: boolean): string {
  if (continuation) {
    return style === "bullet" ? theme.fg("muted", text) : theme.fg("dim", text);
  }
  if (style === "section" || style === "heading") return theme.fg("accent", theme.bold(text));
  if (style === "bullet") return theme.fg("muted", text);
  if (style === "tool") return theme.fg("success", text);
  return text;
}
