import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Bell-only notifier for terminals that surface BEL (\x07),
 * such as VS Code integrated terminal's bell indicator.
 *
 * Exported so other extensions (e.g. cache-ttl-timer.ts) can reuse the same
 * "actually works in VS Code's terminal" notification primitive instead of
 * ctx.ui.notify(), which does not reliably surface there.
 */
export const ringBell = (): void => {
	process.stdout.write("\x07");
};

export default function notifyExtension(pi: ExtensionAPI) {
	pi.on("agent_end", async () => {
		ringBell();
	});
}
