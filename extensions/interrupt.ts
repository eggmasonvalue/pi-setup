import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function interruptExtension(pi: ExtensionAPI) {
	pi.registerCommand("interrupt", {
		description: "Abort current work and immediately send a steering message in one command",
		handler: async (args, ctx) => {
			const message = (args ?? "").trim();
			if (!message) {
				ctx.ui.notify("Usage: /interrupt <message>", "warning");
				return;
			}

			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
				return;
			}

			ctx.ui.notify("Interrupting current run…", "info");
			ctx.abort();

			try {
				await ctx.waitForIdle();
			} catch {
				// If wait fails due to race/abort propagation, fall back below.
			}

			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
			} else {
				pi.sendUserMessage(message, { deliverAs: "steer" });
			}
		},
	});
}
