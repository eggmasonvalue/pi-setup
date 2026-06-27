import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * ask-user-questions tool
 *
 * Batch-collect answers for related questions with a per-question Note field always shown.
 * Uses a single custom UI so Answer + Note are shown together.
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

function formatPrompt(q: Question): string {
  return q.context ? `${q.question}\n(${q.context})` : q.question;
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
    if (
      draft.selectedIndex !== null &&
      draft.selectedIndex >= 0 &&
      draft.selectedIndex < options.length
    ) {
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_questions",
    label: "Ask User Questions",
    description:
      "Batch-ask multiple related questions with context. Always includes a per-question Note field for nuanced answers.",
    promptSnippet: "Ask the user for information using batch question collection.",
    promptGuidelines: [
      "Use ask_user_questions when you need multiple pieces of information for research or planning.",
      "Group related questions together to reduce back-and-forth interruptions.",
      "Provide context/help text for clarifying questions.",
      "Structure your questions clearly so they can be answered without ambiguity.",
      "Use the Note section to capture nuance and dependencies.",
    ],
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
          type: Type.Union(
            [
              Type.Literal("select"),
              Type.Literal("multiselect"),
              Type.Literal("inline"),
            ],
            {
              description:
                "Question type: 'select' (single choice), 'multiselect' (multiple choices), 'inline' (text input)",
            },
          ),
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
          },
        };
      }

      for (const q of items) {
        if ((q.type === "select" || q.type === "multiselect") && (!q.options || q.options.length === 0)) {
          throw new Error(`${q.type} question '${q.id}' is missing options.`);
        }
      }

      onUpdate?.({
        content: [{ type: "text", text: `Collecting answers for: ${title}` }],
      });

      const result = await ctx.ui.custom<UIResult>((tui, theme, _kb, done) => {
        const editorTheme: EditorTheme = {
          borderColor: (s) => theme.fg("accent", s),
          selectList: {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          },
        };

        const drafts: Draft[] = items.map(() => ({
          answerText: "",
          noteText: "",
          selectedIndex: null,
          selectedIndices: [],
        }));

        const optionCursor: number[] = items.map(() => 0);

        let currentIndex = 0;
        let focus: "answer" | "note" = "answer";
        let cachedLines: string[] | undefined;
        let statusLine: { text: string; level: "info" | "warning" } | null = null;

        const editor = new Editor(tui, editorTheme);
        editor.disableSubmit = true;

        let editorBinding: { questionIndex: number; field: "answer" | "note" } | null = null;

        const isTextualAnswerQuestion = (q: Question): boolean => q.type === "inline";

        const desiredBinding = (): { questionIndex: number; field: "answer" | "note" } | null => {
          const q = items[currentIndex]!;
          if (focus === "note") return { questionIndex: currentIndex, field: "note" };
          if (isTextualAnswerQuestion(q)) return { questionIndex: currentIndex, field: "answer" };
          return null;
        };

        const saveEditorToDraft = () => {
          if (!editorBinding) return;
          const text = editor.getExpandedText();
          const draft = drafts[editorBinding.questionIndex]!;
          if (editorBinding.field === "answer") {
            draft.answerText = text;
          } else {
            draft.noteText = text;
          }
        };

        const bindEditor = () => {
          const target = desiredBinding();

          const isSameBinding =
            target &&
            editorBinding &&
            target.questionIndex === editorBinding.questionIndex &&
            target.field === editorBinding.field;

          if (!isSameBinding) {
            saveEditorToDraft();
            editorBinding = target;
            if (editorBinding) {
              const draft = drafts[editorBinding.questionIndex]!;
              const nextText = editorBinding.field === "answer" ? draft.answerText : draft.noteText;
              editor.setText(nextText);
            }
          }

          editor.focused = editorBinding !== null;
        };

        const refresh = () => {
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

        const renderStaticBox = (text: string, width: number, emptyHint: string): string[] => {
          const w = Math.max(8, width);
          const out: string[] = [theme.fg("borderMuted", "─".repeat(w))];

          const body = text.trim().length > 0 ? text : theme.fg("dim", emptyHint);
          const wrapped = wrapTextWithAnsi(body, w);
          const maxLines = 6;

          for (let i = 0; i < Math.min(maxLines, wrapped.length); i++) {
            out.push(wrapped[i]!);
          }

          if (wrapped.length > maxLines) {
            out.push(theme.fg("dim", `… ${wrapped.length - maxLines} more line(s)`));
          }

          out.push(theme.fg("borderMuted", "─".repeat(w)));
          return out;
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

        const isComplete = (index: number): boolean => {
          const q = items[index]!;
          const d = drafts[index]!;
          return !answerMissing(q, d);
        };

        const firstIncomplete = (): { index: number; focus: "answer" | "note" } | null => {
          for (let i = 0; i < items.length; i++) {
            const q = items[i]!;
            const d = drafts[i]!;
            if (answerMissing(q, d)) return { index: i, focus: "answer" };
          }
          return null;
        };

        const materializeAllAnswers = (): Answer[] =>
          items.map((q, i) => materializeAnswer(q, drafts[i]!));

        const trySubmit = () => {
          saveEditorToDraft();
          const missing = firstIncomplete();
          if (missing) {
            currentIndex = missing.index;
            focus = missing.focus;
            statusLine = {
              level: "warning",
              text: "Please complete all required answers before submit.",
            };
            bindEditor();
            refresh();
            return;
          }

          done({
            cancelled: false,
            cancelledAtIndex: -1,
            answers: materializeAllAnswers(),
          });
        };

        const moveQuestion = (delta: number) => {
          saveEditorToDraft();
          currentIndex = Math.max(0, Math.min(items.length - 1, currentIndex + delta));
          statusLine = null;
          bindEditor();
          refresh();
        };

        bindEditor();

        const handleInput = (data: string) => {
          if (matchesKey(data, Key.escape)) {
            saveEditorToDraft();
            done({
              cancelled: true,
              cancelledAtIndex: currentIndex,
              answers: materializeAllAnswers(),
            });
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
            saveEditorToDraft();
            focus = focus === "answer" ? "note" : "answer";
            statusLine = null;
            bindEditor();
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
                optionCursor[currentIndex] <= 0 ? options.length - 1 : optionCursor[currentIndex] - 1;
              statusLine = null;
              refresh();
              return;
            }

            if (matchesKey(data, Key.down)) {
              optionCursor[currentIndex] = (optionCursor[currentIndex] + 1) % options.length;
              statusLine = null;
              refresh();
              return;
            }

            if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
              const cursor = optionCursor[currentIndex];
              if (q.type === "multiselect") {
                if (d.selectedIndices.includes(cursor)) {
                  d.selectedIndices = d.selectedIndices.filter((idx) => idx !== cursor);
                } else {
                  d.selectedIndices = [...d.selectedIndices, cursor].sort((a, b) => a - b);
                }
                statusLine = null;
                refresh();
                return;
              }

              d.selectedIndex = cursor;
              statusLine = null;
              focus = "note";
              bindEditor();
              refresh();
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

          bindEditor();
          if (editorBinding) {
            editor.handleInput(data);
            saveEditorToDraft();
            statusLine = null;
            refresh();
          }
        };

        const render = (width: number): string[] => {
          if (cachedLines) return cachedLines;

          bindEditor();

          const renderWidth = Math.max(20, width);
          const lines: string[] = [];
          const q = items[currentIndex]!;
          const d = drafts[currentIndex]!;

          lines.push(theme.fg("accent", "─".repeat(renderWidth)));
          addWrappedWithPrefix(lines, " ", theme.fg("accent", theme.bold(title)), renderWidth);
          if (description) {
            addWrappedWithPrefix(lines, " ", theme.fg("muted", description), renderWidth);
          }

          const completedCount = items.filter((_x, i) => isComplete(i)).length;
          addWrappedWithPrefix(
            lines,
            " ",
            theme.fg("dim", `Complete: ${completedCount}/${items.length} • Note field shown for every question`),
            renderWidth,
          );

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

          lines.push("");
          addWrappedWithPrefix(
            lines,
            " ",
            theme.fg("accent", `Question ${currentIndex + 1}/${items.length} • ${q.type}`),
            renderWidth,
          );
          addWrappedWithPrefix(lines, " ", theme.fg("text", formatPrompt(q)), renderWidth);

          lines.push("");
          const answerHeader = focus === "answer"
            ? theme.fg("accent", theme.bold("Answer"))
            : theme.fg("muted", "Answer");
          addWrappedWithPrefix(lines, " ", answerHeader, renderWidth);

          if (q.type === "select" || q.type === "multiselect") {
            const opts = getOptionsForQuestion(q);
            for (let i = 0; i < opts.length; i++) {
              const opt = opts[i]!;
              const cursor = focus === "answer" && optionCursor[currentIndex] === i;
              const selected = q.type === "multiselect" ? d.selectedIndices.includes(i) : d.selectedIndex === i;
              const prefix = cursor ? theme.fg("accent", "> ") : "  ";
              const marker = selected ? "●" : "○";
              const color = cursor ? "accent" : selected ? "success" : "text";
              addWrappedWithPrefix(lines, prefix, theme.fg(color, `${marker} ${i + 1}. ${opt.label}`), renderWidth);
            }

            if (!isRequired(q)) {
              addWrappedWithPrefix(lines, " ", theme.fg("dim", "Optional: Backspace/Delete clears selection"), renderWidth);
            }
          } else {
            if (q.placeholder && d.answerText.trim().length === 0 && !(focus === "answer" && editorBinding?.field === "answer")) {
              addWrappedWithPrefix(lines, " ", theme.fg("dim", `Hint: ${q.placeholder}`), renderWidth);
            }

            const answerBlock =
              focus === "answer" && editorBinding?.field === "answer"
                ? editor.render(Math.max(8, renderWidth - 2))
                : renderStaticBox(d.answerText, Math.max(8, renderWidth - 2), q.placeholder ?? "(no answer yet)");
            for (const row of answerBlock) lines.push(` ${row}`);
          }

          lines.push("");
          const noteHeader = focus === "note"
            ? theme.fg("accent", theme.bold("Note"))
            : theme.fg("muted", "Note");
          addWrappedWithPrefix(lines, " ", noteHeader, renderWidth);
          addWrappedWithPrefix(
            lines,
            " ",
            theme.fg("muted", q.notePrompt ?? "Add assumptions, caveats, dependencies, and it-depends context."),
            renderWidth,
          );

          const noteBlock =
            focus === "note" && editorBinding?.field === "note"
              ? editor.render(Math.max(8, renderWidth - 2))
              : renderStaticBox(d.noteText, Math.max(8, renderWidth - 2), q.notePlaceholder ?? "(optional note)");
          for (const row of noteBlock) lines.push(` ${row}`);

          lines.push("");

          if (statusLine) {
            addWrappedWithPrefix(
              lines,
              " ",
              statusLine.level === "warning" ? theme.fg("warning", statusLine.text) : theme.fg("muted", statusLine.text),
              renderWidth,
            );
          }

          const modeHint = q.type === "select" || q.type === "multiselect"
            ? q.type === "multiselect"
              ? "↑↓ move option • Enter/Space toggle • 1-9 quick toggle"
              : "↑↓ move option • Enter/Space choose • 1-9 quick choose"
            : "Shift+Enter newline (in editor)";
          addWrappedWithPrefix(lines, " ", theme.fg("dim", modeHint), renderWidth);
          addWrappedWithPrefix(
            lines,
            " ",
            theme.fg("dim", "Alt+←/→ or Ctrl+P/N question • Tab switch Answer/Note • Ctrl+S submit • Esc cancel"),
            renderWidth,
          );

          lines.push(theme.fg("accent", "─".repeat(renderWidth)));

          cachedLines = lines;
          return lines;
        };

        return {
          render,
          invalidate: () => {
            cachedLines = undefined;
            editor.invalidate();
          },
          handleInput,
        };
      });

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
          },
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
        resultLines.push(`   Answer: ${String(ans.answer)}`);
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
        },
      };
    },
  });
}
