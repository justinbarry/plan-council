import { describe, expect, it, setSystemTime } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { CodebaseReader, CodeReaderQueryInput } from "../src/code-reader";
import {
	CouncilSession,
	extractSessionGoalContext,
	isReviewerTurnEntry,
	type ModelStreamFn,
	READER_TARGET_KEY,
	type ReviewerTurnEntry,
} from "../src/council-session";
import { computeConvergence } from "../src/position";
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

type MockToolCall = { name: string; arguments: Record<string, unknown> };
type MockResponse = { text: string; stopReason?: "stop" | "error" | "aborted"; error?: string; toolCalls?: MockToolCall[] };

function makeMockStreamFn(
	responder: (model: Model, context: Context) => MockResponse | Promise<MockResponse>,
): { streamFn: ModelStreamFn; calls: Array<{ model: Model; context: Context; options: Parameters<ModelStreamFn>[2] }> } {
	const calls: Array<{ model: Model; context: Context; options: Parameters<ModelStreamFn>[2] }> = [];

	const streamFn: ModelStreamFn = (model, context, options) => {
		calls.push({ model, context, options });

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
				const toolCalls = (res.toolCalls ?? []).map((call, i) => ({
					type: "toolCall",
					id: `call-${i}`,
					name: call.name,
					arguments: call.arguments,
				}));
				return {
					role: "assistant",
					content: [{ type: "text", text: res.text }, ...toolCalls],
					stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
				} as unknown as AssistantMessage;
			},
		};
	};

	return { streamFn, calls };
}

type Stance = { id: string; stance: "agree" | "dispute"; reason?: string };

function reportPosition(verdict: string, revisions: string[] = [], positions: Stance[] = []): MockToolCall {
	return {
		name: "report_position",
		arguments: {
			verdict,
			revisions: revisions.map(summary => ({ summary })),
			positions: positions.map(p => ({ reason: "", ...p })),
		},
	};
}

function lastPrompt(context: Context): string {
	const last = context.messages[context.messages.length - 1];
	return last.role === "user" && typeof last.content === "string" ? last.content : "";
}

function isSynthesis(context: Context): boolean {
	return (context.systemPrompt?.[0] ?? "").includes("Synthesizer");
}

interface ScriptedTurn {
	/** 1 for critiques and operator replies, N for "Council Debate: Round N" */
	round: number;
	peerIds: string[];
	prompt: string;
}

