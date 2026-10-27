import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { CouncilSession, extractSessionGoalContext, isReviewerTurnEntry, type ModelStreamFn, type ReviewerTurnEntry } from "../src/council-session";
import type { ReviewerMember } from "../src/models";

function makeFakeReviewer(provider: string, id: string, family: string): ReviewerMember {
	const model: Model = {
		id,
		provider,
		name: `${id} model`,
		description: "fake model",
		contextWindow: 128000,
		maxTokens: 4096,
		thinking: false,
		identity: {
			family,
			class: family,
			archetype: family,
			vendor: provider,
		},
	} as unknown as Model;

	return {
		key: `${provider}/${id}`,
		label: `${id} (${provider})`,
		family,
		model,
	};
}

function makeMockStreamFn(
	responder: (
		model: Model,
		context: Context,
	) => { text: string; stopReason?: "stop" | "error" | "aborted"; error?: string } | Promise<{
		text: string;
		stopReason?: "stop" | "error" | "aborted";
		error?: string;
	}>,
): { streamFn: ModelStreamFn; calls: Array<{ model: Model; context: Context }> } {
	const calls: Array<{ model: Model; context: Context }> = [];

	const streamFn: ModelStreamFn = (model, context, options) => {
		calls.push({ model, context });

		async function* generate(): AsyncIterable<AssistantMessageEvent> {
			const res = await responder(model, context);
			if (options.signal.aborted) {
				return;
			}
			const chunks = res.text.split(" ");
			for (let i = 0; i < chunks.length; i++) {
				if (options.signal.aborted) return;
				yield {
					type: "text_delta",
					delta: (i > 0 ? " " : "") + chunks[i],
				} as unknown as AssistantMessageEvent;
			}
		}

		const generator = generate();

		return {
			[Symbol.asyncIterator]() {
				return generator[Symbol.asyncIterator]();
			},
			async result(): Promise<AssistantMessage> {
				const res = await responder(model, context);
				if (options.signal.aborted || res.stopReason === "aborted") {
					return {
						role: "assistant",
						content: [],
						stopReason: "aborted",
					} as unknown as AssistantMessage;
				}
				if (res.stopReason === "error") {
					return {
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: res.error || "Simulated failure",
					} as unknown as AssistantMessage;
				}
				return {
					role: "assistant",
					content: [{ type: "text", text: res.text }],
					stopReason: "stop",
				} as unknown as AssistantMessage;
			},
		};
	};

	return { streamFn, calls };
}

describe("extractSessionGoalContext", () => {
	it("extracts and formats user messages from session branch entries", () => {
		const entries: SessionEntry[] = [
			{
				type: "session",
				id: "s1",
				parentId: null,
				timestamp: new Date().toISOString(),
				cwd: "/workspace",
			} as unknown as SessionEntry,
			{
				type: "message",
				id: "m1",
				parentId: "s1",
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					content: "Please build feature X with \t tabs and <special> symbols.",
				},
			} as unknown as SessionEntry,
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Working on it" }],
				},
			} as unknown as SessionEntry,
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					content: [{ type: "text", text: "Also check error handling." }],
				},
			} as unknown as SessionEntry,
		];

		const context = extractSessionGoalContext(entries, 500);
		expect(context).toBeDefined();
		expect(context).toContain("tabs and <special> symbols.");
		expect(context).not.toContain("\t");
		expect(context).toContain("Also check error handling.");
		expect(context).not.toContain("Working on it");
	});

	it("truncates if content exceeds maxChars", () => {
		const longPrompt = "a".repeat(100);
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					content: longPrompt,
				},
			} as unknown as SessionEntry,
		];

		const context = extractSessionGoalContext(entries, 50);
		expect(context).toHaveLength(51); // 50 chars + "…"
		expect(context?.endsWith("…")).toBe(true);
	});
});

