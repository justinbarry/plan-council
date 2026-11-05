import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@oh-my-pi/pi-ai";
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
import * as reviewerAgents from "../src/reviewer-agent";
import * as councilSettings from "../src/settings";
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

	// inspect mode must reach the native factory while explicit off keeps the old path
	it.each([true, false])("registers lifecycle and shortcut wiring with code inspection %s", async codeInspection => {
		using settingsSpy = spyOn(councilSettings, "loadPlanCouncilSettings").mockResolvedValue(councilSettings.parsePlanCouncilSettings({ codeInspection }));
		using factorySpy = spyOn(reviewerAgents, "createNativeReviewerAgentFactory").mockReturnValue(async () => ({
			async runTurn() { return { status: "done", text: "Inspected source", inspection: { attempted: 1, failed: 0 } }; },
			async dispose() {},
		}));
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
		expect(factorySpy).toHaveBeenCalledTimes(codeInspection ? 1 : 0);
		if (codeInspection) expect(factorySpy.mock.calls[0]?.[0].cwd).toBe(process.cwd());
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
});

describe("plugin package discovery", () => {
	let projectDir: TempDir;
	let tempHome = "";
	const originalAgentDir = getAgentDir();
	const xdgVars = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
	const originalXdg = new Map<string, string | undefined>();

	beforeEach(() => {
		projectDir = TempDir.createSync("@pi-council-proj-");
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-home-"));
		for (const key of xdgVars) {
			originalXdg.set(key, process.env[key]);
			delete process.env[key];
		}
		spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));

		const pluginsDir = getPluginsDir();
		if (!pluginsDir.startsWith(tempHome + path.sep)) {
			throw new Error(`plugin isolation failed: ${pluginsDir}`);
		}

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
		spyOn(os, "homedir").mockRestore();
		for (const [key, value] of originalXdg) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		originalXdg.clear();
		setAgentDir(originalAgentDir);
		__closeExtensionParseCacheForTests();
		removeSyncWithRetries(tempHome);
	});

	it("discovers and loads @oh-my-pi/plan-council from plugin manifest", async () => {
		const result = await discoverAndLoadExtensions([], projectDir.path());
		expect(result.errors).toHaveLength(0);

		const councilExt = result.extensions.find(ext => ext.path.includes("plan-council"));
		expect(councilExt).toBeDefined();
		expect(councilExt?.commands.has("plan-council")).toBe(true);
	});
});