/** reviewer turns answer with prose plus the scripted tool calls; synthesis answers with fixed revisions */
function scriptedCouncil(turn: (model: Model, t: ScriptedTurn) => MockToolCall[]): (model: Model, context: Context) => MockResponse {
	return (model, context) => {
		if (isSynthesis(context)) {
			return { text: "## Required Plan Revisions\n1. Synthesized result" };
		}
		const prompt = lastPrompt(context);
		const round = Number(prompt.match(/# Council Debate: Round (\d+)/)?.[1] ?? 1);
		const peerIds = [...prompt.matchAll(/^- `([^`]+)`: /gm)].map(m => m[1]);
		return { text: `Review from ${model.id} for round ${round}`, toolCalls: turn(model, { round, peerIds, prompt }) };
	};
}

function toolResultsIn(context: Context): ToolResultMessage[] {
	return context.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
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
			return { text: `Done by ${model.id}`, toolCalls: [reportPosition("APPROVE")] };
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
			return {
				text: `Rebuttal from ${model.id} replying to: ${content.includes("Council Debate") ? "debate" : "critique"}`,
				toolCalls: [reportPosition("APPROVE")],
			};
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
		const claudeDebateCall = calls.find(c => c.model.id === "claude-3-7-sonnet" && lastPrompt(c.context).includes("Council Debate"));
		expect(claudeDebateCall).toBeDefined();

		// Context has Round 1 user prompt, Round 1 Claude critique and its tool result, and Round 2 debate prompt
		expect(claudeDebateCall?.context.messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);

		const debatePrompt = lastPrompt(claudeDebateCall!.context);
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
		const { streamFn } = makeMockStreamFn(
			scriptedCouncil((model, { round, peerIds }) =>
				round === 1
					? [reportPosition("NEEDS REVISION", [`Fix raised by ${model.id}`])]
					: [reportPosition("APPROVE", [`Fix raised by ${model.id}`], peerIds.map(id => ({ id, stance: "agree" })))],
			),
		);

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
		expect(synth.text).toContain("Synthesized result");
	});
});

describe("report_position convergence", () => {
	const claude = makeFakeReviewer("anthropic", "claude-3-7-sonnet", "claude");
	const gpt = makeFakeReviewer("openai", "gpt-4o", "gpt");

	function newSession(streamFn: ModelStreamFn, reviewers: ReviewerMember[] = [claude, gpt]): CouncilSession {
		return new CouncilSession({
			planTitle: "Convergence Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: reviewers,
			initialReviewers: reviewers,
			streamFn,
		});
	}

	function reviewerEntry(session: CouncilSession, key: string, kind: ReviewerTurnEntry["kind"]): ReviewerTurnEntry {
		const entry = session.entries.filter((e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.reviewerKey === key && e.kind === kind).at(-1);
		if (!entry) throw new Error(`no ${kind} entry for ${key}`);
		return entry;
	}

	it("offers report_position on every reviewer turn and answers every tool call in history", async () => {
		const { streamFn, calls } = makeMockStreamFn(
			scriptedCouncil((model, { round, peerIds }) =>
				round === 1
					? [reportPosition("NEEDS REVISION", [`Fix raised by ${model.id}`]), { name: "web_search", arguments: {} }]
					: [reportPosition("APPROVE", [], peerIds.map(id => ({ id, stance: "agree" })))],
			),
		);
		const session = newSession(streamFn);

		await session.startInitialCritiques();
		await session.runDebateRound();
		await session.askCouncil("Anything else?");
		await session.synthesizeFeedback(claude.model);

		const reviewerCalls = calls.filter(c => !isSynthesis(c.context));
		expect(reviewerCalls).toHaveLength(6);
		for (const call of reviewerCalls) {
			expect(call.context.tools?.map(t => t.name)).toEqual(["report_position"]);
		}
		expect(calls.find(c => isSynthesis(c.context))?.context.tools).toBeUndefined();

		const claudeDebate = reviewerCalls.find(c => c.model === claude.model && lastPrompt(c.context).includes("Council Debate"));
		const results = toolResultsIn(claudeDebate!.context);
		expect(results.map(r => [r.toolCallId, r.toolName, r.isError])).toEqual([
			["call-0", "report_position", false],
			["call-1", "web_search", true],
		]);
		// results follow the assistant message that made the calls, before the next prompt
		const roles = claudeDebate!.context.messages.map(m => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "toolResult", "user"]);
		expect(reviewerEntry(session, claude.key, "critique").position?.revisions).toEqual([
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Fix raised by claude-3-7-sonnet" },
		]);
	});

	it("forces one report_position follow-up when a critique or rebuttal omits the report", async () => {
		const followUpMarker = "Call the `report_position` tool now";
		const { streamFn, calls } = makeMockStreamFn((model, context) => {
			const prompt = lastPrompt(context);
			if (prompt.includes(followUpMarker)) {
				return { text: "", toolCalls: [reportPosition("NEEDS REVISION", [`Fix raised by ${model.id}`])] };
			}
			return { text: `Review from ${model.id}` };
		});
		const session = newSession(streamFn);

		await session.startInitialCritiques();
		const claudeCalls = calls.filter(c => c.model === claude.model);
		expect(claudeCalls.map(c => c.options.toolChoice)).toEqual([undefined, { type: "function", name: "report_position" }]);
		const critique = reviewerEntry(session, claude.key, "critique");
		expect(critique.status).toBe("done");
		expect(critique.text).toBe("Review from claude-3-7-sonnet");
		expect(critique.position?.revisions.map(r => r.id)).toEqual(["anthropic/claude-3-7-sonnet#1"]);

		await session.runDebateRound();
		const claudeDebate = calls.find(c => c.model === claude.model && lastPrompt(c.context).includes("Council Debate"));
		// the forced exchange stays in history so its tool call keeps a paired result
		expect(claudeDebate!.context.messages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant", "toolResult", "user"]);
		expect(reviewerEntry(session, claude.key, "rebuttal").position?.revisions.map(r => r.id)).toEqual([
			"anthropic/claude-3-7-sonnet#1",
		]);
	});

	it("keeps a turn done without a position when report_position arguments stay invalid", async () => {
		const { streamFn, calls } = makeMockStreamFn(
			scriptedCouncil(model =>
				model === claude.model
					? [{ name: "report_position", arguments: { verdict: "MAYBE", revisions: [], positions: [] } }]
					: [reportPosition("APPROVE")],
			),
		);
		const session = newSession(streamFn);

		await session.startInitialCritiques();
		const critique = reviewerEntry(session, claude.key, "critique");
		expect(critique.status).toBe("done");
		expect(critique.position).toBeUndefined();
		expect(critique.positionError).toContain("verdict");
		expect(session.getConvergence().unreported).toEqual([claude.label]);
		// one forced retry, then the turn stands without a report
		expect(calls.filter(c => c.model === claude.model)).toHaveLength(2);

		await session.runDebateRound();
		const claudeDebate = calls.find(c => c.model === claude.model && lastPrompt(c.context).includes("Council Debate"));
		expect(toolResultsIn(claudeDebate!.context).map(r => r.isError)).toEqual([true, true]);
	});

	const stanceCases: Array<{
		name: string;
		stances: (peerIds: string[]) => Stance[];
		converged: boolean;
		disputes: number;
		uncovered: number;
	}> = [
		{ name: "disputes keep it open", stances: ids => ids.map(id => ({ id, stance: "dispute", reason: "unnecessary" })), converged: false, disputes: 2, uncovered: 0 },
		{ name: "agreement on every listed ID converges", stances: ids => ids.map(id => ({ id, stance: "agree" })), converged: true, disputes: 0, uncovered: 0 },
		{
			name: "stances on unlisted IDs are ignored",
			stances: ids => [...ids.map(id => ({ id, stance: "agree" as const })), { id: "someone/else#9", stance: "dispute", reason: "x" }],
			converged: true,
			disputes: 0,
			uncovered: 0,
		},
		{ name: "omitting a listed ID leaves it uncovered", stances: () => [], converged: false, disputes: 0, uncovered: 2 },
	];

	for (const c of stanceCases) {
		it(`scores debate stances on listed peer IDs: ${c.name}`, async () => {
			const { streamFn, calls } = makeMockStreamFn(
				scriptedCouncil((model, { round, peerIds }) =>
					round === 1
						? [reportPosition("NEEDS REVISION", [`Fix raised by ${model.id}`])]
						: [reportPosition("NEEDS REVISION", [`Fix raised by ${model.id}`], c.stances(peerIds))],
				),
			);
			const session = newSession(streamFn);

			await session.startInitialCritiques();
			await session.runDebateRound();

			const gptDebatePrompt = lastPrompt(calls.find(x => x.model === gpt.model && lastPrompt(x.context).includes("Council Debate"))!.context);
			expect(gptDebatePrompt).toContain("- `anthropic/claude-3-7-sonnet#1`: Fix raised by claude-3-7-sonnet");
			expect(gptDebatePrompt).not.toContain("openai/gpt-4o#1");

			const report = session.getConvergence();
			expect(report.converged).toBe(c.converged);
			expect(report.disputes).toHaveLength(c.disputes);
			expect(report.uncovered).toHaveLength(c.uncovered);
			if (c.disputes > 0) {
				expect(report.disputes).toContainEqual({ id: "anthropic/claude-3-7-sonnet#1", by: gpt.label, reason: "unnecessary" });
			}
			if (c.uncovered > 0) {
				expect(report.uncovered).toContainEqual({ id: "openai/gpt-4o#1", by: claude.label });
			}
		});
	}

	it("keeps peer items open until every other reviewer has been shown them", async () => {
		const { streamFn } = makeMockStreamFn(
			scriptedCouncil((model, { round, peerIds }) => {
				const revisions = [`Fix raised by ${model.id}`];
				// gpt adds a second required change during the first debate round
				if (model === gpt.model && round >= 2) revisions.push("Pin dependency versions");
				const positions = round === 1 ? [] : peerIds.map(id => ({ id, stance: "agree" as const }));
				return [reportPosition("NEEDS REVISION", revisions, positions)];
			}),
		);
		const session = newSession(streamFn);

		await session.startInitialCritiques();
		const afterCritiques = session.getConvergence();
		expect(afterCritiques.converged).toBe(false);
		expect(afterCritiques.uncovered).toEqual([
			{ id: "openai/gpt-4o#1", by: claude.label },
			{ id: "anthropic/claude-3-7-sonnet#1", by: gpt.label },
		]);

		await session.runDebateRound();
		const afterFirstDebate = session.getConvergence();
		expect(afterFirstDebate.disputes).toEqual([]);
		expect(afterFirstDebate.uncovered).toEqual([{ id: "openai/gpt-4o#2", by: claude.label }]);

		await session.runDebateRound();
		expect(session.getConvergence().converged).toBe(true);
	});

	it("ignores stances on peer items their owner dropped in the same round", () => {
		const report = computeConvergence([
			{
				label: "A",
				position: {
					verdict: "NEEDS REVISION",
					revisions: [{ id: "a#1", summary: "Redact headers" }],
					positions: [
						{ id: "b#1", stance: "agree", reason: "" },
						{ id: "b#2", stance: "dispute", reason: "not needed" },
					],
					promptedItemIds: ["b#1", "b#2"],
				},
			},
			// B listed b#2 last round and dropped it in this one
			{
				label: "B",
				position: {
					verdict: "NEEDS REVISION",
					revisions: [{ id: "b#1", summary: "Use middleware" }],
					positions: [{ id: "a#1", stance: "agree", reason: "" }],
					promptedItemIds: ["a#1"],
				},
			},
		]);
		expect(report.disputes).toEqual([]);
		expect(report.converged).toBe(true);
	});

	it("keeps the previous position when an operator reply makes no report", async () => {
		const { streamFn, calls } = makeMockStreamFn(
			scriptedCouncil((model, { round, peerIds, prompt }) => {
				if (prompt.includes("Operator Follow-up")) return [];
				return round === 1
					? [reportPosition("NEEDS REVISION", [`Fix raised by ${model.id}`])]
					: [reportPosition("NEEDS REVISION", [`Fix raised by ${model.id}`], peerIds.map(id => ({ id, stance: "agree" })))];
			}),
		);
		const session = newSession(streamFn);

		await session.startInitialCritiques();
		await session.runDebateRound();
		const callsBeforeReply = calls.length;
		await session.askCouncil("@claude Clarify step 2");
		// replies report only when something changed, so no forced follow-up
		expect(calls.length).toBe(callsBeforeReply + 1);

		expect(reviewerEntry(session, claude.key, "reply").status).toBe("done");
		const report = session.getConvergence();
		expect(report.converged).toBe(true);
		expect(report.items.map(i => i.id)).toEqual(["anthropic/claude-3-7-sonnet#1", "openai/gpt-4o#1"]);
	});

	async function runAuto(
		turn: (model: Model, t: ScriptedTurn) => MockToolCall[],
		options: { autoDebate?: boolean; maxDebateRounds?: number } = {},
	) {
		const { streamFn, calls } = makeMockStreamFn(scriptedCouncil(turn));
		const session = newSession(streamFn);
		const stages: string[] = [];
		const synth = await session.runAutoPipeline(claude.model, { ...options, onStageChange: s => stages.push(s) });
		const synthPrompt = lastPrompt(calls.find(c => isSynthesis(c.context))!.context);
		return { session, stages, synth, synthPrompt };
	}

	it("gives the synthesizer a reviewer's reported revisions even when its turns have no prose", async () => {
		const turn = scriptedCouncil((model, { peerIds }) => {
			const positions = peerIds.map(id => ({ id, stance: "agree" as const }));
			return model === claude.model
				? [reportPosition("NEEDS REVISION", ["Add a rollback step"], positions)]
				: [reportPosition("APPROVE", [], positions)];
		});
		const { streamFn, calls } = makeMockStreamFn((model, context) => {
			const res = turn(model, context);
			return model === claude.model && !isSynthesis(context) ? { ...res, text: "" } : res;
		});
		const session = newSession(streamFn);

		await session.runAutoPipeline(claude.model);

		expect(session.getConvergence().converged).toBe(true);
		const synthPrompt = lastPrompt(calls.find(c => isSynthesis(c.context))!.context);
		expect(synthPrompt).not.toContain(`### ${claude.label} (Round`);
		expect(synthPrompt).toContain(
			`### Reported Positions\n- ${claude.label}: NEEDS REVISION\n  - \`anthropic/claude-3-7-sonnet#1\`: Add a rollback step\n- ${gpt.label}: APPROVE, no required revisions`,
		);
	});

	it("convergence: auto mode debates until reviewers stop disputing, then synthesizes", async () => {
		const { session, stages, synth, synthPrompt } = await runAuto((model, { round, peerIds }) => {
			const revisions = [`Fix raised by ${model.id}`];
			if (round === 1) return [reportPosition("NEEDS REVISION", revisions)];
			const stance = round === 2 ? "dispute" : "agree";
			return [reportPosition("NEEDS REVISION", revisions, peerIds.map(id => ({ id, stance, reason: "not needed" })))];
		});

		expect(stages).toEqual(["Round 1 Critiques", "Round 2 Debate", "Round 3 Debate", "Synthesizing Consensus"]);
		expect(session.round).toBe(3);
		expect(session.getConvergence().converged).toBe(true);
		expect(synth.status).toBe("done");
		expect(synthPrompt).toContain("### Convergence\nAll reviewers reported agreement on every listed revision.");
	});

	it("skips debate when every reviewer approves with no revisions", async () => {
		const { stages } = await runAuto(() => [reportPosition("APPROVE")]);
		expect(stages).toEqual(["Round 1 Critiques", "Synthesizing Consensus"]);
	});

	it("stops at maxDebateRounds while disputes remain and tells the synthesizer what is contested", async () => {
		const { session, stages, synthPrompt } = await runAuto(
			(model, { peerIds }) => [
				reportPosition("BLOCK", [`Fix raised by ${model.id}`], peerIds.map(id => ({ id, stance: "dispute", reason: "wrong approach" }))),
			],
			{ maxDebateRounds: 2 },
		);

		expect(stages).toEqual(["Round 1 Critiques", "Round 2 Debate", "Round 3 Debate", "Synthesizing Consensus"]);
		expect(session.round).toBe(3);
		expect(synthPrompt).toContain(
			`- anthropic/claude-3-7-sonnet#1 ("Fix raised by claude-3-7-sonnet") disputed by ${gpt.label}: wrong approach`,
		);
	});

	it("stops the whole auto run when the active round is aborted mid-debate", async () => {
		const turn = scriptedCouncil((model, { peerIds }) => [
			reportPosition("BLOCK", [`Fix raised by ${model.id}`], peerIds.map(id => ({ id, stance: "dispute", reason: "no" }))),
		]);
		const { streamFn, calls } = makeMockStreamFn(async (model, context) => {
			await Bun.sleep(20);
			return turn(model, context);
		});
		const session = newSession(streamFn);
		const stages: string[] = [];
		// what herdr is told: the council stays active between stages and stops being active on stop
		const activeAfterStage: boolean[] = [];
		let activeAfterStop: boolean | undefined;

		const run = session.runAutoPipeline(claude.model, {
			onStageChange: stage => {
				stages.push(stage);
				activeAfterStage.push(session.isActive());
				// what Esc, `x`, approve, and plan-review resolution do while a debate streams
				if (stage === "Round 2 Debate") {
					setTimeout(() => {
						session.abortActiveRound();
						activeAfterStop = session.isActive();
					}, 5);
				}
			},
		});

		await expect(run).rejects.toThrow("Auto council stopped.");
		await Bun.sleep(50);
		expect(stages).toEqual(["Round 1 Critiques", "Round 2 Debate"]);
		expect(calls.some(c => isSynthesis(c.context) || lastPrompt(c.context).includes("Council Debate: Round 3"))).toBe(false);
		expect(session.isBusy()).toBe(false);
		expect(activeAfterStage).toEqual([true, true]);
		expect(activeAfterStop).toBe(false);
	});

	it("keeps a round started right after a stop stoppable when the stopped round settles late", async () => {
		const { streamFn, calls } = makeMockStreamFn(async (_model, context) => {
			// the stopped round's requests (calls 0-1) settle quickly after the stop; the restarted round's run long
			await Bun.sleep(calls.findIndex(c => c.context === context) < 2 ? 15 : 200);
			return { text: "review", toolCalls: [reportPosition("APPROVE")] };
		});
		const session = newSession(streamFn);

		const stopped = session.startInitialCritiques();
		await Bun.sleep(5);
		session.abortActiveRound();
		const restarted = session.startInitialCritiques();
		await stopped;

		// the stopped round's cleanup must not release the restarted one
		expect(session.isBusy()).toBe(true);
		session.abortActiveRound();
		await restarted;
		expect(calls.slice(2).map(c => c.options.signal.aborted)).toEqual([true, true]);
		expect(session.isBusy()).toBe(false);
	});

	it("never debates when autoDebate is false", async () => {
		const { stages } = await runAuto(model => [reportPosition("BLOCK", [`Fix raised by ${model.id}`])], { autoDebate: false });
		expect(stages).toEqual(["Round 1 Critiques", "Synthesizing Consensus"]);
	});

	it("debates to the default cap when a reviewer never reports", async () => {
		const { stages, synthPrompt } = await runAuto((model, { peerIds }) =>
			model === claude.model ? [] : [reportPosition("APPROVE", [], peerIds.map(id => ({ id, stance: "agree" })))],
		);
		expect(stages).toEqual([
			"Round 1 Critiques",
			"Round 2 Debate",
			"Round 3 Debate",
			"Round 4 Debate",
			"Synthesizing Consensus",
		]);
		expect(synthPrompt).toContain(`- No position reported: ${claude.label}`);
	});
});

