import {
	getAgentDir,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type KeyId,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/**
 * Annotate the last assistant message in a formatted TUI overlay (`/annotate` or `ctrl+shift+a`).
 *
 * - Renders the message through Pi's `Markdown` component so headings, code blocks,
 *   tables, bold/italic, and lists match the main transcript.
 * - Supports line/span annotations (`v` span, `i`/`enter` note) plus one optional
 *   general summary message for the whole batch (`m`).
 * - Uses wrapping `Editor` input (`Enter` saves, `Shift+Enter` inserts newline, `Esc` cancels).
 * - Sends the batch with `Ctrl+S` (consistent with `ask_user_questions`).
 * - Preserves unsent work per assistant message as an in-memory draft if closed with `Esc`.
 *
 * Originally inspired by `patelparth3/pi-annotations` (MIT), brought in-house and
 * redesigned for Pi 1.6+. See `docs/extensions/annotate.md`.
 */

export interface Annotation {
	start: number; // rendered row index, inclusive
	end: number; // rendered row index, inclusive
	quoteLines: string[]; // plain-text anchor lines captured when annotated
	note: string;
}

export interface AnnotationBatch {
	summary?: string;
	annotations: Annotation[];
}

interface Draft {
	summary: string;
	annotations: Annotation[];
	cursor: number;
	width: number;
}

type Mode = "nav" | "span" | "note" | "summary";

const GUTTER = 4;
const MAX_QUOTE_LINES = 4;
const MAX_QUOTE_CHARS = 300;

function trimQuoteLines(rawLines: string[]): string[] {
	// Trim leading/trailing blank lines inside a span if non-empty content exists.
	let first = 0;
	let last = rawLines.length - 1;
	while (first <= last && rawLines[first]!.trim() === "") first++;
	while (last >= first && rawLines[last]!.trim() === "") last--;
	const span = first <= last ? rawLines.slice(first, last + 1) : rawLines;

	const totalChars = span.reduce((n, l) => n + l.length, 0);
	if (span.length <= MAX_QUOTE_LINES && totalChars <= MAX_QUOTE_CHARS) {
		return span;
	}
	if (span.length >= 3) {
		return [...span.slice(0, 2), "…", span[span.length - 1]!];
	}
	return span.map((l) => (l.length > 200 ? `${l.slice(0, 200)} …` : l));
}

export function formatAnnotationBatch(batch: AnnotationBatch): string {
	const parts: string[] = [];
	const summary = batch.summary?.trim();

	if (summary) {
		parts.push(summary);
	}

	if (batch.annotations.length > 0) {
		const comments = batch.annotations
			.map((a, i) => {
				const quote = trimQuoteLines(a.quoteLines)
					.map((l) => `> ${l}`)
					.join("\n");
				const prefix = batch.annotations.length > 1 ? `[${i + 1}]\n` : "";
				return `${prefix}${quote}\n${a.note}`;
			})
			.join("\n\n");
		parts.push(comments);
	}

	return parts.join("\n\n");
}

function applySelectionBg(theme: Theme, line: string): string {
	const bgAnsi = theme.getBgAnsi("selectedBg");
	// Re-apply selection background after any inner full reset or bg reset so
	// syntax-highlighted / styled Markdown text keeps a solid highlight band.
	const patched = line
		.replace(/\x1b\[0m/g, `\x1b[0m${bgAnsi}`)
		.replace(/\x1b\[49m/g, bgAnsi);
	return `${bgAnsi}${patched}\x1b[49m`;
}

function makeEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

export class AnnotateOverlay implements Component, Focusable {
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value && this.isEditing();
	}

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly messageText: string;
	private readonly done: (result: AnnotationBatch | null) => void;

	private mode: Mode = "nav";
	private cursor = 0;
	private anchor: number | null = null;
	private editingIndex: number | null = null;
	private annotations: Annotation[] = [];
	private summary = "";
	private hint: string | null = null;

	private readonly editor: Editor;

	private renderedRows: string[] = [];
	private plainRows: string[] = [];
	private cachedContentWidth?: number;
	private scrollOffset = 0;
	private lastBodyHeight = 10;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		messageText: string,
		done: (result: AnnotationBatch | null) => void,
		draft?: Draft,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.messageText = messageText;
		this.done = done;

		this.editor = new Editor(tui, makeEditorTheme(theme), { paddingX: 0 });
		this.editor.onSubmit = (value) => this.commitEditor(value);

		if (draft) {
			this.summary = draft.summary;
			this.annotations = draft.annotations.map((a) => ({ ...a, quoteLines: [...a.quoteLines] }));
			this.cursor = Math.max(0, draft.cursor);
		}
	}

	getDraftState(): Draft {
		return {
			summary: this.summary,
			annotations: this.annotations.map((a) => ({ ...a, quoteLines: [...a.quoteLines] })),
			cursor: this.cursor,
			width: this.cachedContentWidth ?? 0,
		};
	}

	private isEditing(): boolean {
		return this.mode === "note" || this.mode === "summary";
	}

	private hasPayload(): boolean {
		return this.annotations.length > 0 || this.summary.trim().length > 0;
	}

	private trySend(): void {
		if (!this.hasPayload()) {
			this.hint = "nothing to send yet — press i/v to annotate or m for a general message";
			return;
		}
		this.done({
			summary: this.summary.trim() || undefined,
			annotations: this.annotations,
		});
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && typeof event.wheelDelta === "number" && !this.isEditing()) {
			this.moveCursor(event.wheelDelta);
			this.tui.requestRender();
			return { handled: true };
		}
		return undefined;
	}

	handleInput(data: string): void {
		if (this.isEditing()) {
			if (matchesKey(data, Key.escape)) {
				this.cancelEditor();
				this.tui.requestRender();
				return;
			}
			// Ctrl+S while editing saves the current editor and sends the batch immediately.
			if (matchesKey(data, Key.ctrl("s"))) {
				this.commitEditor(this.editor.getExpandedText());
				this.trySend();
				this.tui.requestRender();
				return;
			}
			this.editor.handleInput(data);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.ctrl("s"))) {
			this.trySend();
			this.tui.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
			this.handleEscape();
		} else if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
			this.moveCursor(-1);
		} else if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
			this.moveCursor(1);
		} else if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveCursor(-this.lastBodyHeight);
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveCursor(this.lastBodyHeight);
		} else if (data === "g" || matchesKey(data, Key.home)) {
			this.cursor = 0;
			this.hint = null;
		} else if (data === "G" || matchesKey(data, Key.end)) {
			this.cursor = Math.max(0, this.renderedRows.length - 1);
			this.hint = null;
		} else if (this.mode === "nav" && data === "v") {
			this.anchor = this.cursor;
			this.mode = "span";
			this.hint = null;
		} else if (this.mode === "nav" && data === "m") {
			this.openSummaryEditor();
		} else if (this.mode === "nav" && (data === "i" || data === "a" || matchesKey(data, Key.enter))) {
			const annIdx = this.annotationAt(this.cursor);
			if (annIdx >= 0) {
				this.openNoteEditor(annIdx);
			} else {
				this.anchor = this.cursor;
				this.openNoteEditor(null);
			}
		} else if (this.mode === "span" && (data === "s" || data === "v" || matchesKey(data, Key.enter))) {
			this.openNoteEditor(null);
		} else if (this.mode === "nav" && (data === "x" || data === "d")) {
			const annIdx = this.annotationAt(this.cursor);
			if (annIdx >= 0) {
				this.annotations.splice(annIdx, 1);
				this.hint = null;
			} else {
				this.hint = "no annotation on this line";
			}
		} else if (this.mode === "nav" && data === "C") {
			if (this.hasPayload()) {
				const count = this.annotations.length;
				const hadSummary = this.summary.trim().length > 0;
				this.annotations = [];
				this.summary = "";
				this.hint = hadSummary
					? count > 0
						? `cleared ${count} annotation(s) and summary`
						: "cleared summary"
					: `cleared ${count} annotation(s)`;
			}
		}

		this.tui.requestRender();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const inner = Math.max(20, width - 2);
		const contentWidth = Math.max(12, inner - GUTTER);
		this.ensureRenderedRows(contentWidth);

		if (this.renderedRows.length > 0) {
			this.cursor = Math.max(0, Math.min(this.cursor, this.renderedRows.length - 1));
		}

		// Pre-render the editor panel when active so body height adapts cleanly.
		let editorLines: string[] = [];
		let editorHeader = "";
		if (this.isEditing()) {
			const edWidth = Math.max(10, inner - 2);
			editorLines = [...this.editor.render(edWidth)];
			if (this.mode === "summary") {
				editorHeader = this.summary.trim()
					? " edit general message (empty deletes):"
					: " general message for this batch:";
			} else if (this.anchor !== null) {
				const s = Math.min(this.anchor, this.cursor);
				const e = Math.max(this.anchor, this.cursor);
				const range = s === e ? `row ${s + 1}` : `rows ${s + 1}-${e + 1}`;
				editorHeader = this.editingIndex !== null ? ` edit note for ${range}:` : ` note for ${range}:`;
			}
		}

		// Optional 1-line preview of the note under cursor (in nav mode) or summary indicator.
		let previewLine: string | null = null;
		if (this.mode === "nav") {
			const activeAnnIdx = this.annotationAt(this.cursor);
			if (activeAnnIdx >= 0) {
				const noteOneLine = this.annotations[activeAnnIdx]!.note.replace(/\s+/g, " ").trim();
				previewLine =
					theme.fg("success", ` [${activeAnnIdx + 1}] `) +
					theme.fg("muted", truncateToWidth(noteOneLine, Math.max(10, inner - 8), "…"));
			} else if (this.summary.trim()) {
				const summaryOneLine = this.summary.replace(/\s+/g, " ").trim();
				previewLine =
					theme.fg("accent", " summary: ") +
					theme.fg("muted", truncateToWidth(summaryOneLine, Math.max(10, inner - 12), "…"));
			}
		}

		const extraChrome =
			(this.isEditing() ? 1 + editorLines.length : 0) + (previewLine ? 1 : 0);
		const baseChrome = 6; // top border, title, divider, help, bottom spacer, bottom border
		const maxBody = Math.max(3, Math.floor(this.tui.terminal.rows * 0.8) - baseChrome - extraChrome);
		const bodyHeight = Math.max(3, Math.min(maxBody, this.renderedRows.length));
		this.lastBodyHeight = bodyHeight;

		if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
		if (this.cursor >= this.scrollOffset + bodyHeight) this.scrollOffset = this.cursor - bodyHeight + 1;
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, this.renderedRows.length - bodyHeight)));

		const span = this.spanRange();
		const out: string[] = [];

		const borderV = theme.fg("accent", "│");
		const padInner = (content: string): string => {
			const t = truncateToWidth(content, inner, "");
			return t + " ".repeat(Math.max(0, inner - visibleWidth(t)));
		};
		const boxLine = (content: string): string => borderV + padInner(content) + borderV;

		out.push(theme.fg("accent", `╭${"─".repeat(inner)}╮`));

		const title = " Annotate last message";
		const noteWord = `${this.annotations.length} note${this.annotations.length === 1 ? "" : "s"}`;
		const summaryTag = this.summary.trim() ? " · +summary" : "";
		const scrollTag =
			this.renderedRows.length > bodyHeight
				? ` · ${this.scrollOffset + 1}-${Math.min(this.renderedRows.length, this.scrollOffset + bodyHeight)}/${this.renderedRows.length}`
				: "";
		const counter = `${noteWord}${summaryTag}${scrollTag} `;
		const titlePad = Math.max(1, inner - visibleWidth(title) - visibleWidth(counter));
		out.push(
			boxLine(
				theme.fg("accent", theme.bold(title)) + " ".repeat(titlePad) + theme.fg("muted", counter),
			),
		);
		out.push(theme.fg("borderMuted", `├${"─".repeat(inner)}┤`));

		for (let i = 0; i < bodyHeight; i++) {
			const rowIdx = this.scrollOffset + i;
			const styledRow = this.renderedRows[rowIdx];
			if (styledRow === undefined) {
				out.push(boxLine(""));
				continue;
			}
			const inSpan = span !== null && rowIdx >= span[0] && rowIdx <= span[1];
			const annIdx = this.annotationAt(rowIdx);
			const isCursor = rowIdx === this.cursor;

			if (inSpan) {
				const prefix = isCursor ? theme.fg("accent", ">") : " ";
				const raw = padInner(` ${prefix}  ${styledRow}`);
				out.push(borderV + applySelectionBg(theme, raw) + borderV);
				continue;
			}

			let badge = " ";
			if (annIdx >= 0) {
				badge = rowIdx === this.annotations[annIdx]!.start ? (annIdx < 9 ? String(annIdx + 1) : "+") : "│";
			}
			const gutter =
				(annIdx >= 0 ? theme.fg("success", badge) : badge) +
				(isCursor ? theme.fg("accent", ">") : " ") +
				"  ";
			const rowLine = gutter + styledRow;
			if (isCursor) {
				out.push(borderV + applySelectionBg(theme, padInner(rowLine)) + borderV);
			} else {
				out.push(boxLine(rowLine));
			}
		}

		out.push(theme.fg("borderMuted", `├${"─".repeat(inner)}┤`));

		if (this.isEditing()) {
			out.push(boxLine(theme.fg("accent", editorHeader)));
			for (const line of editorLines) {
				out.push(boxLine(` ${line}`));
			}
		} else if (previewLine) {
			out.push(boxLine(previewLine));
		}

		let help: string;
		if (this.hint) {
			help = this.hint;
		} else if (this.mode === "span") {
			help = "j/k extend · s/Enter note · Esc cancel span";
		} else if (this.mode === "summary") {
			help = "Enter save · Shift+Enter newline · empty clears · Ctrl+S send · Esc cancel";
		} else if (this.mode === "note" && this.editingIndex !== null) {
			help = "Enter save · Shift+Enter newline · empty deletes · Ctrl+S send · Esc keep";
		} else if (this.mode === "note") {
			help = "Enter save · Shift+Enter newline · Ctrl+S send · Esc cancel";
		} else if (this.annotationAt(this.cursor) >= 0) {
			help = "i/Enter edit · x delete · m summary · v span · C clear · Ctrl+S send · Esc";
		} else {
			help = "j/k move · v span · i/Enter note · m summary · Ctrl+S send · Esc";
		}
		out.push(boxLine(` ${theme.fg("dim", help)}`));
		out.push(theme.fg("accent", `╰${"─".repeat(inner)}╯`));
		return out;
	}

	invalidate(): void {
		this.cachedContentWidth = undefined;
		this.renderedRows = [];
		this.plainRows = [];
		this.editor.invalidate();
	}

	private ensureRenderedRows(contentWidth: number): void {
		if (this.cachedContentWidth === contentWidth && this.renderedRows.length > 0) return;
		const md = new Markdown(this.messageText, 0, 0, getMarkdownTheme());
		const rendered = [...md.render(contentWidth)];
		this.renderedRows = rendered.length > 0 ? rendered : [""];
		this.plainRows = this.renderedRows.map((row) => stripTerminalSequences(row).trimEnd());
		this.cachedContentWidth = contentWidth;
	}

	private moveCursor(delta: number): void {
		const maxIdx = Math.max(0, this.renderedRows.length - 1);
		this.cursor = Math.max(0, Math.min(maxIdx, this.cursor + delta));
		this.hint = null;
	}

	private spanRange(): [number, number] | null {
		if (this.anchor === null) return null;
		return [Math.min(this.anchor, this.cursor), Math.max(this.anchor, this.cursor)];
	}

	private annotationAt(row: number): number {
		for (let i = this.annotations.length - 1; i >= 0; i--) {
			const a = this.annotations[i]!;
			if (row >= a.start && row <= a.end) return i;
		}
		return -1;
	}

	private handleEscape(): void {
		if (this.mode === "span") {
			this.mode = "nav";
			this.anchor = null;
			return;
		}
		this.done(null);
	}

	private openNoteEditor(annIdx: number | null): void {
		this.editingIndex = annIdx;
		this.mode = "note";
		if (annIdx !== null) {
			const existing = this.annotations[annIdx]!;
			this.anchor = existing.start;
			this.cursor = existing.end;
			this.editor.setText(existing.note);
		} else {
			this.editor.setText("");
		}
		this.editor.focused = this._focused;
		this.hint = null;
	}

	private openSummaryEditor(): void {
		this.editingIndex = null;
		this.anchor = null;
		this.mode = "summary";
		this.editor.setText(this.summary);
		this.editor.focused = this._focused;
		this.hint = null;
	}

	private commitEditor(rawValue: string): void {
		const text = rawValue.trim();
		if (this.mode === "summary") {
			this.summary = text;
		} else if (this.mode === "note") {
			if (this.editingIndex !== null) {
				if (text) {
					this.annotations[this.editingIndex]!.note = text;
				} else {
					this.annotations.splice(this.editingIndex, 1);
				}
			} else if (text && this.anchor !== null) {
				const start = Math.min(this.anchor, this.cursor);
				const end = Math.max(this.anchor, this.cursor);
				const quoteLines = this.plainRows.slice(start, end + 1);
				this.annotations.push({ start, end, quoteLines, note: text });
			}
		}
		this.resetEditorState();
	}

	private cancelEditor(): void {
		this.resetEditorState();
	}

	private resetEditorState(): void {
		this.editor.setText("");
		this.editor.focused = false;
		this.mode = "nav";
		this.anchor = null;
		this.editingIndex = null;
	}
}

