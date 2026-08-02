import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/**
 * Vibe Spinner — swaps pi's "Working..." message for something that
 * actually reflects a personality: paddock/pitlane chaos, hardwood
 * highlights, pitch/court/crease lore, and value-investing brainrot
 * (Bill Miller cosplay, Mauboussin base-rate sermons, Mr. Market's mood
 * swings).
 *
 * Four pools. Edit the arrays below directly to add or change lines —
 * that's the primary way to configure content.
 *
 * Mode configuration lives in pi's own global settings.json
 * (~/.pi/agent/settings.json, or PI_CODING_AGENT_DIR/settings.json) under
 * a "vibeSpinner" key, e.g.:
 *
 *   { "vibeSpinner": { "mode": "motorsport" } }
 *
 *   - `/vibe-spinner [motorsport|basketball|other-sports|stocks|mixed]`
 *     switches the pool live AND persists it to settings.json (only the
 *     "vibeSpinner.mode" field is touched — every other setting in the
 *     file is left untouched). Run with no args to see the current mode
 *     and pool sizes.
 *   - Falls back to "mixed" (every pool combined) if settings.json has
 *     no vibeSpinner.mode.
 */

type Mode = "motorsport" | "basketball" | "other-sports" | "stocks" | "mixed";

// ---------------------------------------------------------------------------
// 🏎️🏍️ Motorsport pool — F1 + MotoGP
// ---------------------------------------------------------------------------
const MOTORSPORT_MESSAGES: string[] = [
	"Overtaking into Eau Rouge, flat out, no lift...",
	"Marc Márquez elbow-down through this stack trace...",
	"Braking as late as Max into Turn 1...",
	"Late apex, early throttle, exiting the loop...",
	"Slipping the tyres just enough on corner exit...",
	"Alonso-brain plotting a two-stop strategy for this build...",
	"Tifosi screaming, box still hasn't called the pit stop...",
	"Fastest lap on the last tour, tyres are toast, code still runs...",
	"Rossi-style late lunge into the last corner of this loop...",
	"Undercut strategy on this compile time...",
	"Formation lap before we actually run the tests...",
	"Box box box, pit this function immediately...",
	"DRS open, slipstreaming past the bottleneck...",
	"Safety car deployed for this debris in the console...",
	"Red flag, session stopped, someone left a console.log in...",
	"Quali lap, one shot, sending it through the chicane...",
	"Pole position secured, now to survive lights out...",
	"Highside coming if I push this refactor any harder...",
	"Grid penalty for an unused import, five places back...",
	"Parc fermé rules apply, no more changes before the merge...",
	"Checkered flag waving, P1 in the build queue...",
	"Wet tyres on, this codebase is basically Spa in the rain...",
	"Team radio crackling: 'push now, push now'...",
	"Sighting lap done, tyres and brakes up to temp...",
	"Slick tyres on a drying track, sending this deploy...",
	"Gearbox penalty looming over this function signature...",
	"Wheelie out of the final corner, MotoGP-style victory lap...",
	"Overcut working better than the undercut this time...",
	"Marquez-style save at full lean, somehow still upright...",
	"Verstappen sending it around the outside, no room, no fear...",
	"Bagnaia stalking the leader, waiting for the last lap lunge...",
	"Norris on the radio, not happy, still delivering the lap...",
	"Leclerc threading Monaco's barriers with a millimetre to spare...",
	"Bumping the rev limiter on this loop, redline and beyond...",
	"Parc fermé silence while the stewards review this function...",
];

