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
	SessionStartEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { __closeExtensionParseCacheForTests } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import type { Theme, TUI } from "@oh-my-pi/pi-tui";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { getAgentDir, getPluginsDir, removeSyncWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { CouncilSession, type ModelStreamFn } from "../src/council-session";
import planCouncilExtension from "../src/index";
import type { ReviewerMember } from "../src/models";
import { type CouncilOverlayOutcome, PlanCouncilOverlay } from "../src/overlay";

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

	it("resolves approve action on 'a'", () => {
		const { tui } = createFakeTui();
		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude],
			initialReviewers: [claude],
		});

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

		overlay.handleInput("a");
		expect(resolvedOutcome).toEqual({ action: "approve", choice: "execute" });
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

	it("--auto launch runs critiques, debate, and synthesis, then resolves the plan review with refine feedback", async () => {
		const isolation = isolateOmpHome("pi-council-auto-home-");
		const projectDir = TempDir.createSync("@pi-council-auto-proj-");
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
					planContent: "# Auto Plan",
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
		} finally {
			streamSpy.mockRestore();
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