describe("CouncilSession", () => {
	const claude = makeFakeReviewer("anthropic", "claude-3-7-sonnet", "claude");
	const gpt = makeFakeReviewer("openai", "gpt-4o", "gpt");
	const gemini = makeFakeReviewer("google", "gemini-2.5-pro", "gemini");

	it("runs Round 1 initial critiques in parallel with failure isolation", async () => {
		const { streamFn } = makeMockStreamFn((model) => {
			if (model.id === "gpt-4o") {
				return { text: "", stopReason: "error", error: "Rate limit exceeded" };
			}
			return { text: `Critique by ${model.id}: approve with minor notes.` };
		});

		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "# Plan\n1. Do thing",
			availableReviewers: [claude, gpt, gemini],
			initialReviewers: [claude, gpt, gemini],
			streamFn,
		});

		expect(session.round).toBe(0);
		await session.startInitialCritiques();

		expect(session.round).toBe(1);
		expect(session.entries).toHaveLength(3);

		const claudeEntry = session.entries.find((e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.reviewerKey === claude.key);
		const gptEntry = session.entries.find((e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.reviewerKey === gpt.key);
		const geminiEntry = session.entries.find((e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.reviewerKey === gemini.key);

		expect(claudeEntry?.status).toBe("done");
		expect(claudeEntry?.text).toContain("Critique by claude-3-7-sonnet");

		expect(gptEntry?.status).toBe("error");
		expect(gptEntry?.errorMessage).toBe("Rate limit exceeded");

		expect(geminiEntry?.status).toBe("done");
		expect(geminiEntry?.text).toContain("Critique by gemini-2.5-pro");
	});

	it("retry skips already-done models in Round 1", async () => {
		let gptFailedOnce = true;
		const { streamFn, calls } = makeMockStreamFn((model) => {
			if (model.id === "gpt-4o" && gptFailedOnce) {
				return { text: "", stopReason: "error", error: "Flaky network" };
			}
			return { text: `Done by ${model.id}` };
		});

		const session = new CouncilSession({
			planTitle: "Test Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude, gpt],
			initialReviewers: [claude, gpt],
			streamFn,
		});

		await session.startInitialCritiques();
		expect(calls).toHaveLength(2);

		const gptEntry1 = session.entries.find((e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.reviewerKey === gpt.key);
		expect(gptEntry1?.status).toBe("error");

		// Retry
		gptFailedOnce = false;
		await session.startInitialCritiques();

		// Claude should not have been called a second time
		expect(calls).toHaveLength(3); // 2 from first round + 1 retry for GPT
		const completedGpt = session.entries.filter((e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.reviewerKey === gpt.key && e.status === "done");
		expect(completedGpt).toHaveLength(1);
	});

	it("runs Round 2 debate passing peer critiques and preserving history", async () => {
		const { streamFn, calls } = makeMockStreamFn((model, context) => {
			const userMsg = context.messages[context.messages.length - 1];
			const content = typeof userMsg.content === "string" ? userMsg.content : "";
			return { text: `Rebuttal from ${model.id} replying to: ${content.includes("Council Debate") ? "debate" : "critique"}` };
		});

		const session = new CouncilSession({
			planTitle: "Debate Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude, gpt],
			initialReviewers: [claude, gpt],
			streamFn,
		});

		await session.startInitialCritiques();
		expect(session.round).toBe(1);

		await session.runDebateRound();
		expect(session.round).toBe(2);

		// Check the debate call for Claude
		const claudeDebateCall = calls.find(
			(c) => c.model.id === "claude-3-7-sonnet" && c.context.messages.length === 3,
		);
		expect(claudeDebateCall).toBeDefined();

		// Context has Round 1 user prompt, Round 1 Claude critique, and Round 2 debate prompt
		expect(claudeDebateCall?.context.messages[0].role).toBe("user");
		expect(claudeDebateCall?.context.messages[1].role).toBe("assistant");
		expect(claudeDebateCall?.context.messages[2].role).toBe("user");

		const debatePrompt = String(claudeDebateCall?.context.messages[2].content);
		// Peer critique from GPT should be in Claude's prompt
		expect(debatePrompt).toContain("Critique from gpt-4o (openai)");
		// But Claude's own critique should not be framed as a peer critique in Claude's prompt
		expect(debatePrompt).not.toContain("Critique from claude-3-7-sonnet");
	});

	it("handles targeted @mention vs broadcast askCouncil", async () => {
		const { streamFn, calls } = makeMockStreamFn((model) => {
			return { text: `Answer from ${model.id}` };
		});

		const session = new CouncilSession({
			planTitle: "QA Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude, gpt],
			initialReviewers: [claude, gpt],
			streamFn,
		});

		await session.startInitialCritiques();
		const callsBefore = calls.length;

		// Targeted question to Claude
		await session.askCouncil("@claude How does step 3 scale?");
		expect(calls.length).toBe(callsBefore + 1);
		expect(calls[calls.length - 1].model.id).toBe("claude-3-7-sonnet");

		const userEntry = session.entries.find((e) => e.kind === "user" && e.text.includes("How does step 3 scale?"));
		expect(userEntry).toBeDefined();
		if (userEntry && userEntry.kind === "user") {
			expect(userEntry.targetReviewerKey).toBe(claude.key);
		}

		// Broadcast question
		await session.askCouncil("General question for everyone");
		expect(calls.length).toBe(callsBefore + 1 + 2); // Claude and GPT both called
	});

	it("synthesizes feedback preserving verbatim plan and operator comments", async () => {
		const { streamFn } = makeMockStreamFn((_model, context) => {
			const userMsg = context.messages[0];
			const content = typeof userMsg.content === "string" ? userMsg.content : "";
			expect(content).toContain("original -> code fence: ```ts");
			expect(content).toContain("Operator instruction with -> arrow");
			return { text: "## Required Plan Revisions\n1. Use proper typing\n## Agreed Keepers / Non-Changes\n- Keep caching" };
		});

		const session = new CouncilSession({
			planTitle: "Synthesize Plan",
			planFilePath: "plan.md",
			planContent: "original -> code fence: ```ts\nconst x = 1;\n```",
			availableReviewers: [claude],
			initialReviewers: [claude],
			streamFn,
		});

		await session.startInitialCritiques();
		await session.askCouncil("Operator instruction with -> arrow");

		const synthResult = await session.synthesizeFeedback(claude.model);
		expect(synthResult.status).toBe("done");
		expect(synthResult.text).toContain("## Required Plan Revisions");
		expect(session.latestSynthesis?.text).toBe(synthResult.text);
	});

	it("runs full autonomous pipeline without manual coaxing", async () => {
		const stages: string[] = [];
		const { streamFn } = makeMockStreamFn((model, context) => {
			const sys = context.systemPrompt?.[0] ?? "";
			if (sys.includes("Synthesizer")) {
				return { text: "## Required Plan Revisions\n1. Autonomous synthesized result" };
			}
			const last = context.messages[context.messages.length - 1];
			const content = String(last.content);
			if (content.includes("Council Debate")) {
				return { text: `Rebuttal from ${model.id}: agreed` };
			}
			return { text: `Critique from ${model.id}: ### Verdict\nNEEDS REVISION` };
		});

		const session = new CouncilSession({
			planTitle: "Auto Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude, gpt],
			initialReviewers: [claude, gpt],
			streamFn,
		});

		const synth = await session.runAutoPipeline(claude.model, {
			autoDebate: true,
			onStageChange: s => stages.push(s),
		});

		expect(stages).toEqual(["Round 1 Critiques", "Round 2 Debate", "Synthesizing Consensus"]);
		expect(session.round).toBe(2);
		expect(synth.status).toBe("done");
		expect(synth.text).toContain("Autonomous synthesized result");
	});
});
