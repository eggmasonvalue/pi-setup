import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Focusable,
	Input,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * ask-user-questions tool
 *
 * Batch-collect answers for related questions with a per-question Note field always shown.
 * Uses a single custom TUI component so Answer + Note are visible together.
 *
 * Registered as `exposure: "model-only"` and `executionMode: "sequential"` so codemode
 * scripts cannot invoke interactive UI and parallel tool calls cannot race on `ctx.ui.custom()`.
 */

type QuestionType = "select" | "multiselect" | "inline";

interface Question {
	id: string;
	question: string;
	type: QuestionType;
	placeholder?: string;
	options?: string[];
	required?: boolean;
	context?: string;
	notePrompt?: string;
	notePlaceholder?: string;
}

interface Answer {
	id: string;
	question: string;
	type: QuestionType;
	answer: string | string[];
	note?: string;
	cancelled: boolean;
	noteCancelled?: boolean;
}

interface AskUserQuestionsDetails {
	title: string;
	answers: Answer[];
	allAnswered: boolean;
	skippedCount: number;
	notesProvidedCount: number;
	noteSkippedCount: number;
	reviewCancelled: boolean;
	cancelled: boolean;
	cancelledAtIndex: number;
}

interface Draft {
	answerText: string;
	noteText: string;
	selectedIndex: number | null;
	selectedIndices: number[];
}

interface UIResult {
	cancelled: boolean;
	cancelledAtIndex: number;
	answers: Answer[];
}

function isRequired(q: Question): boolean {
	return q.required !== false;
}

function getOptionsForQuestion(q: Question): Array<{ label: string; value: string }> {
	if (q.type === "select" || q.type === "multiselect") {
		return (q.options ?? []).map((opt) => ({ label: opt, value: opt }));
	}
	return [];
}

function materializeAnswer(q: Question, draft: Draft): Answer {
	const note = draft.noteText.trim();

	let answer: string | string[] = "[skipped]";
	let cancelled = true;

	if (q.type === "inline") {
		const value = draft.answerText.trim();
		if (value.length > 0) {
			answer = value;
			cancelled = false;
		} else if (!isRequired(q)) {
			answer = "[skipped]";
			cancelled = false;
		}
	} else if (q.type === "select") {
		const options = q.options ?? [];
		if (draft.selectedIndex !== null && draft.selectedIndex >= 0 && draft.selectedIndex < options.length) {
			answer = options[draft.selectedIndex]!;
			cancelled = false;
		} else if (!isRequired(q)) {
			answer = "[skipped]";
			cancelled = false;
		}
	} else if (q.type === "multiselect") {
		const options = q.options ?? [];
		const selected = draft.selectedIndices
			.filter((idx) => idx >= 0 && idx < options.length)
			.sort((a, b) => a - b)
			.map((idx) => options[idx]!);
		if (selected.length > 0) {
			answer = selected;
			cancelled = false;
		} else if (!isRequired(q)) {
			answer = [];
			cancelled = false;
		}
	}

	return {
		id: q.id,
		question: q.question,
		type: q.type,
		answer,
		note: note.length > 0 ? note : undefined,
		cancelled,
		noteCancelled: note.length === 0,
	};
}