function lastAssistantTarget(ctx: ExtensionContext): { id: string; text: string } | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		const text = content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		if (text.trim()) return { id: entry.id, text };
	}
	return null;
}

function readConfiguredShortcut(): string | undefined {
	try {
		const settingsPath = join(getAgentDir(), "settings.json");
		if (!existsSync(settingsPath)) return undefined;
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as { annotate?: { shortcut?: unknown } };
		const shortcut = parsed.annotate?.shortcut;
		return typeof shortcut === "string" && shortcut.trim() ? shortcut.trim() : undefined;
	} catch {
		return undefined;
	}
}

export default function annotateExtension(pi: ExtensionAPI) {
	// Per-message draft state kept in memory for the session, so closing and reopening
	// on the same assistant message restores notes, summary, and cursor position.
	const drafts = new Map<string, Draft>();

	const launch = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("annotate requires the TUI", "warning");
			return;
		}
		const target = lastAssistantTarget(ctx);
		if (!target) {
			ctx.ui.notify("no assistant message with text to annotate", "warning");
			return;
		}

		let overlay: AnnotateOverlay | undefined;
		const result = await ctx.ui.custom<AnnotationBatch | null>(
			(tui, theme, keybindings, done) => {
				overlay = new AnnotateOverlay(
					tui,
					theme,
					keybindings,
					target.text,
					done,
					drafts.get(target.id),
				);
				return overlay;
			},
			{
				overlay: true,
				overlayOptions: {
					width: "90%",
					minWidth: 60,
					maxHeight: "80%",
					anchor: "center",
				},
			},
		);

		if (!result || (result.annotations.length === 0 && !result.summary?.trim())) {
			const state = overlay?.getDraftState();
			if (state && (state.annotations.length > 0 || state.summary.trim().length > 0)) {
				drafts.set(target.id, state);
				const parts: string[] = [];
				if (state.annotations.length > 0) parts.push(`${state.annotations.length} annotation(s)`);
				if (state.summary.trim()) parts.push("summary");
				ctx.ui.notify(`draft saved (${parts.join(" + ")}); reopen with /annotate`, "info");
			} else {
				drafts.delete(target.id);
			}
			return;
		}

		drafts.delete(target.id);
		const message = formatAnnotationBatch(result);
		if (ctx.isIdle()) {
			pi.sendUserMessage(message);
		} else {
			pi.sendUserMessage(message, { deliverAs: "followUp" });
		}

		const parts: string[] = [];
		if (result.summary?.trim()) parts.push("summary");
		if (result.annotations.length > 0) {
			parts.push(`${result.annotations.length} annotation${result.annotations.length === 1 ? "" : "s"}`);
		}
		ctx.ui.notify(`sent ${parts.join(" + ")}`, "info");
	};

	pi.registerCommand("annotate", {
		description: "Annotate the last assistant message (spans + optional summary) and send as one message",
		handler: async (_args, ctx) => launch(ctx),
	});

	const shortcut = (readConfiguredShortcut() || process.env.PI_ANNOTATE_SHORTCUT || "ctrl+shift+a") as KeyId;

	pi.registerShortcut(shortcut, {
		description: "Annotate the last assistant message",
		handler: async (ctx) => launch(ctx),
	});

	pi.on("session_shutdown", () => {
		drafts.clear();
	});
}
