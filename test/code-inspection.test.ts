import { describe, expect, it } from "bun:test";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { spyOn } from "bun:test";
import { parseEffort } from "@oh-my-pi/pi-tui/thinking";
import { CouncilSession, isReviewerTurnEntry } from "../src/council-session";
import type { ReviewerMember } from "../src/models";
import type { ReviewerAgent, ReviewerAgentFactory, ReviewerTurnResult } from "../src/reviewer-agent";
import { parsePlanCouncilSettings } from "../src/settings";

const model: Model = {
	id: "council-test", name: "Council test", provider: "council-test", api: "openai-responses",
	baseUrl: "https://example.invalid", compat: undefined, identity: { class: "openai", family: "gpt" },
	reasoning: true, thinking: { mode: "effort", efforts: ["high", "xhigh"].map(parseEffort).filter(level => level !== undefined) },
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
};
const reviewer: ReviewerMember = { key: "council-test/council-test", label: "Council test", family: "gpt", model };

/** return a completed inspection with explicit source coverage for the owning session tests */
function done(): ReviewerTurnResult {
	return { status: "done", text: "## Code inspection\nInspected: README.md:1\nNot inspected or limits: other files", inspection: { attempted: 1, failed: 0 } };
}

/** construct the real council with only the native reviewer boundary substituted */
function council(factory: ReviewerAgentFactory, reviewers: ReviewerMember[] = [reviewer]): CouncilSession {
	return new CouncilSession({
		planTitle: "Inspect a plan", planFilePath: "plan.md", planContent: "The complete plan",
		availableReviewers: reviewers, initialReviewers: reviewers, reviewerAgentFactory: factory,
	});
}

// default on is patricks selected product behavior and false retains the existing text mode
describe("code inspection settings", () => {
	it("enables inspection by default and accepts only an explicit boolean override", () => {
		expect(parsePlanCouncilSettings({}).codeInspection).toBe(true);
		expect(parsePlanCouncilSettings({ codeInspection: false }).codeInspection).toBe(false);
		expect(parsePlanCouncilSettings({ codeInspection: "false" }).codeInspection).toBe(true);
	});
});

