import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Bell-only notifier for terminals that surface BEL (\x07),
 * such as VS Code integrated terminal's bell indicator.
 */
const ringBell = (): void => {
	process.stdout.write("\x07");
};

export default function notifyExtension(pi: ExtensionAPI) {
	pi.on("agent_end", async () => {
		ringBell();
	});
}
