import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEditTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile as fsReadFile, unlink as fsUnlink, writeFile as fsWriteFile } from "fs/promises";
import { isAbsolute, resolve as resolvePath } from "path";

type MultiItem = { path?: string; oldText: string; newText: string };

type PatchOperation =
	| { kind: "add"; path: string; contents: string }
	| { kind: "delete"; path: string }
	| { kind: "update"; path: string; chunks: UpdateChunk[] };

type UpdateChunk = {
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
};

const schema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to the file to edit (relative or absolute)" })),
	edits: Type.Optional(
		Type.Array(
			Type.Object({
				oldText: Type.String({ description: "Exact text for one targeted replacement." }),
				newText: Type.String({ description: "Replacement text for this targeted edit." }),
			}),
			{ description: "One or more targeted replacements (single file)." },
		),
	),
	multi: Type.Optional(
		Type.Array(
			Type.Object({
				path: Type.Optional(Type.String({ description: "Per-edit file path (inherits top-level path if omitted)" })),
				oldText: Type.String({ description: "Exact text to find" }),
				newText: Type.String({ description: "Replacement text" }),
			}),
			{ description: "Multiple single edits across one or more files." },
		),
	),
	patch: Type.Optional(
		Type.String({ description: "Codex-style patch payload: *** Begin Patch ... *** End Patch" }),
	),
});

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectLineEnding(content: string): "\n" | "\r\n" {
	const crlf = content.indexOf("\r\n");
	const lf = content.indexOf("\n");
	if (lf === -1 || crlf === -1) return "\n";
	return crlf < lf ? "\r\n" : "\n";
}

function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function resolveToCwd(filePath: string, cwd: string): string {
	return isAbsolute(filePath) ? resolvePath(filePath) : resolvePath(cwd, filePath);
}

function simpleDiff(oldText: string, newText: string): string {
	const a = oldText.split("\n");
	const b = newText.split("\n");
	const max = Math.max(a.length, b.length);
	const out: string[] = [];
	for (let i = 0; i < max; i++) {
		const left = a[i];
		const right = b[i];
		if (left === right) {
			if (left !== undefined) out.push(`  ${left}`);
			continue;
		}
		if (left !== undefined) out.push(`- ${left}`);
		if (right !== undefined) out.push(`+ ${right}`);
	}
	return out.join("\n");
}

function parsePatch(patchText: string): PatchOperation[] {
	const lines = normalizeToLF(patchText).trim().split("\n");
	if (lines.length < 2 || lines[0] !== "*** Begin Patch" || lines[lines.length - 1] !== "*** End Patch") {
		throw new Error("Patch must start with '*** Begin Patch' and end with '*** End Patch'.");
	}

	const ops: PatchOperation[] = [];
	let i = 1;
	while (i < lines.length - 1) {
		const h = lines[i];
		if (h.startsWith("*** Add File: ")) {
			const path = h.slice("*** Add File: ".length).trim();
			i++;
			const body: string[] = [];
			while (i < lines.length - 1 && !lines[i].startsWith("*** ")) {
				const line = lines[i];
				if (!line.startsWith("+")) throw new Error(`Add file lines must start with '+': ${line}`);
				body.push(line.slice(1));
				i++;
			}
			ops.push({ kind: "add", path, contents: `${body.join("\n")}\n` });
			continue;
		}

		if (h.startsWith("*** Delete File: ")) {
			ops.push({ kind: "delete", path: h.slice("*** Delete File: ".length).trim() });
			i++;
			continue;
		}

		if (h.startsWith("*** Update File: ")) {
			const path = h.slice("*** Update File: ".length).trim();
			i++;
			const chunks: UpdateChunk[] = [];
			while (i < lines.length - 1 && !lines[i].startsWith("*** ")) {
				if (!lines[i].startsWith("@@")) throw new Error(`Expected '@@' hunk header, got: ${lines[i]}`);
				const isEndOfFile = lines[i].includes("EOF");
				i++;
				const oldLines: string[] = [];
				const newLines: string[] = [];
				while (i < lines.length - 1 && !lines[i].startsWith("@@") && !lines[i].startsWith("*** ")) {
					const row = lines[i];
					const prefix = row[0];
					const text = row.slice(1);
					if (prefix === " ") {
						oldLines.push(text);
						newLines.push(text);
					} else if (prefix === "-") oldLines.push(text);
					else if (prefix === "+") newLines.push(text);
					else throw new Error(`Invalid line prefix '${prefix}' in: ${row}`);
					i++;
				}
				chunks.push({ oldLines, newLines, isEndOfFile });
			}
			ops.push({ kind: "update", path, chunks });
			continue;
		}

		throw new Error(`Invalid patch header: ${h}`);
	}
	return ops;
}

function findChunkStart(lines: string[], needle: string[], from: number, eof: boolean): number {
	if (needle.length === 0) return from;
	if (eof) {
		const idx = lines.length - needle.length;
		if (idx < 0) return -1;
		for (let j = 0; j < needle.length; j++) if (lines[idx + j] !== needle[j]) return -1;
		return idx;
	}
	for (let i = from; i <= lines.length - needle.length; i++) {
		let ok = true;
		for (let j = 0; j < needle.length; j++) {
			if (lines[i + j] !== needle[j]) {
				ok = false;
				break;
			}
		}
		if (ok) return i;
	}
	return -1;
}