// native histories must survive later turns without sharing a session between reviewers
describe("council native reviewer lifecycle", () => {
	it("reuses a reviewers agent through debate questions and model toggles", async () => {
		const prompts = new Map<string, string[]>();
		let created = 0;
		let disposed = 0;
		// the fake records the native boundary while all orchestration stays real
		const factory: ReviewerAgentFactory = async member => {
			created++;
			const history: string[] = [];
			prompts.set(member.key, history);
			return {
				async runTurn(prompt) { history.push(prompt); return done(); },
				async dispose() { disposed++; },
			};
		};
		const other: ReviewerMember = { ...reviewer, key: "council-test/other", label: "Other", model: { ...model, id: "other" } };
		const session = council(factory, [reviewer, other]);
		try {
			await session.startInitialCritiques();
			await session.runDebateRound();
			await session.askCouncil("Check the callers");
			session.setReviewers([]);
			session.setReviewers([reviewer.key]);
			await session.askCouncil("Check the final risk");
			expect(created).toBe(2);
			expect(prompts.get(reviewer.key)).toHaveLength(4);
			expect(prompts.get(other.key)).toHaveLength(3);
			expect(prompts.get(reviewer.key)?.[0]).toContain("The complete plan");
			expect(prompts.get(reviewer.key)?.[1]).toContain("Council Debate");
			expect(prompts.get(reviewer.key)?.[2]).toContain("Check the callers");
			expect(session.entries.filter(isReviewerTurnEntry).every(entry => entry.inspection?.attempted === 1)).toBe(true);
		} finally { session.dispose(); }
		expect(disposed).toBe(2);
	});

	// native cancellation must settle before a retry can reuse mutable session state
	it("holds round ownership through abort settlement then starts a fresh failed critique", async () => {
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<ReviewerTurnResult>();
		let created = 0;
		let disposed = 0;
		const factory: ReviewerAgentFactory = async () => {
			const first = created++ === 0;
			return {
				async runTurn(_prompt, signal) {
					if (!first) return done();
					entered.resolve();
					const result = await finish.promise;
					expect(signal.aborted).toBe(true);
					return result;
				},
				async dispose() { disposed++; },
			};
		};
		const session = council(factory);
		try {
			const running = session.startInitialCritiques();
			await entered.promise;
			session.abortActiveRound();
			expect(session.isBusy()).toBe(true);
			await expect(session.startInitialCritiques()).rejects.toThrow("Council is busy");
			finish.resolve({ status: "aborted", text: "", inspection: { attempted: 1, failed: 1 } });
			await running;
			expect(session.isBusy()).toBe(false);
			await session.startInitialCritiques();
			expect(created).toBe(2);
			expect(disposed).toBe(1);
			expect(session.entries.filter(isReviewerTurnEntry).map(entry => entry.status)).toEqual(["aborted", "done"]);
		} finally { finish.resolve(done()); session.dispose(); }
	});

	// disposal must also own a reviewer whose asynchronous startup finishes after the council closes
	it("disposes late startup without starting an inspection", async () => {
		const started = Promise.withResolvers<void>();
		const ready = Promise.withResolvers<ReviewerAgent>();
		let prompts = 0;
		let disposed = 0;
		const session = council(async () => { started.resolve(); return ready.promise; });
		const running = session.startInitialCritiques();
		await started.promise;
		session.dispose();
		ready.resolve({ async runTurn() { prompts++; return done(); }, async dispose() { disposed++; } });
		await running;
		expect(prompts).toBe(0);
		expect(disposed).toBe(1);
		await expect(session.askCouncil("Restart")).rejects.toThrow("disposed");
	});

	// a reviewer joining after the first round still needs the plan before it can inspect code
	it("seeds a first operator reply with the full plan", async () => {
		const prompts: string[] = [];
		const session = council(async () => ({
			async runTurn(prompt) { prompts.push(prompt); return done(); }, async dispose() {},
		}));
		try {
			await session.askCouncil("Check the imports");
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain("The complete plan");
			expect(prompts[0]).toContain("Check the imports");
		} finally { session.dispose(); }
	});

	// timeout cancellation must retain partial evidence and release the failed initial session
	it("retains partial evidence when the code inspection time limit expires", async () => {
		const timeout = new AbortController();
		const entered = Promise.withResolvers<void>();
		using clock = spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		const session = council(async () => ({
			async runTurn(_prompt, signal, onText) {
				onText("Partial source evidence");
				entered.resolve();
				await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				return { status: "aborted", text: "", inspection: { attempted: 1, failed: 0 } };
			},
			async dispose() {},
		}));
		try {
			const running = session.startInitialCritiques();
			await entered.promise;
			timeout.abort(new DOMException("Test time budget expired", "TimeoutError"));
			await running;
			const entry = session.entries.find(isReviewerTurnEntry);
			expect(entry?.status).toBe("aborted");
			expect(entry?.text).toBe("Partial source evidence");
			expect(entry?.errorMessage).toContain("120 second time limit");
			expect(session.isBusy()).toBe(false);
		} finally { session.dispose(); }
	});

	// the synthesizer must receive failed reviewer coverage and factual activity without claiming verification
	it("keeps incomplete reviewers and inspection limits in the synthesis input", async () => {
		const other: ReviewerMember = { ...reviewer, key: "council-test/other", label: "Other", model: { ...model, id: "other" } };
		let input = "";
		const session = new CouncilSession({
			planTitle: "Inspect a plan", planFilePath: "plan.md", planContent: "The complete plan",
			availableReviewers: [reviewer, other], initialReviewers: [reviewer, other],
			reviewerAgentFactory: async member => ({
				async runTurn() {
					if (member.key === other.key) return { status: "error", text: "", errorMessage: "Source unavailable", inspection: { attempted: 1, failed: 1 } };
					return done();
				},
				async dispose() {},
			}),
			// substitute synthesis inference while preserving its actual prompt construction
			streamFn: (requestModel, context) => {
				const content = context.messages[0]?.content;
				if (typeof content !== "string") throw new Error("Expected synthesis text input");
				input = content;
				const message: AssistantMessage = {
					role: "assistant", content: [{ type: "text", text: "Partial council findings" }],
					api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop", timestamp: Date.now(),
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message });
				return stream;
			},
		});
		try {
			await session.startInitialCritiques();
			await session.synthesizeFeedback(model);
			expect(input).toContain("tool counts describe attempts only");
			expect(input).toContain("Other: no completed latest review (error)");
			expect(input).toContain("source tool calls attempted 1, failed 0");
			expect(input).toContain("Not inspected or limits: other files");
		} finally { session.dispose(); }
	});
});
