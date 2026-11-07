import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	KeybindingsManager,
	PlanReviewOption,
	PlanReviewRequestedEvent,
	PlanReviewResolvedEvent,
	PlanReviewTier,
	SessionStartEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { __closeExtensionParseCacheForTests } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import type { Theme, TUI } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { parseThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { getAgentDir, getPluginsDir, logger, removeSyncWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { CodebaseReader } from "../src/code-reader";
import { CouncilSession, type ModelStreamFn } from "../src/council-session";
import planCouncilExtension from "../src/index";
import type { ReviewerMember } from "../src/models";
import { type CouncilOverlayOutcome, PlanCouncilOverlay } from "../src/overlay";
import type { collectPlanReferencedFiles, PlanFileExcerpt } from "../src/plan-files";

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function flushMicrotasks(count = 20): Promise<void> {
	for (let i = 0; i < count; i++) {
		await Promise.resolve();
	}
}

/** point home, XDG dirs, and the agent dir at a temp directory so the developer's ~/.omp plugin state stays out of tests */
function isolateOmpHome(prefix: string): { home: string; restore: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const originalAgentDir = getAgentDir();
	const originalXdg = new Map<string, string | undefined>();
	for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
		originalXdg.set(key, process.env[key]);
		delete process.env[key];
	}
	const homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));

	const pluginsDir = getPluginsDir();
	if (!pluginsDir.startsWith(home + path.sep)) {
		throw new Error(`plugin isolation failed: ${pluginsDir}`);
	}

	return {
		home,
		restore: () => {
			homedirSpy.mockRestore();
			for (const [key, value] of originalXdg) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			setAgentDir(originalAgentDir);
			removeSyncWithRetries(home);
		},
	};
}

function makeFakeModel(provider: string, id: string): Model {
	return {
		id,
		provider,
		name: `${id} model`,
		description: "fake model",
		contextWindow: 128000,
		maxTokens: 4096,
		thinking: false,
		identity: { family: provider, class: provider, archetype: provider, vendor: provider },
	} as unknown as Model;
}

function makeFakeReviewer(provider: string, id: string): ReviewerMember {
	const model = makeFakeModel(provider, id);
	return {
		key: `${provider}/${id}`,
		label: `${id} (${provider})`,
		family: provider,
		model,
	};
}

