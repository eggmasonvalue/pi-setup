import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * The built-in bash tool with a required `description`: the model's note to its future self, kept by Shake as the
 * call's permanent record. Results carry `details.outcome` ("exit N", "no output", "timed out", "aborted") when the
 * call was not a plain success with output.
 */
export default function bashDescription(pi: ExtensionAPI) {
	// Bash defines no prepareArguments; dropping the slot lets the spread accept the extended schema.
	const { prepareArguments: _, ...bash } = createBashToolDefinition(process.cwd());
	const createBash = () => {
		const { shellCommandPrefix, shellPath } = pi.getSettings();
		return createBashToolDefinition(process.cwd(), { commandPrefix: shellCommandPrefix, shellPath });
	};

	pi.registerTool({
		...bash,
		parameters: Type.Object({
			description: Type.String({
				description:
					'What this command does, in 5-10 words (e.g. "Find callers of parseConfig in src"). Long conversations may later be abridged, keeping only this description in place of the command and its output, so make it specific enough to tell later what you did.',
			}),
			...bash.parameters.properties,
		}),

		async execute(toolCallId, { description: _description, ...params }, signal, onUpdate, ctx) {
			try {
				const result = await createBash().execute(toolCallId, params, signal, onUpdate, ctx);
				const { exit_code, output } = result.structuredContent as { exit_code: number; output: string };
				const outcome = exit_code ? `exit ${exit_code}` : output.trim() ? undefined : "no output";
				return { ...result, details: { ...result.details, outcome } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const outcome = signal?.aborted ? "aborted" : message.includes("Command timed out") ? "timed out" : undefined;
				if (!outcome) throw error;
				return { content: [{ type: "text", text: message }], details: { outcome }, isError: true };
			}
		},

		renderCall(args, theme, context) {
			// The built-in call renderer also starts the row's elapsed-time timer.
			const call = bash.renderCall!(args, theme, { ...context, lastComponent: undefined });
			if (!args.description) return call;
			const view = new Container();
			view.addChild(new Text(theme.fg("muted", `# ${args.description}`), 0, 0));
			view.addChild(call);
			return view;
		},
	});
}