// ---------------------------------------------------------------------------
// 🏀 Basketball pool
// ---------------------------------------------------------------------------
const BASKETBALL_MESSAGES: string[] = [
	"Pulling up from the logo like Steph, no conscience...",
	"Setting a pick-and-roll with the compiler...",
	"Fast break, no rebound needed, straight to bucket...",
	"Buzzer beater, bank shot, off the rim of this stack frame...",
	"Step-back three over a hard-coded contest...",
	"Jokic no-look dime through three defenders and a null pointer...",
	"Giannis euro-stepping past this exception...",
	"LeBron chase-down block on this runaway process...",
	"Luka stepping back into a fadeaway over the shot clock...",
	"Full-court press on this bug before it crosses half-court...",
	"And-one, function returns despite the foul...",
	"Alley-oop from the compiler straight to the dunk...",
	"Triple-double energy: fixed, tested, and shipped...",
	"Boxing out the linter for this rebound...",
	"Ankle-breaker crossover on this edge case...",
	"Pump fake on the reviewer, still gets the layup...",
	"Clutch shot with the shot clock at zero, nothing but net...",
	"Defensive stance locked in, no easy buckets for this bug...",
	"Overtime basketball, nobody wants to concede this bug...",
	"Game 7 intensity for what is, checks notes, a typo fix...",
	"Heat check, three in a row, don't stop me now...",
	"Bringing the ball up slow, probing this codebase for weaknesses...",
	"Backdoor cut right past the exception handler...",
	"Posting up in the paint of this monolith...",
	"Full send transition three, tempo dictated, no mercy...",
	"Switching on every screen this refactor throws at me...",
	"Kicking it out to the corner for the trailing test coverage...",
	"Two-for-one at the end of the quarter, sneaking in one more fix...",
	"Iso ball, one-on-one against this stack trace...",
	"Coach drawing up a play out of a timeout for this deploy...",
	"Free throws with the game on the line, nothing but string returns...",
	"Fighting through a screen to stay in front of this regression...",
	"Full 94 feet of pressure on this null check...",
	"Bank shot off glass, function still resolves...",
	"Sixth man energy coming off the bench for this hotfix...",
];

// ---------------------------------------------------------------------------
// ⚽🎾🏏 Everything else — soccer, tennis, cricket
// ---------------------------------------------------------------------------
const OTHER_SPORTS_MESSAGES: string[] = [
	"Messi-dribbling past your merge conflicts...",
	"Federer backhand down the line, effortless, unlike this bug...",
	"Kohli cover drive through the gully of your codebase...",
	"Box-to-box through the middle of the function...",
	"Full toss, somehow still a wicket...",
	"Serving up an ace on the first fault of the day...",
	"VAR is checking this refactor for offside...",
	"Nutmegged the linter, no whistle...",
	"DRS review pending on this null check...",
	"Backhand smash, cross-court, into prod...",
	"Long ball over the top of the call stack...",
	"Yorker on middle stump, off you go bug...",
	"Advantage, deuce, advantage — still resolving this promise...",
	"Playing out from the back through three lines of defenders...",
	"Cover point diving full stretch for this edge case...",
	"Championship point, hawk-eye reviewing this diff...",
	"Set piece routine, third man runs into the free variable...",
	"Reverse swing on an old ball, and an older codebase...",
	"Clean tackle, no card, function returns unscathed...",
	"Tiki-taka through this dependency graph, one-touch passes only...",
	"Extra time, penalties looming for this stubborn bug...",
	"Googly bowled, batter had no idea, neither did this parser...",
	"Baseline rally going twenty shots deep on this refactor...",
	"Death overs mentality, defending a narrow lead in this test suite...",
	"Match point saved, deuce again, this function just won't die...",
	"Powerplay overs, fielders up, attacking this backlog early...",
	"Offside trap sprung perfectly on this race condition...",
	"Straight drive through mid-off, textbook fix...",
	"Tiebreak at 6-6, nerves of steel required for this deploy...",
	"Clean sheet for the defense, no bugs got through today...",
];

// ---------------------------------------------------------------------------
// 📈💰 Stocks pool — value investing, but make it unhinged
// ---------------------------------------------------------------------------
const STOCKS_MESSAGES: string[] = [
	"Buying the dip nobody else has the stomach for, Bill Miller style...",
	"Mr. Market is manic today, offering silly prices on this function...",
	"Discounting future cash flows at a rate only I believe in...",
	"Checking the base rate before I get overconfident, per Mauboussin...",
	"Buying quality tech at a 'value' multiple, don't @ me...",
	"This isn't cheap, it's a coiled spring with a wide moat...",
	"Running the expectations investing math on this refactor...",
	"Circle of competence just got a little bigger, allegedly...",
	"Sizing this position like conviction actually means something...",
	"Ignoring the P/E, underwriting the optionality instead...",
	"Fading the crowd consensus on this one merge conflict...",
	"Ben Graham would clutch his pearls, Bill Miller would double down...",
	"Front-running my own thesis before the market catches up...",
	"Skill vs. luck: attributing 90% of this bug fix to luck...",
	"Buying wonderful businesses at a fair price, or so I keep telling myself...",
	"Averaging down on this loop like it's Amazon in 2001...",
	"Reading the incentives, not just the numbers, on this codebase...",
	"Contrarian at the top, contrarian at the bottom, contrarian regardless...",
	"Not timing the market, just timing this build...",
	"The moat's getting deeper while everyone stares at the quarterly print...",
	"Position sizing via Kelly criterion, vibes-adjusted...",
	"Marking to model, not to market, on this pull request...",
	"Reflexivity kicking in — the bug believes in itself now...",
	"Long duration bet, short attention span reviewers...",
	"Underwriting optionality nobody's pricing in yet...",
	"Selling the news, buying the rumor, refactoring the function...",
	"Second-level thinking this stack trace, not first-level panic...",
	"Free cash flow yield on this function is looking undervalued...",
	"Buying when there's blood in the terminal...",
	"Compounding small edges, one commit at a time...",
	"Occam's razor says it's a typo, my thesis says it's structural...",
	"Value trap or value gem — running more diligence on this diff...",
	"The variant perception here is that this actually compiles...",
	"Letting my winners run, my stack traces resolve...",
	"Margin of safety: wide. Confidence: also wide. Correlation: unclear...",
];