export default function askUserQuestionsExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_questions",
		label: "Ask User Questions",
		description:
			"Batch-ask multiple related questions with context. Always includes a per-question Note field for nuanced answers.",
		promptSnippet: "Ask the user for information using batch question collection.",
		promptGuidelines: [
			"Use ask_user_questions when you need multiple missing inputs from the user.",
			"Ask one concise batch and use Note fields for nuances.",
		],
		exposure: "model-only",
		executionMode: "sequential",
		annotations: {
			readOnlyHint: true,
			openWorldHint: false,
		},
		parameters: Type.Object({
			title: Type.String({
				description: "Title for the question batch (e.g., 'Research Parameters')",
			}),
			questions: Type.Array(
				Type.Object({
					id: Type.String({
						description: "Unique identifier for the question (e.g., 'q_company_name')",
					}),
					question: Type.String({
						description: "The question to ask",
					}),
					type: StringEnum(["select", "multiselect", "inline"] as const, {
						description:
							"Question type: 'select' (single choice), 'multiselect' (multiple choices), 'inline' (text input)",
					}),
					placeholder: Type.Optional(
						Type.String({
							description: "Placeholder text for input fields",
						}),
					),
					options: Type.Optional(
						Type.Array(Type.String(), {
							description: "Options for select-type questions",
						}),
					),
					required: Type.Optional(
						Type.Boolean({
							description: "Whether the primary answer is required",
							default: true,
						}),
					),
					context: Type.Optional(
						Type.String({
							description: "Help text/clarification for the question (shown to user)",
						}),
					),
					notePrompt: Type.Optional(
						Type.String({
							description: "Custom prompt shown for the Note field",
						}),
					),
					notePlaceholder: Type.Optional(
						Type.String({
							description: "Placeholder text for the Note field",
						}),
					),
				}),
			),
			description: Type.Optional(
				Type.String({
					description: "Description of why these questions are being asked",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { title, questions, description } = params;
			const items = questions as Question[];

			if (ctx.mode !== "tui") {
				throw new Error("ask_user_questions requires TUI mode (ctx.ui.custom).");
			}

			if (items.length === 0) {
				return {
					content: [{ type: "text", text: "No questions provided." }],
					details: {
						title,
						answers: [],
						allAnswered: true,
						skippedCount: 0,
						notesProvidedCount: 0,
						noteSkippedCount: 0,
						reviewCancelled: false,
						cancelled: false,
						cancelledAtIndex: -1,
					} satisfies AskUserQuestionsDetails,
				};
			}

			for (const q of items) {
				if ((q.type === "select" || q.type === "multiselect") && (!q.options || q.options.length === 0)) {
					throw new Error(`${q.type} question '${q.id}' is missing options.`);
				}
			}

			onUpdate?.({
				content: [{ type: "text", text: `Collecting answers for: ${title}` }],
				details: {
					title,
					answers: [],
					allAnswered: false,
					skippedCount: 0,
					notesProvidedCount: 0,
					noteSkippedCount: 0,
					reviewCancelled: false,
					cancelled: false,
					cancelledAtIndex: -1,
				} satisfies AskUserQuestionsDetails,
			});

			const result = await ctx.ui.custom<UIResult>(
				(tui, theme, _kb, done) => {
					const drafts: Draft[] = items.map(() => ({
						answerText: "",
						noteText: "",
						selectedIndex: null,
						selectedIndices: [],
					}));

					const optionCursor: number[] = items.map(() => 0);

					let currentIndex = 0;
					let focus: "answer" | "note" = "answer";
					let componentFocused = false;
					let cachedWidth: number | undefined;
					let cachedLines: string[] | undefined;
					let statusLine: { text: string; level: "info" | "warning" } | null = null;

					let activeInput: Input | null = null;
					let inputBinding: { questionIndex: number; field: "answer" | "note" } | null = null;
					let inputActionHandled = false;

					const desiredBinding = (): { questionIndex: number; field: "answer" | "note" } | null => {
						const q = items[currentIndex]!;
						if (focus === "note") return { questionIndex: currentIndex, field: "note" };
						if (q.type === "inline") return { questionIndex: currentIndex, field: "answer" };
						return null;
					};

					const saveInputToDraft = () => {
						if (!inputBinding || !activeInput) return;
						const text = activeInput.getValue();
						const draft = drafts[inputBinding.questionIndex]!;
						if (inputBinding.field === "answer") {
							draft.answerText = text;
						} else {
							draft.noteText = text;
						}
					};

					const invalidate = () => {
						cachedWidth = undefined;
						cachedLines = undefined;
						activeInput?.invalidate();
					};

					const refresh = () => {
						cachedWidth = undefined;
						cachedLines = undefined;
						tui.requestRender();
					};

					const questionLabel = (q: Question, idx: number): string => {
						const raw = q.id?.trim() ? q.id.trim() : `Q${idx + 1}`;
						return truncateToWidth(raw, 16, "");
					};

					const addWrappedWithPrefix = (lines: string[], prefix: string, text: string, renderWidth: number) => {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							lines.push(...wrapTextWithAnsi(`${prefix}${text}`, renderWidth));
							return;
						}

						const wrapped = wrapTextWithAnsi(text, Math.max(1, renderWidth - prefixWidth));
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					};

					const renderRule = (width: number, left?: string, right?: string): string => {
						const dash = (n: number) => (n > 0 ? theme.fg("accent", "─".repeat(n)) : "");
						if (!left && !right) return dash(width);

						const rightPart = right ? ` ${right} ` : "";
						const rightW = visibleWidth(rightPart);
						const rightTail = right ? 1 : 0;
						const leftLead = 1;

						const maxLeftSpace = Math.max(0, width - leftLead - rightW - rightTail - 2);
						const leftTrimmed = left && maxLeftSpace > 0 ? truncateToWidth(left, maxLeftSpace, "…") : "";
						const leftPart = leftTrimmed ? ` ${leftTrimmed} ` : "";
						const leftW = visibleWidth(leftPart);

						const fill = Math.max(0, width - leftLead - leftW - rightW - rightTail);
						return truncateToWidth(`${dash(leftLead)}${leftPart}${dash(fill)}${rightPart}${dash(rightTail)}`, width, "");
					};

					const answerMissing = (q: Question, draft: Draft): boolean => {
						if (q.type === "inline") {
							return isRequired(q) && draft.answerText.trim().length === 0;
						}
						if (q.type === "select") {
							return isRequired(q) && draft.selectedIndex === null;
						}
						if (q.type === "multiselect") {
							return isRequired(q) && draft.selectedIndices.length === 0;
						}
						return true;
					};

					const isComplete = (index: number): boolean => !answerMissing(items[index]!, drafts[index]!);

					const firstIncomplete = (): { index: number; focus: "answer" | "note" } | null => {
						for (let i = 0; i < items.length; i++) {
							if (answerMissing(items[i]!, drafts[i]!)) return { index: i, focus: "answer" };
						}
						return null;
					};

					const materializeAllAnswers = (): Answer[] => items.map((q, i) => materializeAnswer(q, drafts[i]!));

					const cancel = () => {
						saveInputToDraft();
						done({
							cancelled: true,
							cancelledAtIndex: currentIndex,
							answers: materializeAllAnswers(),
						});
					};

					const trySubmit = () => {
						saveInputToDraft();
						const missing = firstIncomplete();
						if (missing) {
							currentIndex = missing.index;
							focus = missing.focus;
							statusLine = {
								level: "warning",
								text: "Please complete all required answers before submit.",
							};
							bindInput();
							refresh();
							return;
						}

						done({
							cancelled: false,
							cancelledAtIndex: -1,
							answers: materializeAllAnswers(),
						});
					};

					const advanceOrSubmit = () => {
						saveInputToDraft();
						const q = items[currentIndex]!;
						if (answerMissing(q, drafts[currentIndex]!)) {
							focus = "answer";
							statusLine = {
								level: "warning",
								text:
									q.type === "multiselect"
										? "Select at least one option with Space (or 1-9)."
										: "This question is required.",
							};
							bindInput();
							refresh();
							return;
						}

						if (currentIndex < items.length - 1) {
							currentIndex += 1;
							focus = "answer";
							statusLine = null;
							bindInput();
							refresh();
							return;
						}

						trySubmit();
					};

					const bindInput = () => {
						const target = desiredBinding();

						const isSameBinding =
							target &&
							inputBinding &&
							target.questionIndex === inputBinding.questionIndex &&
							target.field === inputBinding.field;

						if (!isSameBinding) {
							saveInputToDraft();
							inputBinding = target;
							if (inputBinding) {
								const q = items[inputBinding.questionIndex]!;
								const draft = drafts[inputBinding.questionIndex]!;
								const isNote = inputBinding.field === "note";
								const nextText = isNote ? draft.noteText : draft.answerText;
								activeInput = new Input({
									prompt: isNote ? theme.fg("accent", theme.bold("Note: ")) : theme.fg("accent", "▸ "),
									placeholder: isNote
										? (q.notePlaceholder ?? q.notePrompt ?? "(optional)")
										: (q.placeholder ?? "Type your answer..."),
									placeholderStyle: (t) => theme.fg("dim", t),
								});
								activeInput.setValue(nextText);
								activeInput.onSubmit = () => {
									inputActionHandled = true;
									advanceOrSubmit();
								};
								activeInput.onEscape = () => {
									inputActionHandled = true;
									cancel();
								};
							} else {
								activeInput = null;
							}
						}

						if (activeInput) {
							activeInput.focused = componentFocused;
						}
					};

					const moveQuestion = (delta: number) => {
						saveInputToDraft();
						const next = Math.max(0, Math.min(items.length - 1, currentIndex + delta));
						if (next === currentIndex) return;
						currentIndex = next;
						focus = "answer";
						statusLine = null;
						bindInput();
						refresh();
					};

					bindInput();

					const handleInput = (data: string) => {
						if (matchesKey(data, Key.escape)) {
							cancel();
							return;
						}

						if (matchesKey(data, Key.alt("left")) || matchesKey(data, Key.ctrl("p"))) {
							moveQuestion(-1);
							return;
						}

						if (matchesKey(data, Key.alt("right")) || matchesKey(data, Key.ctrl("n"))) {
							moveQuestion(1);
							return;
						}

						if (matchesKey(data, Key.ctrl("s"))) {
							trySubmit();
							return;
						}

						if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
							saveInputToDraft();
							focus = focus === "answer" ? "note" : "answer";
							statusLine = null;
							bindInput();
							refresh();
							return;
						}

						const q = items[currentIndex]!;
						const d = drafts[currentIndex]!;

						if ((q.type === "select" || q.type === "multiselect") && focus === "answer") {
							const options = getOptionsForQuestion(q);
							if (options.length === 0) {
								statusLine = { level: "warning", text: "No options available for this question." };
								refresh();
								return;
							}

							if (matchesKey(data, Key.up)) {
								optionCursor[currentIndex] =
									optionCursor[currentIndex]! <= 0 ? options.length - 1 : optionCursor[currentIndex]! - 1;
								statusLine = null;
								refresh();
								return;
							}

							if (matchesKey(data, Key.down)) {
								optionCursor[currentIndex] = (optionCursor[currentIndex]! + 1) % options.length;
								statusLine = null;
								refresh();
								return;
							}

							if (matchesKey(data, Key.space)) {
								const cursor = optionCursor[currentIndex]!;
								if (q.type === "multiselect") {
									if (d.selectedIndices.includes(cursor)) {
										d.selectedIndices = d.selectedIndices.filter((idx) => idx !== cursor);
									} else {
										d.selectedIndices = [...d.selectedIndices, cursor].sort((a, b) => a - b);
									}
								} else {
									d.selectedIndex = cursor;
								}
								statusLine = null;
								refresh();
								return;
							}

							if (matchesKey(data, Key.enter)) {
								if (q.type === "select") {
									d.selectedIndex = optionCursor[currentIndex]!;
								}
								advanceOrSubmit();
								return;
							}

							if (/^[1-9]$/.test(data)) {
								const n = Number(data);
								if (n <= options.length) {
									const idx = n - 1;
									optionCursor[currentIndex] = idx;
									if (q.type === "multiselect") {
										if (d.selectedIndices.includes(idx)) {
											d.selectedIndices = d.selectedIndices.filter((x) => x !== idx);
										} else {
											d.selectedIndices = [...d.selectedIndices, idx].sort((a, b) => a - b);
										}
									} else {
										d.selectedIndex = idx;
									}
									statusLine = null;
									refresh();
									return;
								}
							}

							if ((matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) && !isRequired(q)) {
								if (q.type === "multiselect") d.selectedIndices = [];
								else d.selectedIndex = null;
								statusLine = null;
								refresh();
								return;
							}

							return;
						}

						bindInput();
						if (activeInput) {
							inputActionHandled = false;
							activeInput.handleInput(data);
							if (!inputActionHandled) {
								saveInputToDraft();
								statusLine = null;
								refresh();
							}
						}
					};

					const render = (width: number): string[] => {
						if (cachedLines && cachedWidth === width) return cachedLines;

						bindInput();

						const renderWidth = Math.max(20, width);
						const lines: string[] = [];
						const q = items[currentIndex]!;
						const d = drafts[currentIndex]!;

						const progress = items.length > 1 ? theme.fg("muted", `${currentIndex + 1}/${items.length}`) : undefined;
						lines.push(renderRule(renderWidth, theme.fg("accent", theme.bold(title)), progress));

						if (description) {
							addWrappedWithPrefix(lines, " ", theme.fg("muted", description), renderWidth);
						}

						if (items.length > 1) {
							const tabs: string[] = [];
							for (let i = 0; i < items.length; i++) {
								const item = items[i]!;
								const active = i === currentIndex;
								const complete = isComplete(i);
								const token = ` ${complete ? "■" : "□"} ${questionLabel(item, i)} `;
								const styled = active
									? theme.bg("selectedBg", theme.fg("text", token))
									: theme.fg(complete ? "success" : "muted", token);
								tabs.push(styled);
							}
							addWrappedWithPrefix(lines, " ", tabs.join(" "), renderWidth);
						}

						if (description || items.length > 1) {
							lines.push("");
						}

						const questionLine = isRequired(q)
							? theme.fg("text", theme.bold(q.question))
							: `${theme.fg("text", theme.bold(q.question))} ${theme.fg("dim", "[optional]")}`;
						addWrappedWithPrefix(lines, " ", questionLine, renderWidth);

						if (q.context) {
							addWrappedWithPrefix(lines, "   ", theme.fg("muted", q.context), renderWidth);
						}

						if (q.type === "select" || q.type === "multiselect") {
							const opts = getOptionsForQuestion(q);
							for (let i = 0; i < opts.length; i++) {
								const opt = opts[i]!;
								const cursor = focus === "answer" && optionCursor[currentIndex] === i;
								const selected = q.type === "multiselect" ? d.selectedIndices.includes(i) : d.selectedIndex === i;
								const prefix = cursor ? theme.fg("accent", " ▸ ") : "   ";
								const marker = q.type === "multiselect" ? (selected ? "☑" : "☐") : selected ? "●" : "○";
								const color = cursor ? "accent" : selected ? "success" : "text";
								addWrappedWithPrefix(lines, prefix, theme.fg(color, `${marker} ${i + 1}. ${opt.label}`), renderWidth);
							}
						} else if (focus === "answer" && activeInput) {
							const [row] = activeInput.render(Math.max(10, renderWidth - 1));
							lines.push(` ${row ?? ""}`);
						} else {
							const preview =
								d.answerText.trim().length > 0
									? theme.fg("text", d.answerText)
									: theme.fg("dim", q.placeholder ?? "(no answer yet)");
							lines.push(truncateToWidth(` ${theme.fg("muted", "▸ ")}${preview}`, renderWidth, "…"));
						}

						lines.push("");

						if (focus === "note" && activeInput) {
							const [row] = activeInput.render(Math.max(10, renderWidth - 1));
							lines.push(` ${row ?? ""}`);
						} else {
							const noteEmptyHint =
								q.notePrompt || q.notePlaceholder
									? `${q.notePrompt ?? q.notePlaceholder} (Tab)`
									: "(optional — Tab to add)";
							const noteBody =
								d.noteText.trim().length > 0 ? theme.fg("text", d.noteText) : theme.fg("dim", noteEmptyHint);
							lines.push(truncateToWidth(` ${theme.fg("muted", "Note: ")}${noteBody}`, renderWidth, "…"));
						}

						if (statusLine) {
							addWrappedWithPrefix(
								lines,
								" ",
								statusLine.level === "warning" ? theme.fg("warning", statusLine.text) : theme.fg("muted", statusLine.text),
								renderWidth,
							);
						}

						const isLast = currentIndex === items.length - 1;
						const multi = items.length > 1;
						const enterLabel = isLast ? "Enter submit" : "Enter next";
						const hints: string[] = [];

						if (focus === "answer" && q.type === "select") {
							hints.push(multi ? "↑↓ pick" : "↑↓/1-9 pick", "Space select", enterLabel, "Tab note");
							if (!isRequired(q) && d.selectedIndex !== null) hints.push("Del clear");
						} else if (focus === "answer" && q.type === "multiselect") {
							hints.push("Space/1-9 toggle", enterLabel, "Tab note");
							if (!isRequired(q) && d.selectedIndices.length > 0) hints.push("Del clear");
						} else {
							hints.push(enterLabel, focus === "note" ? "Tab answer" : "Tab note");
						}

						if (multi) hints.push("^P/^N");
						if (!isLast) hints.push("^S submit");
						hints.push(multi && !isLast ? "Esc" : "Esc cancel");

						lines.push(renderRule(renderWidth, theme.fg("dim", hints.join(" • "))));

						cachedWidth = width;
						cachedLines = lines;
						return lines;
					};

					const component: Focusable & {
						render: (width: number) => string[];
						invalidate: () => void;
						handleInput: (data: string) => void;
					} = {
						get focused() {
							return componentFocused;
						},
						set focused(value: boolean) {
							componentFocused = value;
							if (activeInput) activeInput.focused = value;
						},
						render,
						invalidate,
						handleInput,
					};

					return component;
				},
				{
					blocked: { kind: "question", message: title },
				},
			);

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled ask_user_questions." }],
					details: {
						title,
						answers: result.answers,
						allAnswered: false,
						skippedCount: result.answers.filter((a) => a.cancelled).length,
						notesProvidedCount: result.answers.filter((a) => Boolean(a.note)).length,
						noteSkippedCount: result.answers.filter((a) => a.noteCancelled).length,
						reviewCancelled: false,
						cancelled: true,
						cancelledAtIndex: result.cancelledAtIndex,
					} satisfies AskUserQuestionsDetails,
				};
			}

			const answers = result.answers;
			const allAnswered = answers.every((a) => !a.cancelled);

			const resultLines: string[] = [
				`\n${"=".repeat(60)}`,
				`Answers for: ${title}`,
				`${"=".repeat(60)}`,
			];

			for (const ans of answers) {
				const marker = ans.cancelled ? "⊘" : "✓";
				resultLines.push(`\n${marker} ${ans.question}`);
				resultLines.push(`   Answer: ${Array.isArray(ans.answer) ? ans.answer.join(", ") : String(ans.answer)}`);
				resultLines.push(`   Note: ${ans.note ? ans.note : "(none)"}`);
			}

			resultLines.push(`\n${"=".repeat(60)}`);
			if (!allAnswered) resultLines.push("⚠ Submission ended with incomplete answers.");
			resultLines.push("Use these answers + notes to inform your research/planning.");

			return {
				content: [{ type: "text", text: resultLines.join("\n") }],
				details: {
					title,
					answers,
					allAnswered,
					skippedCount: answers.filter((a) => a.cancelled).length,
					notesProvidedCount: answers.filter((a) => Boolean(a.note)).length,
					noteSkippedCount: answers.filter((a) => a.noteCancelled).length,
					reviewCancelled: false,
					cancelled: false,
					cancelledAtIndex: -1,
				} satisfies AskUserQuestionsDetails,
			};
		},

		renderCall(args, theme) {
			const title = typeof args.title === "string" ? args.title : "Questions";
			const qs = Array.isArray(args.questions) ? args.questions : [];
			let text = theme.fg("toolTitle", theme.bold("ask_user_questions "));
			text += theme.fg("accent", title);
			text += theme.fg("dim", ` (${qs.length} question${qs.length === 1 ? "" : "s"})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Waiting for user answers..."), 0, 0);
			}
			const details = result.details as AskUserQuestionsDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const answered = details.answers.filter((a) => !a.cancelled).length;
			const notesSuffix = details.notesProvidedCount > 0 ? `, ${details.notesProvidedCount} note(s)` : "";
			let header = theme.fg("success", `✓ ${answered}/${details.answers.length} answered`) + theme.fg("dim", notesSuffix);

			if (!expanded) {
				if (details.answers.length > 0) {
					header += ` ${theme.fg("dim", `(${context.keyHint("app.tools.expand", "to expand")})`)}`;
				}
				return new Text(header, 0, 0);
			}

			const lines = [header];
			for (const ans of details.answers) {
				const marker = ans.cancelled ? theme.fg("dim", "⊘") : theme.fg("success", "✓");
				const formattedAnswer = Array.isArray(ans.answer) ? ans.answer.join(", ") : ans.answer;
				lines.push(`${marker} ${theme.fg("accent", ans.id)}: ${theme.fg("text", formattedAnswer)}`);
				if (ans.note) {
					lines.push(`  ${theme.fg("muted", `Note: ${ans.note}`)}`);
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