interface FakeReader {
	reader: CodebaseReader;
	queries: CodeReaderQueryInput[];
}

/** reports queued → reading → grep like the real reader, then answers; a rejected answer is a reader failure */
function makeFakeReader(answer: (input: CodeReaderQueryInput) => string | Promise<string> = input => `Reader: ${input.question}`): FakeReader {
	const queries: CodeReaderQueryInput[] = [];
	const reader: CodebaseReader = {
		modelLabel: "smol-reader (test)",
		async query(input) {
			queries.push(input);
			input.onStatusChange?.("queued");
			input.onStatusChange?.("reading");
			input.onToolActivity?.("grep");
			const text = await answer(input);
			input.onTextDelta?.(text, text);
			return { answer: text, cached: false };
		},
		dispose: () => {},
	};
	return { reader, queries };
}

/** messages after the turn's prompt: the reviewer's earlier steps in this turn and their tool results */
function turnSteps(context: Context): Context["messages"] {
	return context.messages.slice(context.messages.findLastIndex(m => m.role === "user") + 1);
}

function readerAnswered(context: Context): boolean {
	return turnSteps(context).some(m => m.role === "toolResult" && m.toolName === "ask_codebase");
}

describe("codebase reader", () => {
	const claude = makeFakeReviewer("anthropic", "claude-3-7-sonnet", "claude");
	const gpt = makeFakeReviewer("openai", "gpt-4o", "gpt");

	function newSession(streamFn: ModelStreamFn, codeReader: CodebaseReader | undefined, extra: { maxReaderQueriesPerTurn?: number; reviewers?: ReviewerMember[] } = {}) {
		const reviewers = extra.reviewers ?? [claude, gpt];
		return new CouncilSession({
			planTitle: "Reader Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: reviewers,
			initialReviewers: reviewers,
			streamFn,
			codeReader,
			maxReaderQueriesPerTurn: extra.maxReaderQueriesPerTurn,
		});
	}

	function critiqueOf(session: CouncilSession, key: string): ReviewerTurnEntry {
		const entry = session.entries.find((e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.reviewerKey === key && e.kind === "critique");
		if (!entry) throw new Error(`no critique for ${key}`);
		return entry;
	}

	it("lets a reviewer verify code before reporting and keeps the exchange in its history", async () => {
		const { reader, queries } = makeFakeReader();
		const { streamFn, calls } = makeMockStreamFn((model, context) => {
			if (!readerAnswered(context)) {
				return {
					text: `Checking ${model.id}.`,
					toolCalls: [{ name: "ask_codebase", arguments: { question: `Where is ${model.id} used?`, paths: ["src/index.ts"] } }],
				};
			}
			return { text: `Grounded review from ${model.id}`, toolCalls: [reportPosition("NEEDS REVISION", [`Fix raised by ${model.id}`])] };
		});
		const session = newSession(streamFn, reader);

		await session.startInitialCritiques();

		const critique = critiqueOf(session, claude.key);
		expect(critique.status).toBe("done");
		expect(critique.readerQueryCount).toBe(1);
		expect(critique.readerStatus).toBeUndefined();
		expect(critique.text).toBe("Checking claude-3-7-sonnet.\n\nGrounded review from claude-3-7-sonnet");
		expect(critique.position?.revisions.map(r => r.summary)).toEqual(["Fix raised by claude-3-7-sonnet"]);

		const claudeCalls = calls.filter(c => c.model === claude.model);
		expect(claudeCalls).toHaveLength(2);
		expect(claudeCalls[0].context.systemPrompt?.[0]).toContain("`ask_codebase` tool (up to 3 calls per turn)");
		expect(claudeCalls[1].context.tools?.map(t => t.name)).toEqual(["ask_codebase", "report_position"]);
		expect(claudeCalls[1].context.messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(toolResultsIn(claudeCalls[1].context)).toMatchObject([
			{ toolName: "ask_codebase", isError: false, content: [{ type: "text", text: "Reader: Where is claude-3-7-sonnet used?" }] },
		]);

		expect(queries.map(q => q.requesterLabel).sort()).toEqual([claude.label, gpt.label].sort());
		expect(session.readerEntries.find(r => r.requesterKey === claude.key)).toMatchObject({
			requesterKind: "reviewer",
			requesterLabel: claude.label,
			round: 1,
			question: "Where is claude-3-7-sonnet used?",
			paths: ["src/index.ts"],
			status: "done",
			answer: "Reader: Where is claude-3-7-sonnet used?",
		});

		await session.runDebateRound();
		const claudeDebate = calls.find(c => c.model === claude.model && lastPrompt(c.context).includes("Council Debate"));
		// the reader exchange stays in history so later rounds keep the evidence and every call keeps its result
		expect(claudeDebate!.context.messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult", "assistant", "toolResult", "user"]);
	});

	it("caps reader queries per turn, answers every extra call, then offers only report_position", async () => {
		const { reader, queries } = makeFakeReader();
		const ask = (n: number): MockToolCall => ({ name: "ask_codebase", arguments: { question: `check ${n}` } });
		const { streamFn, calls } = makeMockStreamFn((_model, context) =>
			context.tools?.some(t => t.name === "ask_codebase")
				? { text: "Looking.", toolCalls: [ask(1), ask(2), ask(3)] }
				: { text: "Review", toolCalls: [reportPosition("APPROVE")] },
		);
		const session = newSession(streamFn, reader, { reviewers: [claude], maxReaderQueriesPerTurn: 2 });

		await session.startInitialCritiques();

		expect(queries.map(q => q.question)).toEqual(["check 1", "check 2"]);
		expect(calls).toHaveLength(2);
		expect(calls[1].context.tools?.map(t => t.name)).toEqual(["report_position"]);
		const results = toolResultsIn(calls[1].context);
		expect(results.map(r => r.isError)).toEqual([false, false, true]);
		expect(results[2].content).toEqual([
			{
				type: "text",
				text: "Codebase reader query limit (2) reached for this turn. Write your review and call report_position using the evidence gathered so far.",
			},
		]);
		const critique = critiqueOf(session, claude.key);
		expect([critique.status, critique.readerQueryCount, critique.position?.verdict]).toEqual(["done", 2, "APPROVE"]);
	});

	it("turns a reader failure into an error tool result and still completes the review", async () => {
		const { reader } = makeFakeReader(() => Promise.reject(new Error("reader crashed")));
		const { streamFn, calls } = makeMockStreamFn((_model, context) =>
			readerAnswered(context)
				? { text: "Review from the plan text", toolCalls: [reportPosition("NEEDS REVISION", ["Verify the entry point"])] }
				: { text: "", toolCalls: [{ name: "ask_codebase", arguments: { question: "entry point?" } }] },
		);
		const session = newSession(streamFn, reader, { reviewers: [claude] });

		await session.startInitialCritiques();

		const critique = critiqueOf(session, claude.key);
		expect(critique.status).toBe("done");
		expect(critique.position?.verdict).toBe("NEEDS REVISION");
		const [result] = toolResultsIn(calls[1].context);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Codebase reader error: reader crashed. Continue your review from the plan text and note any unverified codebase assumptions.",
			},
		]);
		expect(session.readerEntries).toMatchObject([{ status: "error", errorMessage: "reader crashed" }]);
	});

	it("stops a reviewer waiting on the reader when the round is aborted", async () => {
		const started = Promise.withResolvers<void>();
		const { reader } = makeFakeReader(input => {
			started.resolve();
			const { promise, reject } = Promise.withResolvers<string>();
			input.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
			return promise;
		});
		const { streamFn, calls } = makeMockStreamFn(() => ({ text: "", toolCalls: [{ name: "ask_codebase", arguments: { question: "slow?" } }] }));
		const session = newSession(streamFn, reader, { reviewers: [claude] });

		const critiques = session.startInitialCritiques();
		await started.promise;
		expect(critiqueOf(session, claude.key).readerStatus).toBe("reading");
		session.abortActiveRound();
		await critiques;

		const critique = critiqueOf(session, claude.key);
		expect([critique.status, critique.readerStatus]).toEqual(["aborted", undefined]);
		expect(session.readerEntries.map(r => r.status)).toEqual(["aborted"]);
		expect(calls).toHaveLength(1);
		expect(session.isBusy()).toBe(false);
	});

	it("routes operator reader questions to the reader and feeds the answers into the next debate", async () => {
		const { reader, queries } = makeFakeReader(input => `Answer: ${input.question}`);
		const { streamFn, calls } = makeMockStreamFn(
			scriptedCouncil((model, { peerIds }) => [reportPosition("NEEDS REVISION", [`Fix raised by ${model.id}`], peerIds.map(id => ({ id, stance: "agree" })))]),
		);
		const session = newSession(streamFn, reader);

		await session.startInitialCritiques();
		const reviewerCalls = calls.length;
		// operator notes count only when posted after the reviewer's last turn finished
		setSystemTime(new Date(Date.now() + 60_000));
		try {
			await session.askCouncil("@reader Where is resolvePlanReview called?");
			await session.askCouncil("@scout Which tests cover it?");
			await session.askCouncil("And the overlay?", READER_TARGET_KEY);
		} finally {
			setSystemTime();
		}

		expect(calls).toHaveLength(reviewerCalls);
		expect(session.entries.some(e => e.kind === "user")).toBe(false);
		expect(queries.map(q => [q.requesterLabel, q.question])).toEqual([
			["Operator", "Where is resolvePlanReview called?"],
			["Operator", "Which tests cover it?"],
			["Operator", "And the overlay?"],
		]);
		expect(session.readerEntries.map(r => [r.requesterKind, r.status])).toEqual([
			["operator", "done"],
			["operator", "done"],
			["operator", "done"],
		]);

		await session.runDebateRound();
		const debatePrompt = lastPrompt(calls.find(c => c.model === claude.model && lastPrompt(c.context).includes("Council Debate"))!.context);
		expect(debatePrompt).toContain(
			"[Operator → Reader]: Where is resolvePlanReview called?\n[Reader]: Answer: Where is resolvePlanReview called?",
		);
		expect(debatePrompt).toContain("[Operator → Reader]: And the overlay?\n[Reader]: Answer: And the overlay?");
	});

	it("rejects reader questions when no reader is configured", async () => {
		const { streamFn, calls } = makeMockStreamFn(() => ({ text: "review" }));
		const session = newSession(streamFn, undefined);

		await expect(session.askCouncil("@reader Where is X?")).rejects.toThrow("Codebase reader is disabled or unavailable.");
		await expect(session.askCouncil("Where is X?", READER_TARGET_KEY)).rejects.toThrow("Codebase reader is disabled or unavailable.");
		expect(calls).toHaveLength(0);
		expect(session.isBusy()).toBe(false);
	});
});