describe("PlanCouncilOverlay UI component", () => {
	const claude = makeFakeReviewer("anthropic", "claude-3-7-sonnet");
	const gpt = makeFakeReviewer("openai", "gpt-4o");

	const defaultReviewOptions: PlanReviewOption[] = [
		{ id: "execute", label: "Execute plan", disabled: false },
		{ id: "refine", label: "Refine plan", disabled: false },
		{ id: "save", label: "Save draft", disabled: false },
	];

	function createFakeTui(): { tui: TUI; renders: number } {
		let renders = 0;
		const tui = {
			terminal: { rows: 24, cols: 80 },
			requestRender: () => {
				renders++;
			},
		} as unknown as TUI;
		return {
			tui,
			get renders() {
				return renders;
			},
		};
	}

	function plain(rows: readonly string[]): string {
		return Bun.stripANSI(rows.join("\n"));
	}

	/** body rows between the header divider and the 3-row footer, ANSI stripped */
	function bodyRows(rows: readonly string[]): string[] {
		const stripped = rows.map(r => Bun.stripANSI(r));
		const start = stripped.findIndex(r => /^─+$/.test(r)) + 1;
		return stripped.slice(start, stripped.length - 3);
	}

	const synthesisText = "## Required Plan Revisions\n1. Gate the budget";

	/** reviewers approve at once; the synthesizer answers only after `releaseSynthesis` */
	function gatedSynthesisStream(): { streamFn: ModelStreamFn; synthesisStarted: Promise<void>; releaseSynthesis: () => void } {
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const streamFn: ModelStreamFn = (_model, context) => {
			// reviewer turns offer report_position; the synthesizer request carries no tools
			const reviewer = Boolean(context.tools?.length);
			if (!reviewer) started.resolve();
			return {
				async *[Symbol.asyncIterator]() {},
				result: async () => {
					if (!reviewer) await gate.promise;
					return {
						role: "assistant",
						content: reviewer
							? [
									{ type: "text", text: "Approve" },
									{ type: "toolCall", id: "call-0", name: "report_position", arguments: { verdict: "APPROVE", revisions: [], positions: [] } },
								]
							: [{ type: "text", text: synthesisText }],
						stopReason: reviewer ? "toolUse" : "stop",
					} as unknown as AssistantMessage;
				},
			};
		};
		return { streamFn, synthesisStarted: started.promise, releaseSynthesis: () => gate.resolve() };
	}

	const approvalOptions: PlanReviewOption[] = [
		{ id: "execute", label: "Execute plan", disabled: false },
		{ id: "compact", label: "Compact & execute", disabled: false },
		{ id: "keep", label: "Keep context", disabled: true },
		{ id: "refine", label: "Refine plan", disabled: false },
	];
	const reviewTiers: PlanReviewTier[] = [
		{ role: "smol", provider: "openai", model: "gpt-4o-mini" },
		{ role: "default", provider: "anthropic", model: "claude-3-7-sonnet", thinkingLevel: parseThinkingLevel("high") },
	];

	it("renders title, tabs, empty state guide, and hint bar", () => {
		const { tui } = createFakeTui();
		const session = new CouncilSession({
			planTitle: "Add Logging",
			planFilePath: "src/logger.md",
			planContent: "# Plan\nWith \t tab in text",
			availableReviewers: [claude, gpt],
			initialReviewers: [claude, gpt],
		});

		let outcome: CouncilOverlayOutcome | undefined;
		const overlay = new PlanCouncilOverlay(
			tui,
			session,
			{
				reviewOptions: defaultReviewOptions,
				synthesizerModel: claude.model,
			},
			res => {
				outcome = res;
			},
		);

		const rendered = overlay.render(80);
		expect(rendered.length).toBeGreaterThanOrEqual(10);

		const fullText = rendered.join("\n");
		expect(fullText).toContain("Plan Council · Add Logging");
		expect(fullText).toContain("Council");
		expect(fullText).toContain("claude-3-7-sonnet");
		expect(fullText).toContain("gpt-4o");
		expect(fullText).toContain("Synthesis");
		expect(fullText).toContain("Plan");
		expect(fullText).toContain("Models (2)");
		expect(fullText).toContain("No council critiques yet");
		expect(fullText).not.toContain("\t"); // Sanitized tabs
		expect(outcome).toBeUndefined();
	});

	it("transitions to compose mode on 'i', submits question on Enter, and returns to browse mode", async () => {
		const { tui } = createFakeTui();
		let askedQuestion = "";
		const streamFn: ModelStreamFn = (_model, context) => {
			const last = context.messages[context.messages.length - 1];
			askedQuestion = String(last.content);
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "text_delta", delta: "Answer" } as unknown as AssistantMessageEvent;
				},
				result: async () =>
					({
						role: "assistant",
						content: [{ type: "text", text: "Answer" }],
						stopReason: "stop",
					}) as unknown as AssistantMessage,
			};
		};

		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude],
			initialReviewers: [claude],
			streamFn,
		});

		const overlay = new PlanCouncilOverlay(
			tui,
			session,
			{
				reviewOptions: defaultReviewOptions,
				synthesizerModel: claude.model,
			},
			() => {},
		);

		// Press 'i' to enter compose mode
		overlay.handleInput("i");

		// Type characters
		for (const ch of "What about errors?") {
			overlay.handleInput(ch);
		}

		// Press Enter to submit
		overlay.handleInput("\r");

		// Allow async askCouncil promise to resolve
		await flushMicrotasks();

		expect(askedQuestion).toContain("What about errors?");

		// Overlay is back in browse mode and renders response
		const rendered = overlay.render(80).join("\n");
		expect(rendered).toContain("What about errors?");
	});

	it("keeps input and shows error banner on invalid @unknown mention", async () => {
		const { tui } = createFakeTui();
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude],
			initialReviewers: [claude],
		});

		const overlay = new PlanCouncilOverlay(
			tui,
			session,
			{
				reviewOptions: defaultReviewOptions,
				synthesizerModel: claude.model,
			},
			() => {},
		);

		overlay.handleInput("i");
		for (const ch of "@unknownmodel check this") {
			overlay.handleInput(ch);
		}
		overlay.handleInput("\r");

		await flushMicrotasks();

		const rendered = overlay.render(80).join("\n");
		expect(rendered).toContain('Unknown reviewer model "@unknownmodel"');
	});

	it("switches to models tab, toggles selection with Space, and updates session reviewers", () => {
		const { tui } = createFakeTui();
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude, gpt],
			initialReviewers: [claude, gpt],
		});

		const overlay = new PlanCouncilOverlay(
			tui,
			session,
			{
				reviewOptions: defaultReviewOptions,
				synthesizerModel: claude.model,
			},
			() => {},
		);

		// Switch to models tab via 'm'
		overlay.handleInput("m");
		expect(session.activeReviewers).toHaveLength(2);

		// Press space to toggle first model (claude) off
		overlay.handleInput(" ");
		expect(session.activeReviewers.map(r => r.key)).toEqual([gpt.key]);

		// Press space again to toggle claude back on
		overlay.handleInput(" ");
		expect(session.activeReviewers.map(r => r.key)).toEqual([claude.key, gpt.key]);
	});

	it("resolves refine action on 'f' when synthesis completes", async () => {
		const { tui } = createFakeTui();
		const streamFn: ModelStreamFn = () => ({
			async *[Symbol.asyncIterator]() {
				yield {
					type: "text_delta",
					delta: "## Required Plan Revisions\n1. Add unit test",
				} as unknown as AssistantMessageEvent;
			},
			result: async () =>
				({
					role: "assistant",
					content: [{ type: "text", text: "## Required Plan Revisions\n1. Add unit test" }],
					stopReason: "stop",
				}) as unknown as AssistantMessage,
		});

		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude],
			initialReviewers: [claude],
			streamFn,
		});

		await session.startInitialCritiques();

		let resolvedOutcome: CouncilOverlayOutcome | undefined;
		const overlay = new PlanCouncilOverlay(
			tui,
			session,
			{
				reviewOptions: defaultReviewOptions,
				synthesizerModel: claude.model,
			},
			res => {
				resolvedOutcome = res;
			},
		);

		// Press 'f'
		overlay.handleInput("f");

		await flushMicrotasks();

		expect(resolvedOutcome).toBeDefined();
		expect(resolvedOutcome?.action).toBe("refine");
		if (resolvedOutcome && resolvedOutcome.action === "refine") {
			expect(resolvedOutcome.feedback).toContain("## Required Plan Revisions");
		}
	});

	// all synthesis actions must forward the selected effort through the real session
	it.each(["s", "f", "auto"])("retains synthesizer reasoning for %s", async action => {
		const { tui } = createFakeTui();
		const calls: Array<Parameters<ModelStreamFn>[2]> = [];
		// capture request options while completing every model stream locally
		const streamFn: ModelStreamFn = (_model, context, options) => {
			calls.push(options);
			// reviewer turns (which offer report_position) report, so no forced report request is made
			const reviewer = Boolean(context.tools?.length);
			return {
				async *[Symbol.asyncIterator]() {},
				result: async () => ({
					role: "assistant",
					content: reviewer
						? [
								{ type: "text", text: "Approve" },
								{ type: "toolCall", id: "call-0", name: "report_position", arguments: { verdict: "APPROVE", revisions: [], positions: [] } },
							]
						: [{ type: "text", text: "Synthesized feedback" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: claude.model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: reviewer ? "toolUse" : "stop",
					timestamp: Date.now(),
				}),
			};
		};
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude],
			initialReviewers: [claude],
			streamFn,
		});
		const finished = Promise.withResolvers<void>();
		// resolve on synthesis completion so the assertion waits for the actual request
		const unsubscribe = session.subscribe(() => {
			if (session.latestSynthesis?.status === "done") finished.resolve();
		});
		const overlay = new PlanCouncilOverlay(tui, session, {
			reviewOptions: defaultReviewOptions,
			synthesizerModel: claude.model,
			synthesizerThinkingLevel: parseThinkingLevel("high"),
			autoProceed: action === "auto",
		}, () => {});

		try {
			if (action !== "auto") {
				await session.startInitialCritiques();
				overlay.handleInput(action);
			}
			await finished.promise;
			expect(calls).toHaveLength(2);
			expect(calls[0]?.reasoning).toBeUndefined();
			expect(calls[1]?.reasoning?.toString()).toBe("high");
		} finally {
			unsubscribe();
			overlay.dispose();
			session.dispose();
		}
	});

	it("runs full pipeline automatically when autoProceed is enabled", async () => {
		const { tui } = createFakeTui();
		const streamFn: ModelStreamFn = (_model, context) => {
			const sys = context.systemPrompt?.[0] ?? "";
			if (sys.includes("Synthesizer")) {
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "text_delta", delta: "Auto-synthesized feedback" } as unknown as AssistantMessageEvent;
					},
					result: async () =>
						({
							role: "assistant",
							content: [{ type: "text", text: "Auto-synthesized feedback" }],
							stopReason: "stop",
						}) as unknown as AssistantMessage,
				};
			}
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "text_delta", delta: "Critique" } as unknown as AssistantMessageEvent;
				},
				result: async () =>
					({
						role: "assistant",
						content: [{ type: "text", text: "Critique" }],
						stopReason: "stop",
					}) as unknown as AssistantMessage,
			};
		};

		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude],
			initialReviewers: [claude],
			streamFn,
		});

		let autoResolvedOutcome: CouncilOverlayOutcome | undefined;
		new PlanCouncilOverlay(
			tui,
			session,
			{
				reviewOptions: defaultReviewOptions,
				synthesizerModel: claude.model,
				autoProceed: true,
			},
			res => {
				autoResolvedOutcome = res;
			},
		);

		await flushMicrotasks();

		expect(autoResolvedOutcome).toBeDefined();
		expect(autoResolvedOutcome?.action).toBe("refine");
		if (autoResolvedOutcome && autoResolvedOutcome.action === "refine") {
			expect(autoResolvedOutcome.feedback).toContain("Auto-synthesized feedback");
		}
	});

	it("opens an approval picker on 'a', cancels on Esc, and confirms the chosen approval and execution tier", () => {
		const { tui } = createFakeTui();
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude],
			initialReviewers: [claude],
		});
		const outcomes: CouncilOverlayOutcome[] = [];
		const overlay = new PlanCouncilOverlay(
			tui,
			session,
			{ reviewOptions: approvalOptions, reviewTiers, synthesizerModel: claude.model },
			res => outcomes.push(res),
		);
		const footer = () => plain(overlay.render(100).slice(-3));

		overlay.handleInput("a");
		expect(outcomes).toEqual([]);
		let bar = footer();
		expect(bar).toContain("Approve:  Execute plan   Compact & execute");
		expect(bar).not.toContain("Keep context");
		// the host's default tier is preselected
		expect(bar).toContain("Tier: ◂ default (claude-3-7-sonnet:high) ▸");

		overlay.handleInput("\x1b");
		expect(outcomes).toEqual([]);
		expect(footer()).not.toContain("Approve:");

		overlay.handleInput("a");
		overlay.handleInput("\x1b[C");
		overlay.handleInput("\t");
		bar = footer();
		expect(bar).toContain("Tier: ◂ smol (gpt-4o-mini) ▸");
		overlay.handleInput("\r");
		expect(outcomes).toEqual([{ action: "approve", choice: "compact", role: "smol" }]);
	});

	it("keeps an auto run's synthesis from closing the overlay once the approval picker is open", async () => {
		const { tui } = createFakeTui();
		const { streamFn, synthesisStarted, releaseSynthesis } = gatedSynthesisStream();
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude],
			initialReviewers: [claude],
			streamFn,
		});
		const outcomes: CouncilOverlayOutcome[] = [];
		const overlay = new PlanCouncilOverlay(
			tui,
			session,
			{ reviewOptions: defaultReviewOptions, synthesizerModel: claude.model, autoProceed: true },
			res => outcomes.push(res),
		);
		const footer = () => plain(overlay.render(100).slice(-3));

		await synthesisStarted;
		overlay.handleInput("a");
		releaseSynthesis();
		await delay(5);
		expect(session.latestSynthesis?.status).toBe("done");
		expect(outcomes).toEqual([]);
		expect(footer()).toContain("Approve:");

		overlay.handleInput("\x1b");
		expect(outcomes).toEqual([]);
		const browse = footer();
		expect(browse).not.toContain("Approve:");
		expect(browse).toContain("Synthesis ready — press f to refine plan, or a to approve.");

		overlay.handleInput("a");
		overlay.handleInput("\r");
		expect(outcomes).toEqual([{ action: "approve", choice: "execute" }]);
	});

	it.each(["auto", "f"])("reports only the approval when Enter lands as the %s synthesis settles", async trigger => {
		const { tui } = createFakeTui();
		const { streamFn, synthesisStarted, releaseSynthesis } = gatedSynthesisStream();
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude],
			initialReviewers: [claude],
			streamFn,
		});
		if (trigger === "f") await session.startInitialCritiques();
		const outcomes: CouncilOverlayOutcome[] = [];
		const overlay = new PlanCouncilOverlay(
			tui,
			session,
			{ reviewOptions: defaultReviewOptions, synthesizerModel: claude.model, autoProceed: trigger === "auto" },
			res => outcomes.push(res),
		);
		if (trigger === "f") overlay.handleInput("f");

		await synthesisStarted;
		overlay.handleInput("a");
		releaseSynthesis();
		overlay.handleInput("\r");
		await delay(5);
		expect(outcomes).toEqual([{ action: "approve", choice: "execute" }]);
	});

	it.each([
		["while the picker is open", false],
		["after the picker is cancelled", true],
	] as const)("leaves an f synthesis superseded by the picker to the operator when it settles %s", async (_when, cancelFirst) => {
		const { tui } = createFakeTui();
		const { streamFn, synthesisStarted, releaseSynthesis } = gatedSynthesisStream();
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude],
			initialReviewers: [claude],
			streamFn,
		});
		await session.startInitialCritiques();
		const outcomes: CouncilOverlayOutcome[] = [];
		const overlay = new PlanCouncilOverlay(
			tui,
			session,
			{ reviewOptions: defaultReviewOptions, synthesizerModel: claude.model },
			res => outcomes.push(res),
		);
		const footer = () => plain(overlay.render(100).slice(-3));

		overlay.handleInput("f");
		await synthesisStarted;
		overlay.handleInput("a");
		if (cancelFirst) overlay.handleInput("\x1b");
		releaseSynthesis();
		await delay(5);
		expect(outcomes).toEqual([]);
		if (!cancelFirst) {
			expect(footer()).toContain("Approve:");
			overlay.handleInput("\x1b");
			expect(outcomes).toEqual([]);
		}
		expect(footer()).toContain("Synthesis ready — press f to refine plan, or a to approve.");

		overlay.handleInput("f");
		expect(outcomes).toEqual([{ action: "refine", feedback: synthesisText }]);
	});

	it("hides the Reader tab when no reader is configured", () => {
		const { tui } = createFakeTui();
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude],
			initialReviewers: [claude],
		});
		const overlay = new PlanCouncilOverlay(tui, session, { reviewOptions: defaultReviewOptions, synthesizerModel: claude.model }, () => {});
		expect(overlay.render(120).join("\n")).not.toContain("Reader");
	});

	it("lists pre-attached files on the Reader tab without a reader and sends Reader-tab input to the council", async () => {
		const { tui } = createFakeTui();
		const asked: string[] = [];
		const streamFn: ModelStreamFn = (_model, context) => {
			const last = context.messages[context.messages.length - 1];
			asked.push(String(last.content));
			return {
				async *[Symbol.asyncIterator]() {},
				result: async () =>
					({ role: "assistant", content: [{ type: "text", text: "Answer" }], stopReason: "stop" }) as unknown as AssistantMessage,
			};
		};
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Edit src/a.ts and src/b.ts",
			availableReviewers: [claude],
			initialReviewers: [claude],
			streamFn,
			referencedFiles: [
				{ path: "src/a.ts", rangeLabel: "lines 1–12", excerptBlock: "```ts\n1: a\n```" },
				{ path: "src/b.ts", rangeLabel: "lines 30–62 of 320", excerptBlock: "```ts\n30: b\n```" },
			],
		});
		const overlay = new PlanCouncilOverlay(tui, session, { reviewOptions: defaultReviewOptions, synthesizerModel: claude.model }, () => {});

		// Council → claude → Reader
		overlay.handleInput("]");
		overlay.handleInput("]");
		let rendered = overlay.render(120).join("\n");
		expect(rendered).toContain("Pre-attached to Round 1 (2 files):");
		expect(rendered).toContain("• src/a.ts");
		expect(rendered).toContain("(lines 30–62 of 320)");
		expect(rendered).toContain("On-demand codebase reader is disabled (enableCodeReader: false).");
		expect(rendered).not.toContain("@reader <question>");
		expect(rendered).toContain("Ask council >");

		// a plain question on the Reader tab goes to the council instead of the missing reader
		overlay.handleInput("i");
		for (const ch of "Which tests?") overlay.handleInput(ch);
		overlay.handleInput("\r");
		await flushMicrotasks();
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("Which tests?");
		expect(session.entries.some(e => e.kind === "user" && e.text === "Which tests?")).toBe(true);

		overlay.handleInput("i");
		for (const ch of "@reader where is foo?") overlay.handleInput(ch);
		overlay.handleInput("\r");
		await flushMicrotasks();
		rendered = overlay.render(120).join("\n");
		expect(rendered).toContain("Codebase reader is disabled or unavailable.");
		expect(rendered).toContain("Pre-attached to Round 1 (2 files):");
		expect(session.readerEntries).toHaveLength(0);
		expect(asked).toHaveLength(1);
	});

	it("sends @reader questions to the Reader tab and answers Reader-tab questions with the reader", async () => {
		const { tui } = createFakeTui();
		const questions: string[] = [];
		const reader: CodebaseReader = {
			modelLabel: "smol-reader (test)",
			async query(input) {
				questions.push(input.question);
				const answer = `Called from src/index.ts for ${input.question}`;
				input.onTextDelta?.(answer, answer);
				return { answer, cached: false };
			},
			dispose: () => {},
		};
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude],
			initialReviewers: [claude],
			codeReader: reader,
		});
		const overlay = new PlanCouncilOverlay(tui, session, { reviewOptions: defaultReviewOptions, synthesizerModel: claude.model }, () => {});

		overlay.handleInput("i");
		for (const ch of "@reader resolvePlanReview") overlay.handleInput(ch);
		overlay.handleInput("\r");
		await flushMicrotasks();

		const rendered = overlay.render(120).join("\n");
		expect(rendered).toContain("Reader (1)");
		expect(rendered).toContain("[Operator → Reader]");
		expect(rendered).toContain("Q: resolvePlanReview");
		expect(rendered).toContain("Called from src/index.ts for resolvePlanReview");
		expect(rendered).toContain("Ask @reader >");

		// on the Reader tab a plain question goes to the reader, not the council
		overlay.handleInput("i");
		for (const ch of "Which tests?") overlay.handleInput(ch);
		overlay.handleInput("\r");
		await flushMicrotasks();

		expect(questions).toEqual(["resolvePlanReview", "Which tests?"]);
		expect(session.entries).toHaveLength(0);
		expect(overlay.render(120).join("\n")).toContain("Reader (2)");
	});

	it("shows live reader badges while a reviewer waits on the reader, then its codebase check count", async () => {
		const { tui } = createFakeTui();
		const started = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<string>();
		const reader: CodebaseReader = {
			modelLabel: "smol-reader (test)",
			async query(input) {
				input.onStatusChange?.("reading");
				input.onToolActivity?.("grep");
				started.resolve();
				return { answer: await answer.promise, cached: false };
			},
			dispose: () => {},
		};
		const streamFn: ModelStreamFn = (_model, context) => {
			const content = context.messages.some(m => m.role === "toolResult")
				? [
						{ type: "text", text: "Grounded critique" },
						{ type: "toolCall", id: "c2", name: "report_position", arguments: { verdict: "APPROVE", revisions: [], positions: [] } },
					]
				: [{ type: "toolCall", id: "c1", name: "ask_codebase", arguments: { question: "Where is X?" } }];
			return {
				async *[Symbol.asyncIterator]() {},
				result: async () => ({ role: "assistant", content, stopReason: "toolUse" }) as unknown as AssistantMessage,
			};
		};
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude],
			initialReviewers: [claude],
			codeReader: reader,
			streamFn,
		});
		const overlay = new PlanCouncilOverlay(tui, session, { reviewOptions: defaultReviewOptions, synthesizerModel: claude.model }, () => {});

		const critiques = session.startInitialCritiques();
		await started.promise;
		const waiting = overlay.render(120).join("\n");
		expect(waiting).toContain("⏳ asking reader...");
		expect(waiting).toContain("⏳ Reader (1)");

		// reviewer tab, then the Reader tab with the reader's current tool
		overlay.handleInput("]");
		overlay.handleInput("]");
		expect(overlay.render(120).join("\n")).toContain("⏳ grep...");

		answer.resolve("X lives in src/x.ts");
		await critiques;
		overlay.handleInput("[");
		const done = overlay.render(120).join("\n");
		expect(done).toContain("Grounded critique");
		expect(done).toContain("· 1 codebase check");
		expect(done).not.toContain("asking reader");
	});

	it("scores verdicts, required revisions, and disputes, and collapses the scorecard on 'o'", async () => {
		const { tui } = createFakeTui();
		const streamFn: ModelStreamFn = (model, context) => {
			const prompt = String(context.messages[context.messages.length - 1].content);
			const debate = prompt.includes("Council Debate");
			const args =
				model.id === claude.model.id
					? {
							verdict: "APPROVE",
							revisions: [],
							positions: debate ? [{ id: `${gpt.key}#1`, stance: "dispute", reason: "already clamped" }] : [],
						}
					: { verdict: "NEEDS REVISION", revisions: [{ summary: "Clamp negative budgets" }], positions: [] };
			return {
				async *[Symbol.asyncIterator]() {},
				result: async () =>
					({
						role: "assistant",
						content: [
							{ type: "text", text: "Review" },
							{ type: "toolCall", id: "call-0", name: "report_position", arguments: args },
						],
						stopReason: "toolUse",
					}) as unknown as AssistantMessage,
			};
		};
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude, gpt],
			initialReviewers: [claude, gpt],
			streamFn,
		});
		const overlay = new PlanCouncilOverlay(tui, session, { reviewOptions: defaultReviewOptions, synthesizerModel: claude.model }, () => {});

		await session.startInitialCritiques();
		let rows = overlay.render(120);
		let text = plain(rows);
		expect(text).toContain("▾ Consensus Scorecard · 1 open · 1 revision");
		expect(text).toContain("✓ APPROVE · claude-3-7-sonnet (anthropic) (no required revisions)");
		expect(text).toContain("△ NEEDS REVISION · gpt-4o (openai) (1 required revision)");
		expect(text).toContain("• gpt-4o#1: Clamp negative budgets");
		expect(text).toContain("• 1 revision awaits peer cross-examination (press d to debate)");
		expect(text).toMatch(/\[claude-3-7-sonnet \(anthropic\) · Round 1 critique\] ✓ APPROVE · \d+\.\ds/);
		expect(text).toMatch(/\[gpt-4o \(openai\) · Round 1 critique\] △ NEEDS REVISION · \d+\.\ds/);
		const tabRow = Bun.stripANSI(rows[1]);
		expect(tabRow).toContain("✓ claude-3-7-sonnet");
		expect(tabRow).toContain("△ gpt-4o");

		await session.runDebateRound();
		text = plain(overlay.render(120));
		expect(text).toContain("⚡ Dispute on gpt-4o#1 by claude-3-7-sonnet (anthropic): already clamped");
		expect(text).not.toContain("awaits peer cross-examination");

		overlay.handleInput("o");
		rows = overlay.render(120);
		expect(bodyRows(rows)[0]).toContain("▸ Consensus Scorecard · 1 open · 1 revision (o to expand)");
		expect(plain(rows)).not.toContain("△ NEEDS REVISION · gpt-4o");
		overlay.handleInput("o");
		expect(plain(overlay.render(120))).toContain("△ NEEDS REVISION · gpt-4o");
	});

	it("shows configuration warnings and the reviewer, synthesizer, and reader settings", () => {
		const { tui } = createFakeTui();
		const thinkingClaude: ReviewerMember = { ...claude, thinkingLevel: parseThinkingLevel("high") };
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [thinkingClaude, gpt],
			initialReviewers: [thinkingClaude],
		});
		const overlay = new PlanCouncilOverlay(
			tui,
			session,
			{
				reviewOptions: defaultReviewOptions,
				synthesizerModel: gpt.model,
				synthesizerThinkingLevel: parseThinkingLevel("low"),
				warnings: ["Role @council3 did not resolve"],
			},
			() => {},
		);

		expect(plain(overlay.render(100))).toContain("⚠ Role @council3 did not resolve");
		overlay.handleInput("m");
		const models = plain(overlay.render(100));
		expect(models).toContain("claude-3-7-sonnet (anthropic) [family: anthropic · thinking: high]");
		expect(models).toContain("gpt-4o (openai) [family: openai]");
		expect(models).toContain("Synthesizer: gpt-4o (openai) · thinking: low");
		expect(models).toContain("Codebase reader: disabled");
		expect(models).toContain("⚠ Role @council3 did not resolve");
	});

	it("restores each tab's scroll position when returning to it", () => {
		const { tui } = createFakeTui();
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: Array.from({ length: 60 }, (_, i) => `- item ${i}`).join("\n"),
			availableReviewers: [claude],
			initialReviewers: [claude],
		});
		const overlay = new PlanCouncilOverlay(tui, session, { reviewOptions: defaultReviewOptions, synthesizerModel: claude.model }, () => {});

		// Council → claude → Synthesis → Plan
		for (let i = 0; i < 3; i++) overlay.handleInput("]");
		expect(bodyRows(overlay.render(80))[0]).toMatch(/\bitem 0\b/);
		for (let i = 0; i < 5; i++) overlay.handleInput("j");
		expect(bodyRows(overlay.render(80))[0]).toMatch(/\bitem 5\b/);

		overlay.handleInput("[");
		expect(bodyRows(overlay.render(80))[1]).toContain("No synthesis available yet.");

		overlay.handleInput("]");
		expect(bodyRows(overlay.render(80))[0]).toMatch(/\bitem 5\b/);
	});

	it("follows an auto run's tail until the operator scrolls up, holds through stage changes, and resumes on G or a new run", async () => {
		const { tui } = createFakeTui();
		const gates: Array<() => void> = [];
		let call = 0;
		// every turn streams 30 distinct lines at once and settles when its gate opens
		const streamFn: ModelStreamFn = (model, context) => {
			const turn = ++call;
			const reviewer = Boolean(context.tools?.length);
			const text = `Turn ${turn}\n\n${Array.from({ length: 30 }, (_, i) => `- t${turn} point ${i}`).join("\n")}`;
			const gate = Promise.withResolvers<void>();
			gates.push(gate.resolve);
			const position =
				model.id === gpt.model.id
					? { verdict: "NEEDS REVISION", revisions: [{ summary: "Clamp" }], positions: [] }
					: { verdict: "APPROVE", revisions: [], positions: [] };
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "text_delta", delta: text } as unknown as AssistantMessageEvent;
				},
				result: async () => {
					await gate.promise;
					return {
						role: "assistant",
						content: reviewer
							? [{ type: "text", text }, { type: "toolCall", id: `call-${turn}`, name: "report_position", arguments: position }]
							: [{ type: "text", text }],
						stopReason: reviewer ? "toolUse" : "stop",
					} as unknown as AssistantMessage;
				},
			};
		};
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude, gpt],
			initialReviewers: [claude, gpt],
			streamFn,
		});
		const overlay = new PlanCouncilOverlay(
			tui,
			session,
			{ reviewOptions: defaultReviewOptions, synthesizerModel: claude.model, maxDebateRounds: 1 },
			() => {},
		);
		const visible = () => bodyRows(overlay.render(80));

		try {
			// collapsed, the scorecard keeps one height as positions arrive, so only appended turns move content
			overlay.handleInput("o");
			overlay.handleInput(" ");
			await delay(5);
			// Round 1: t1 claude, t2 gpt
			expect(visible().join("\n")).toContain("t2 point 29");
			gates[0]();
			await delay(5);
			expect(visible().join("\n")).toContain("t2 point 29");

			for (let i = 0; i < 5; i++) overlay.handleInput("k");
			const pausedTop = visible()[0];
			expect(visible().join("\n")).not.toContain("t2 point 29");

			// Round 1 → Round 2 debate (t3, t4) → synthesis (t5) without snapping back to the tail
			gates[1]();
			await delay(5);
			expect(session.round).toBe(2);
			expect(visible()[0]).toBe(pausedTop);
			expect(visible().join("\n")).not.toContain("t4 point 29");
			gates[2]();
			gates[3]();
			await delay(5);
			expect(session.latestSynthesis?.status).toBe("streaming");
			expect(visible()[0]).toBe(pausedTop);
			expect(visible().join("\n")).not.toContain("t5 point 29");

			overlay.handleInput("G");
			expect(visible().join("\n")).toContain("t5 point 29");
			gates[4]();
			await delay(5);
			expect(session.isActive()).toBe(false);

			// a paused view resumes following when the next run starts
			for (let i = 0; i < 3; i++) overlay.handleInput("[");
			for (let i = 0; i < 5; i++) overlay.handleInput("k");
			overlay.handleInput(" ");
			await delay(5);
			expect(visible().join("\n")).toContain("t7 point 29");
			for (let i = 0; i < 5; i++) overlay.handleInput("k");
			expect(visible().join("\n")).not.toContain("t7 point 29");
			overlay.handleInput("G");
			expect(visible().join("\n")).toContain("t7 point 29");
		} finally {
			for (let i = 0; i < 10 && session.isActive(); i++) {
				for (const open of gates) open();
				await delay(5);
			}
			overlay.dispose();
			session.dispose();
		}
	});

	it("keeps the full frame height and every tab reachable on a narrow terminal", () => {
		const { tui } = createFakeTui();
		const gemini = makeFakeReviewer("google", "gemini-2.5-pro-preview-20250506");
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude, gpt, gemini],
			initialReviewers: [claude, gpt, gemini],
		});
		const overlay = new PlanCouncilOverlay(tui, session, { reviewOptions: defaultReviewOptions, synthesizerModel: claude.model }, () => {});

		const rows = overlay.render(56);
		expect(rows).toHaveLength(24);
		expect(rows.every(r => visibleWidth(r) <= 56)).toBe(true);
		const header = plain(rows.slice(0, rows.findIndex(r => /^─+$/.test(Bun.stripANSI(r)))));
		expect(header).toContain("gemini-2.5-pr…");
		expect(header).toContain("Models");

		overlay.handleInput("m");
		const models = overlay.render(56);
		expect(models).toHaveLength(24);
		expect(plain(models)).toContain("gemini-2.5-pro-preview-20250506 (google)");
	});

	it("shows the plan beside the discussion on 'p', scrolls only the focused pane, and collapses when narrow", async () => {
		const tui = { terminal: { rows: 24, cols: 140 }, requestRender: () => {} } as unknown as TUI;
		const critique = Array.from({ length: 40 }, (_, i) => `- critique point ${i}`).join("\n");
		const streamFn: ModelStreamFn = () => ({
			async *[Symbol.asyncIterator]() {},
			result: async () =>
				({
					role: "assistant",
					content: [
						{ type: "text", text: critique },
						{ type: "toolCall", id: "call-0", name: "report_position", arguments: { verdict: "APPROVE", revisions: [], positions: [] } },
					],
					stopReason: "toolUse",
				}) as unknown as AssistantMessage,
		});
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "docs/plan.md",
			planContent: Array.from({ length: 40 }, (_, i) => `- plan step ${i}`).join("\n"),
			availableReviewers: [claude],
			initialReviewers: [claude],
			streamFn,
		});
		await session.startInitialCritiques();
		const overlay = new PlanCouncilOverlay(tui, session, { reviewOptions: defaultReviewOptions, synthesizerModel: claude.model }, () => {});

		overlay.handleInput("p");
		let rows = overlay.render(140);
		expect(rows).toHaveLength(24);
		expect(Bun.stripANSI(rows[0])).toContain("[Split · Main]");
		let body = bodyRows(rows);
		expect(body[0]).toContain("Consensus Scorecard");
		expect(body[0]).toContain(" │   Plan Reference (docs/plan.md)");

		// focus the plan pane: j scrolls it while the discussion stays put
		overlay.handleInput("\x1b[C");
		for (let i = 0; i < 3; i++) overlay.handleInput("j");
		rows = overlay.render(140);
		expect(Bun.stripANSI(rows[0])).toContain("[Split · Plan]");
		body = bodyRows(rows);
		expect(body[0]).toContain("Consensus Scorecard");
		expect(body[0]).toContain(" ┃ ");
		expect(body.join("\n")).not.toContain("Plan Reference");
		const dividerAt = body[0].indexOf("┃");
		const planTop = body[0].slice(dividerAt);
		expect(planTop).toMatch(/plan step \d+/);

		overlay.handleInput("\x1b[D");
		for (let i = 0; i < 3; i++) overlay.handleInput("j");
		body = bodyRows(overlay.render(140));
		expect(body[0]).not.toContain("Consensus Scorecard");
		expect(body[0].slice(dividerAt)).toBe(planTop.replace("┃", "│"));

		rows = overlay.render(80);
		expect(rows).toHaveLength(24);
		expect(Bun.stripANSI(rows[0])).toContain("[Split: narrow]");
		expect(plain(rows)).not.toContain("plan step");
	});
});