// ---------------------------------------------------------------------------
// settings.json integration (global scope only)
// ---------------------------------------------------------------------------
function getGlobalSettingsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
	return path.join(agentDir, "settings.json");
}

function readVibeSpinnerMode(): Mode | undefined {
	try {
		const raw = fs.readFileSync(getGlobalSettingsPath(), "utf-8");
		const settings = JSON.parse(raw) as { vibeSpinner?: { mode?: string } };
		return isValidMode(settings.vibeSpinner?.mode) ? settings.vibeSpinner.mode : undefined;
	} catch {
		return undefined;
	}
}

/** Persist only `vibeSpinner.mode`, leaving every other settings.json field untouched. */
function writeVibeSpinnerMode(mode: Mode): void {
	const settingsPath = getGlobalSettingsPath();
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	} catch {
		// Missing or unparsable file — start fresh rather than clobbering silently.
		settings = {};
	}
	const vibeSpinner = (settings.vibeSpinner as Record<string, unknown> | undefined) ?? {};
	settings.vibeSpinner = { ...vibeSpinner, mode };
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function isValidMode(value: string | undefined): value is Mode {
	return (
		value === "motorsport" ||
		value === "basketball" ||
		value === "other-sports" ||
		value === "stocks" ||
		value === "mixed"
	);
}

function pickRandom(pool: string[]): string {
	return pool[Math.floor(Math.random() * pool.length)];
}

export default function vibeSpinnerExtension(pi: ExtensionAPI) {
	let mode: Mode = readVibeSpinnerMode() ?? "mixed";

	const currentPool = (): string[] => {
		switch (mode) {
			case "motorsport":
				return MOTORSPORT_MESSAGES;
			case "basketball":
				return BASKETBALL_MESSAGES;
			case "other-sports":
				return OTHER_SPORTS_MESSAGES;
			case "stocks":
				return STOCKS_MESSAGES;
			default:
				return [...MOTORSPORT_MESSAGES, ...BASKETBALL_MESSAGES, ...OTHER_SPORTS_MESSAGES, ...STOCKS_MESSAGES];
		}
	};

	pi.on("turn_start", async (_event, ctx) => {
		ctx.ui.setWorkingMessage(pickRandom(currentPool()));
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setWorkingMessage(); // restore default for the next idle beat
	});

	pi.registerCommand("vibe-spinner", {
		description:
			"Switch the working-spinner vibe: motorsport, basketball, other-sports, stocks, or mixed (persists to settings.json)",
		handler: async (args, ctx) => {
			const requested = args?.trim().toLowerCase();
			if (!requested) {
				ctx.ui.notify(
					`Vibe spinner mode: ${mode} (motorsport: ${MOTORSPORT_MESSAGES.length}, basketball: ${BASKETBALL_MESSAGES.length}, other-sports: ${OTHER_SPORTS_MESSAGES.length}, stocks: ${STOCKS_MESSAGES.length} lines)`,
					"info",
				);
				return;
			}
			if (!isValidMode(requested)) {
				ctx.ui.notify("Usage: /vibe-spinner [motorsport|basketball|other-sports|stocks|mixed]", "error");
				return;
			}
			mode = requested;
			try {
				writeVibeSpinnerMode(mode);
				ctx.ui.notify(`Vibe spinner mode set to: ${mode} (saved to settings.json)`, "info");
			} catch (err) {
				ctx.ui.notify(
					`Vibe spinner mode set to: ${mode} for this session, but saving to settings.json failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
					"warning",
				);
			}
		},
	});
}