async function applyPatchOps(ops: PatchOperation[], cwd: string, virtualOnly: boolean): Promise<{ summary: string[]; diffs: string[] }> {
	const mem = new Map<string, string | null>();
	const summary: string[] = [];
	const diffs: string[] = [];

	const readText = async (abs: string): Promise<string> => {
		if (mem.has(abs)) {
			const v = mem.get(abs);
			if (v == null) throw new Error(`File not found: ${abs}`);
			return v;
		}
		try {
			const v = await fsReadFile(abs, "utf-8");
			mem.set(abs, v);
			return v;
		} catch {
			mem.set(abs, null);
			throw new Error(`File not found: ${abs}`);
		}
	};

	const writeText = async (abs: string, text: string) => {
		mem.set(abs, text);
		if (!virtualOnly) await withFileMutationQueue(abs, async () => fsWriteFile(abs, text, "utf-8"));
	};
	const deleteText = async (abs: string) => {
		mem.set(abs, null);
		if (!virtualOnly) await withFileMutationQueue(abs, async () => fsUnlink(abs));
	};

	for (const op of ops) {
		const abs = resolveToCwd(op.path, cwd);
		if (op.kind === "add") {
			const before = mem.get(abs) ?? "";
			await writeText(abs, op.contents);
			summary.push(`Added ${op.path}`);
			diffs.push(`File: ${op.path}\n${simpleDiff(before, op.contents)}`);
			continue;
		}
		if (op.kind === "delete") {
			const before = await readText(abs);
			await deleteText(abs);
			summary.push(`Deleted ${op.path}`);
			diffs.push(`File: ${op.path}\n${simpleDiff(before, "")}`);
			continue;
		}

		const originalRaw = await readText(abs);
		const ending = detectLineEnding(originalRaw);
		const lines = normalizeToLF(originalRaw).split("\n");
		let cursor = 0;
		for (const c of op.chunks) {
			const start = findChunkStart(lines, c.oldLines, cursor, c.isEndOfFile);
			if (start < 0) throw new Error(`Could not locate update hunk in ${op.path}.`);
			lines.splice(start, c.oldLines.length, ...c.newLines);
			cursor = start + c.newLines.length;
		}
		const out = restoreLineEndings(lines.join("\n"), ending);
		await writeText(abs, out);
		summary.push(`Updated ${op.path}`);
		diffs.push(`File: ${op.path}\n${simpleDiff(originalRaw, out)}`);
	}

	return { summary, diffs };
}

export default function editHybrid(pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: "Exact text editing with support for edits[], multi[], and Codex-style patch.",
		promptSnippet: "Make precise edits. Supports path+edits, multi, and patch.",
		parameters: schema,
		async execute(toolCallId, params: any, signal, onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const { path, edits, multi, patch } = params ?? {};

			const hasPatch = patch !== undefined;
			const hasEdits = Array.isArray(edits);
			const hasMulti = Array.isArray(multi);
			if ((hasPatch ? 1 : 0) + (hasEdits ? 1 : 0) + (hasMulti ? 1 : 0) !== 1) {
				throw new Error("Provide exactly one mode: edits, multi, or patch.");
			}

			if (hasPatch) {
				const ops = parsePatch(String(patch));
				await applyPatchOps(ops, ctx.cwd, true); // preflight
				const applied = await applyPatchOps(ops, ctx.cwd, false);
				return {
					content: [{ type: "text" as const, text: `Applied patch with ${ops.length} operation(s).\n${applied.summary.map((s, i) => `${i + 1}. ${s}`).join("\n")}` }],
					details: { diff: applied.diffs.join("\n\n") },
				};
			}

			const builtin = createEditTool(ctx.cwd);

			if (hasEdits) {
				if (!path) throw new Error("`path` is required when using edits[].");
				return builtin.execute(toolCallId, { path, edits }, signal, onUpdate);
			}

			// multi mode
			const inheritedPath = typeof path === "string" ? path : undefined;
			const summary: string[] = [];
			const diffs: string[] = [];
			for (let i = 0; i < multi.length; i++) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const m = multi[i] as MultiItem;
				const p = m.path ?? inheritedPath;
				if (!p) throw new Error(`multi[${i}] is missing path (and no top-level path provided).`);
				const res: any = await builtin.execute(toolCallId, { path: p, edits: [{ oldText: m.oldText, newText: m.newText }] }, signal, onUpdate);
				summary.push(`${i + 1}. Edited ${p}`);
				if (res?.details?.diff) diffs.push(`File: ${p}\n${res.details.diff}`);
			}
			return {
				content: [{ type: "text" as const, text: `Applied ${multi.length} multi edit(s).\n${summary.join("\n")}` }],
				details: { diff: diffs.join("\n\n") },
			};
		},
	});
}