describe("planCouncilExtension lifecycle & shortcut wiring", () => {
	const claude = makeFakeModel("anthropic", "claude-3-7-sonnet");

	it("registers command, event listeners, and intercepts shortcut to resolve plan review", async () => {
		const handlers = new Map<string, ExtensionHandler<unknown, unknown>>();
		const commands = new Map<string, unknown>();
		let terminalInputListener: ((data: string) => { consume?: boolean } | undefined) | undefined;
		let setStatusKey: string | undefined;
		let setStatusValue: string | undefined;
		let customOverlayMounted = false;
		let resolvedReviewId = "";
		let resolvedChoice = "";
		let resolvedFeedback = "";

		const mockPi: ExtensionAPI = {
			registerCommand: (name: string, opts: unknown) => {
				commands.set(name, opts);
			},
			registerShortcut: () => {},
			registerFlag: () => {},
			on: (event: string, handler: unknown) => {
				handlers.set(event, handler as ExtensionHandler<unknown, unknown>);
			},
			events: { emit: () => {}, on: () => () => {} },
		} as unknown as ExtensionAPI;

		planCouncilExtension(mockPi);

		expect(commands.has("plan-council")).toBe(true);
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("plan_review_requested")).toBe(true);
		expect(handlers.has("plan_review_resolved")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);

		const fakeContext: ExtensionContext = {
			cwd: process.cwd(),
			hasUI: true,
			agent: { kind: "main", id: "main", name: "main", depth: 0 },
			models: {
				list: () => [claude],
				current: () => claude,
				resolve: () => claude,
				family: () => "claude",
			},
			modelRegistry: {
				resolver: () => undefined,
			},
			ui: {
				theme,
				onTerminalInput: (listener: (data: string) => { consume?: boolean } | undefined) => {
					terminalInputListener = listener;
					return () => {
						terminalInputListener = undefined;
					};
				},
				setStatus: (key: string, val?: string) => {
					setStatusKey = key;
					setStatusValue = val;
				},
				notify: () => {},
				custom: async (factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (res: unknown) => void) => unknown, _opts?: unknown) => {
					customOverlayMounted = true;
					const fakeTui = { terminal: { rows: 24, cols: 80 }, requestRender: () => {} } as unknown as TUI;
					let outcome: CouncilOverlayOutcome | undefined;
					factory(fakeTui, theme as unknown as Theme, {} as unknown as KeybindingsManager, (res: unknown) => {
						outcome = res as CouncilOverlayOutcome;
					});
					return outcome ?? { action: "refine", feedback: "Synthesized feedback from mock" };
				},
			},
			resolvePlanReview: (reviewId: string, choice: string, opts?: { feedback?: string }) => {
				resolvedReviewId = reviewId;
				resolvedChoice = choice;
				resolvedFeedback = opts?.feedback ?? "";
				return true;
			},
			getPendingPlanReview: () => undefined,
		} as unknown as ExtensionContext;

		// 1. Session start
		const sessionStartHandler = handlers.get("session_start")!;
		await sessionStartHandler({} as unknown as SessionStartEvent, fakeContext);
		expect(terminalInputListener).toBeDefined();

		// 2. Plan review requested event
		const reviewRequestedHandler = handlers.get("plan_review_requested")!;
		const sampleReviewEvent: PlanReviewRequestedEvent = {
			type: "plan_review_requested",
			reviewId: "rev-123",
			sessionId: "sess-456",
			title: "Refactor Database",
			planFilePath: "plan.md",
			planContent: "# DB Plan",
			options: [{ id: "execute", label: "Execute", disabled: false }],
		};

		reviewRequestedHandler(sampleReviewEvent, fakeContext);
		for (let i = 0; i < 20 && setStatusKey !== "plan-council"; i++) {
			await delay(5);
		}
		expect(setStatusKey).toBe("plan-council");

		// 3. User presses Ctrl+N (ASCII 0x0e)
		expect(terminalInputListener).toBeDefined();
		const result = terminalInputListener!("\x0e");
		expect(result).toEqual({ consume: true });

		for (let i = 0; i < 20 && !customOverlayMounted; i++) {
			await delay(5);
		}
		expect(customOverlayMounted).toBe(true);
		expect(resolvedReviewId).toBe("rev-123");
		expect(resolvedChoice).toBe("refine");
		expect(resolvedFeedback).toContain("Synthesized feedback from mock");

		// 4. Plan review resolved event clears status
		const reviewResolvedHandler = handlers.get("plan_review_resolved")!;
		const sampleResolvedEvent: PlanReviewResolvedEvent = {
			type: "plan_review_resolved",
			reviewId: "rev-123",
			sessionId: "sess-456",
			choice: "refine",
			by: "extension",
		};
		reviewResolvedHandler(sampleResolvedEvent, fakeContext);
		expect(setStatusKey).toBe("plan-council");
		expect(setStatusValue).toBeUndefined();
	});

	it("reuses the cached council on reopen but rebuilds it when the reader query cap changes", async () => {
		const isolation = isolateOmpHome("pi-council-cap-home-");
		const projectDir = TempDir.createSync("@pi-council-cap-proj-");
		const overridesPath = path.join(projectDir.path(), ".omp", "plugin-overrides.json");
		const setCap = (cap: number) => {
			fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
			fs.writeFileSync(overridesPath, JSON.stringify({ settings: { "plan-council": { maxReaderQueriesPerTurn: cap } } }));
		};
		const disposeSpy = spyOn(CouncilSession.prototype, "dispose");

		try {
			const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
			planCouncilExtension({
				registerCommand: (name: string, opts: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
					commands.set(name, opts);
				},
				registerShortcut: () => {},
				registerFlag: () => {},
				on: () => {},
			} as unknown as ExtensionAPI);

			const fakeContext = {
				cwd: projectDir.path(),
				hasUI: true,
				agent: { kind: "main", id: "main", name: "main", depth: 0 },
				// no reviewers, so opening never starts critiques; the session model serves as the reader
				models: { list: () => [], current: () => claude, resolve: () => undefined, family: (m: Model) => m.provider },
				modelRegistry: { resolver: () => undefined },
				ui: {
					theme,
					notify: () => {},
					setStatus: () => {},
					custom: async (factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (res: unknown) => void) => unknown) => {
						const fakeTui = { terminal: { rows: 24, cols: 80 }, requestRender: () => {} } as unknown as TUI;
						factory(fakeTui, theme as unknown as Theme, {} as unknown as KeybindingsManager, () => {});
						return { action: "close" };
					},
				},
				resolvePlanReview: () => true,
				getPendingPlanReview: () => ({
					type: "plan_review_requested",
					reviewId: "rev-cap",
					sessionId: "sess-cap",
					title: "Cap Plan",
					planFilePath: "plan.md",
					planContent: "# Cap Plan",
					options: [{ id: "execute", label: "Execute", disabled: false }],
				}),
			} as unknown as ExtensionContext;
			const open = () => commands.get("plan-council")!.handler("", fakeContext);

			setCap(2);
			await open();
			await open();
			expect(disposeSpy).not.toHaveBeenCalled();

			setCap(5);
			await open();
			expect(disposeSpy).toHaveBeenCalledTimes(1);
		} finally {
			disposeSpy.mockRestore();
			projectDir.removeSync();
			isolation.restore();
		}
	});

	it("--auto launch attaches plan-referenced files, runs critiques, debate, and synthesis, then resolves with refine feedback", async () => {
		const isolation = isolateOmpHome("pi-council-auto-home-");
		const projectDir = TempDir.createSync("@pi-council-auto-proj-");
		fs.mkdirSync(projectDir.join("src"));
		fs.writeFileSync(projectDir.join("src", "target.ts"), "export const target = 1;\n");
		fs.writeFileSync(projectDir.join("plan.md"), "# Auto Plan\n");
		const reviewerPrompts: string[] = [];
		const streamSpy = spyOn(ai, "streamSimple").mockImplementation(((_model: Model, context: Context) => {
			const last = context.messages[context.messages.length - 1];
			const prompt = last.role === "user" && typeof last.content === "string" ? last.content : "";
			const isSynthesis = (context.systemPrompt?.[0] ?? "").includes("Synthesizer");
			const content: AssistantMessage["content"] = [];
			if (isSynthesis) {
				content.push({ type: "text", text: "## Required Plan Revisions\n1. Mocked auto synthesis" });
			} else {
				reviewerPrompts.push(prompt);
				const peerIds = [...prompt.matchAll(/^- `([^`]+)`: /gm)].map(m => m[1]);
				content.push(
					{ type: "text", text: "### Verdict\nNEEDS REVISION" },
					{
						type: "toolCall",
						id: "call-0",
						name: "report_position",
						arguments: {
							verdict: "NEEDS REVISION",
							revisions: [{ summary: "Add a rollback step" }],
							positions: peerIds.map(id => ({ id, stance: "agree", reason: "" })),
						},
					},
				);
			}
			const msg = { role: "assistant", content, stopReason: isSynthesis ? "stop" : "toolUse" } as unknown as AssistantMessage;
			return {
				async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {},
				result: async () => msg,
			} as unknown as ReturnType<typeof ai.streamSimple>;
		}) as typeof ai.streamSimple);

		try {
			const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
			const herdrWorking: unknown[] = [];
			planCouncilExtension({
				registerCommand: (name: string, opts: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
					commands.set(name, opts);
				},
				registerShortcut: () => {},
				registerFlag: () => {},
				on: () => {},
				events: {
					emit: (channel: string, data: unknown) => {
						if (channel === "herdr:working") herdrWorking.push(data);
					},
					on: () => () => {},
				},
			} as unknown as ExtensionAPI);

			const gpt = makeFakeModel("openai", "gpt-4o");
			const planning = makeFakeModel("google", "gemini-2.5-pro");
			let resolved: { reviewId: string; choice: string; feedback?: string } | undefined;
			const fakeContext = {
				cwd: projectDir.path(),
				hasUI: true,
				agent: { kind: "main", id: "main", name: "main", depth: 0 },
				models: {
					list: () => [claude, gpt, planning],
					current: () => planning,
					resolve: () => undefined,
					family: (m: Model) => m.provider,
				},
				modelRegistry: { resolver: () => undefined },
				ui: {
					theme,
					notify: () => {},
					setStatus: () => {},
					custom: (factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (res: unknown) => void) => unknown) => {
						const { promise, resolve } = Promise.withResolvers<unknown>();
						const fakeTui = { terminal: { rows: 24, cols: 80 }, requestRender: () => {} } as unknown as TUI;
						factory(fakeTui, theme as unknown as Theme, {} as unknown as KeybindingsManager, resolve);
						return promise;
					},
				},
				resolvePlanReview: (reviewId: string, choice: string, opts?: { feedback?: string }) => {
					resolved = { reviewId, choice, feedback: opts?.feedback };
					return true;
				},
				getPendingPlanReview: () => ({
					type: "plan_review_requested",
					reviewId: "rev-auto",
					sessionId: "sess-auto",
					title: "Auto Plan",
					planFilePath: "plan.md",
					planContent: "# Auto Plan\nUpdate `src/target.ts` line 1 and keep plan.md in sync.",
					options: [{ id: "execute", label: "Execute", disabled: false }],
				}),
			} as unknown as ExtensionContext;

			const finished = commands.get("plan-council")!.handler("--auto", fakeContext);
			await Promise.race([
				finished,
				delay(3000).then(() => {
					throw new Error("auto pipeline never closed the overlay");
				}),
			]);

			expect(resolved).toEqual({ reviewId: "rev-auto", choice: "refine", feedback: "## Required Plan Revisions\n1. Mocked auto synthesis" });
			// Round 1 for both reviewers, then one debate round that converges on agreement
			expect(reviewerPrompts.filter(p => p.includes("# Council Debate: Round 2"))).toHaveLength(2);
			expect(reviewerPrompts.some(p => p.includes("# Council Debate: Round 3"))).toBe(false);
			// herdr sees one Working hold across critiques, debate, and synthesis
			expect(herdrWorking).toEqual([{ active: true }, { active: false }]);
			// Round 1 carries the referenced file but never the plan file itself
			const round1 = reviewerPrompts.filter(p => p.includes("# Plan Review: Auto Plan"));
			expect(round1).toHaveLength(2);
			for (const prompt of round1) {
				expect(prompt).toContain("## Referenced Repository Files");
				expect(prompt).toContain("### `src/target.ts` (line 1)\n```ts\n1: export const target = 1;\n```");
				expect(prompt).not.toContain("### `plan.md`");
			}
		} finally {
			streamSpy.mockRestore();
			projectDir.removeSync();
			isolation.restore();
		}
	});

	it("a launch superseded while collecting files leaves the newer launch's overlay, review, and session alone", async () => {
		const isolation = isolateOmpHome("pi-council-race-home-");
		const projectDir = TempDir.createSync("@pi-council-race-proj-");
		const requestedPlans: string[] = [];
		const streamSpy = spyOn(ai, "streamSimple").mockImplementation(((_model: Model, context: Context) => {
			const first = context.messages[0];
			requestedPlans.push(first.role === "user" && typeof first.content === "string" ? first.content.split("\n")[0] : "");
			const msg = { role: "assistant", content: [{ type: "text", text: "### Verdict\nAPPROVE" }], stopReason: "stop" } as unknown as AssistantMessage;
			return {
				async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {},
				result: async () => msg,
			} as unknown as ReturnType<typeof ai.streamSimple>;
		}) as typeof ai.streamSimple);
		const loggerSpy = spyOn(logger, "error");
		const disposeSpy = spyOn(CouncilSession.prototype, "dispose");

		const reviewFor = (n: number): PlanReviewRequestedEvent => ({
			type: "plan_review_requested",
			reviewId: `rev-${n}`,
			sessionId: "sess-race",
			title: `Review ${n}`,
			planFilePath: "plan.md",
			planContent: `# Review ${n}`,
			options: [{ id: "execute", label: "Execute", disabled: false }],
		});
		const firstCollect = Promise.withResolvers<PlanFileExcerpt[]>();
		const firstCollectReached = Promise.withResolvers<void>();
		const collectedPlans: string[] = [];
		const collect: typeof collectPlanReferencedFiles = async (_cwd, planContent) => {
			collectedPlans.push(planContent);
			if (planContent === "# Review 1") {
				firstCollectReached.resolve();
				return firstCollect.promise;
			}
			return [];
		};

		try {
			const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
			planCouncilExtension(
				{
					registerCommand: (name: string, opts: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
						commands.set(name, opts);
					},
					registerShortcut: () => {},
					registerFlag: () => {},
					on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
						handlers.set(event, handler);
					},
					events: { emit: () => {}, on: () => () => {} },
				} as unknown as ExtensionAPI,
				{ collectPlanReferencedFiles: collect },
			);

			const gpt = makeFakeModel("openai", "gpt-4o");
			const planning = makeFakeModel("google", "gemini-2.5-pro");
			let pending = reviewFor(1);
			const overlays: Array<{ signal: AbortSignal; done: (res: unknown) => void }> = [];
			const overlayOpened = Promise.withResolvers<void>();
			const resolved: Array<{ reviewId: string; choice: string }> = [];
			const ctx = {
				cwd: projectDir.path(),
				hasUI: true,
				agent: { kind: "main", id: "main", name: "main", depth: 0 },
				models: {
					list: () => [claude, gpt, planning],
					current: () => planning,
					resolve: () => undefined,
					family: (m: Model) => m.provider,
				},
				modelRegistry: { resolver: () => undefined },
				ui: {
					theme,
					notify: () => {},
					setStatus: () => {},
					custom: (
						factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (res: unknown) => void) => unknown,
						opts: { signal: AbortSignal },
					) => {
						const { promise, resolve } = Promise.withResolvers<unknown>();
						const fakeTui = { terminal: { rows: 24, cols: 80 }, requestRender: () => {} } as unknown as TUI;
						factory(fakeTui, theme as unknown as Theme, {} as unknown as KeybindingsManager, resolve);
						overlays.push({ signal: opts.signal, done: resolve });
						overlayOpened.resolve();
						return promise;
					},
				},
				resolvePlanReview: (reviewId: string, choice: string) => {
					resolved.push({ reviewId, choice });
					return true;
				},
				getPendingPlanReview: () => pending,
			} as unknown as ExtensionContext;
			const openCouncil = () => commands.get("plan-council")!.handler("", ctx);

			// launch 1 comes from the command with no prior plan_review_requested and stalls collecting files
			const launch1 = openCouncil();
			await firstCollectReached.promise;
			const resolvedEvent: PlanReviewResolvedEvent = {
				type: "plan_review_resolved",
				reviewId: "rev-1",
				sessionId: "sess-race",
				choice: "refine",
				by: "extension",
			};
			handlers.get("plan_review_resolved")!(resolvedEvent, ctx);

			// launch 2 opens for the next review before launch 1's collector settles
			pending = reviewFor(2);
			const launch2 = openCouncil();
			await Promise.race([
				overlayOpened.promise,
				delay(1000).then(() => {
					throw new Error("launch 2 never opened: the resolved review did not free the launch slot");
				}),
			]);
			firstCollect.reject(new Error("stale collector failure"));
			await launch1;
			await flushMicrotasks();

			expect(collectedPlans).toEqual(["# Review 1", "# Review 2"]);
			expect(overlays).toHaveLength(1);
			expect(overlays[0].signal.aborted).toBe(false);
			expect(loggerSpy).not.toHaveBeenCalled();
			expect(disposeSpy).not.toHaveBeenCalled();

			// launch 2 still owns the slot, so opening again is a no-op (not awaited: a wrongly opened overlay never settles)
			void openCouncil();
			await delay(20);
			expect(overlays).toHaveLength(1);

			overlays[0].done({ action: "refine", feedback: "Review 2 feedback" });
			await launch2;
			await flushMicrotasks();
			expect(resolved).toEqual([{ reviewId: "rev-2", choice: "refine" }]);
			expect(requestedPlans.length).toBeGreaterThan(0);
			expect(requestedPlans.every(p => p === "# Plan Review: Review 2")).toBe(true);
		} finally {
			streamSpy.mockRestore();
			loggerSpy.mockRestore();
			disposeSpy.mockRestore();
			projectDir.removeSync();
			isolation.restore();
		}
	});

	it("resolves the plan review with the approval and execution tier picked in the overlay", async () => {
		const isolation = isolateOmpHome("pi-council-tier-home-");
		const projectDir = TempDir.createSync("@pi-council-tier-proj-");
		try {
			const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
			planCouncilExtension({
				registerCommand: (name: string, opts: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
					commands.set(name, opts);
				},
				registerShortcut: () => {},
				registerFlag: () => {},
				on: () => {},
				events: { emit: () => {}, on: () => () => {} },
			} as unknown as ExtensionAPI);

			const resolved: Array<{ reviewId: string; choice: string; input?: { feedback?: string; role?: string } }> = [];
			const ctx = {
				cwd: projectDir.path(),
				hasUI: true,
				agent: { kind: "main", id: "main", name: "main", depth: 0 },
				// no reviewers, so opening never starts critiques
				models: { list: () => [], current: () => claude, resolve: () => undefined, family: (m: Model) => m.provider },
				modelRegistry: { resolver: () => undefined },
				ui: {
					theme,
					notify: () => {},
					setStatus: () => {},
					custom: (factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (res: unknown) => void) => unknown) => {
						const { promise, resolve } = Promise.withResolvers<unknown>();
						const fakeTui = { terminal: { rows: 24, cols: 80 }, requestRender: () => {} } as unknown as TUI;
						const overlay = factory(fakeTui, theme as unknown as Theme, {} as unknown as KeybindingsManager, resolve) as PlanCouncilOverlay;
						// open the picker, pick Compact, step from the preselected default tier to smol, confirm
						for (const key of ["a", "\x1b[C", "\t", "\r"]) overlay.handleInput(key);
						return promise;
					},
				},
				resolvePlanReview: (reviewId: string, choice: string, input?: { feedback?: string; role?: string }) => {
					resolved.push({ reviewId, choice, input });
					return true;
				},
				getPendingPlanReview: (): PlanReviewRequestedEvent => ({
					type: "plan_review_requested",
					reviewId: "rev-tier",
					sessionId: "sess-tier",
					title: "Tier Plan",
					planFilePath: "plan.md",
					planContent: "# Tier Plan",
					options: [
						{ id: "execute", label: "Execute", disabled: false },
						{ id: "compact", label: "Compact", disabled: false },
					],
					tiers: [
						{ role: "smol", provider: "openai", model: "gpt-4o-mini" },
						{ role: "default", provider: "anthropic", model: "claude-3-7-sonnet" },
					],
				}),
			} as unknown as ExtensionContext;

			await commands.get("plan-council")!.handler("", ctx);
			expect(resolved).toEqual([{ reviewId: "rev-tier", choice: "compact", input: { role: "smol" } }]);
		} finally {
			projectDir.removeSync();
			isolation.restore();
		}
	});
});

describe("plugin package discovery", () => {
	let projectDir: TempDir;
	let isolation: { home: string; restore: () => void };

	beforeEach(() => {
		projectDir = TempDir.createSync("@pi-council-proj-");
		isolation = isolateOmpHome("pi-council-home-");
		const pluginsDir = getPluginsDir();

		// Symlink plugins/plan-council into isolated home node_modules
		const destDir = path.join(pluginsDir, "node_modules", "plan-council");
		fs.mkdirSync(path.dirname(destDir), { recursive: true });

		const sourceDir = path.resolve(import.meta.dir, "..");
		fs.symlinkSync(sourceDir, destDir, "dir");

		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"plan-council": "0.1.0",
				},
			}),
		);
	});

	afterEach(() => {
		projectDir.removeSync();
		__closeExtensionParseCacheForTests();
		isolation.restore();
	});

	it("discovers and loads @oh-my-pi/plan-council from plugin manifest", async () => {
		const result = await discoverAndLoadExtensions([], projectDir.path());
		expect(result.errors).toHaveLength(0);

		const councilExt = result.extensions.find(ext => ext.path.includes("plan-council"));
		expect(councilExt).toBeDefined();
		expect(councilExt?.commands.has("plan-council")).toBe(true);
	});
});
