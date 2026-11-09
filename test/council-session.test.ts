import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { CodebaseReader, CodeReaderQueryInput } from "../src/code-reader";
import {
	CouncilSession,
	extractSessionGoalContext,
	isReviewerTurnEntry,
	OperatorQuestionPending,
	type ModelStreamFn,
	READER_TARGET_KEY,
	type ReviewerTurnEntry,
} from "../src/council-session";
import {
	computeConvergence,
	computePositionDelta,
	isEmptyPositionDelta,
	type ReviewerPosition,
	stabilizeRevisionIds,
	validateReportedPosition,
} from "../src/position";
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

/** a report_position call with extra arguments, e.g. `nextSpeaker` or `questionForOperator` */
function withReportFields(call: MockToolCall, fields: Record<string, unknown>): MockToolCall {
	return { ...call, arguments: { ...call.arguments, ...fields } };
}

/** resolve once the session goes idle, e.g. after the reply pass it runs for a queued operator message */
function settle(session: CouncilSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(() => {
		if (session.isBusy()) return;
		unsubscribe();
		resolve();
	});
	if (!session.isBusy()) {
		unsubscribe();
		resolve();
	}
	return promise;
}

const FORCED_REPORT_MARKER = "Call the `report_position` tool now";

/** the turn's own prompt: skips tool results of earlier steps and a forced report_position follow-up */
function turnPrompt(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const m = context.messages[i];
		if (m.role === "user" && typeof m.content === "string" && !m.content.startsWith(FORCED_REPORT_MARKER)) return m.content;
	}
	return "";
}

function debateRound(context: Context): number | undefined {
	const match = turnPrompt(context).match(/# Council Debate: Round (\d+)/);
	return match ? Number(match[1]) : undefined;
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
		const prompt = turnPrompt(context);
		const round = debateRound(context) ?? 1;
		const peerIds = [...prompt.matchAll(/^- `([^`]+)`: /gm)].map(m => m[1]);
		return { text: `Review from ${model.id} for round ${round}`, toolCalls: turn(model, { round, peerIds, prompt }) };
	};
}

function toolResultsIn(context: Context): ToolResultMessage[] {
	return context.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
}

describe("position deltas and report_position extras", () => {
	const position = (verdict: ReviewerPosition["verdict"], revisionIds: string[], stances: Stance[]): ReviewerPosition => ({
		verdict,
		revisions: revisionIds.map(id => ({ id, summary: `Summary of ${id}` })),
		positions: stances.map(p => ({ reason: "", ...p })),
		promptedItemIds: stances.map(p => p.id),
	});

	it("reports a verdict change, revisions by ID, and peer items newly agreed or disputed", () => {
		const previous = position("NEEDS REVISION", ["a#1", "a#2"], [{ id: "b#1", stance: "agree" }]);
		const next = position("APPROVE", ["a#2", "a#3"], [
			{ id: "b#1", stance: "dispute" },
			{ id: "c#1", stance: "agree" },
		]);
		expect(computePositionDelta(previous, next)).toEqual({
			verdictFrom: "NEEDS REVISION",
			added: [{ id: "a#3", summary: "Summary of a#3" }],
			dropped: [{ id: "a#1", summary: "Summary of a#1" }],
			agreed: ["c#1"],
			disputed: ["b#1"],
		});
		expect(isEmptyPositionDelta(computePositionDelta(previous, previous))).toBe(true);
	});

	const reportCall = (extra: Record<string, unknown>) =>
		({
			type: "toolCall",
			id: "call-0",
			name: "report_position",
			arguments: { verdict: "APPROVE", revisions: [], positions: [], ...extra },
		}) as ToolCall;

	it("trims the handoff and the operator question and strips the handle's @", () => {
		const reported = validateReportedPosition(
			reportCall({ nextSpeaker: "  @gemini-2.5-pro  ", questionForOperator: "  Bound retries?  " }),
			"a",
			[],
		);
		expect(reported.nextSpeaker).toBe("gemini-2.5-pro");
		expect(reported.operatorQuestion).toBe("Bound retries?");
	});

	it("leaves the handoff and question keys out when omitted or blank", () => {
		for (const extra of [{}, { nextSpeaker: "  @ ", questionForOperator: "   " }]) {
			const reported = validateReportedPosition(reportCall(extra), "a", []);
			expect("nextSpeaker" in reported).toBe(false);
			expect("operatorQuestion" in reported).toBe(false);
		}
	});
});

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

	it("seeds every reviewer, including late joiners, with the attached file excerpts", async () => {
		const { streamFn, calls } = makeMockStreamFn(model => ({ text: `Answer from ${model.id}`, toolCalls: [reportPosition("APPROVE")] }));
		const session = new CouncilSession({
			planTitle: "Files Plan",
			planFilePath: "plan.md",
			planContent: "Edit src/a.ts",
			availableReviewers: [claude, gpt, gemini],
			initialReviewers: [claude],
			streamFn,
			referencedFiles: [{ path: "src/a.ts", rangeLabel: "line 1", excerptBlock: "```ts\n1: export const a = 1;\n```" }],
		});
		const firstPrompt = (model: Model) => {
			const first = calls.find(c => c.model === model)!.context.messages[0];
			return first.role === "user" && typeof first.content === "string" ? first.content : "";
		};
		const attachedSection = "## Referenced Repository Files";

		await session.startInitialCritiques();
		expect(firstPrompt(claude.model)).toContain(attachedSection);

		// gemini joins before an operator question, gpt before a debate round
		session.setReviewers([claude.key, gemini.key]);
		await session.askCouncil("@gemini Is step 1 safe?");
		session.setReviewers([claude.key, gemini.key, gpt.key]);
		await session.runDebateRound();

		for (const reviewer of [gpt, gemini]) {
			expect(firstPrompt(reviewer.model)).toContain(attachedSection);
			expect(firstPrompt(reviewer.model)).toContain("### `src/a.ts` (line 1)\n```ts\n1: export const a = 1;\n```");
		}
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
		// claude's Round 2 agreement settles every held revision, so gpt's Round 2 turn is skipped
		expect(reviewerCalls).toHaveLength(5);
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

	it("keeps a revision's ID through a round that failed to report", async () => {
		const { streamFn } = makeMockStreamFn(
			scriptedCouncil((model, { round, peerIds }) => {
				// claude keeps disputing so gpt speaks every round
				if (model === claude.model) return [reportPosition("APPROVE", [], peerIds.map(id => ({ id, stance: "dispute", reason: "no" })))];
				if (round === 2) return [{ name: "report_position", arguments: { verdict: "MAYBE", revisions: [], positions: [] } }];
				return [reportPosition("NEEDS REVISION", ["Clamp negative budgets"])];
			}),
		);
		const session = newSession(streamFn);
		const clamp = [{ id: "openai/gpt-4o#1", summary: "Clamp negative budgets" }];

		await session.startInitialCritiques();
		expect(reviewerEntry(session, gpt.key, "critique").position?.revisions).toEqual(clamp);

		await session.runDebateRound();
		expect(reviewerEntry(session, gpt.key, "rebuttal").position).toBeUndefined();
		expect(session.getConvergence().unreported).toEqual([gpt.label]);

		await session.runDebateRound();
		expect(reviewerEntry(session, gpt.key, "rebuttal").position?.revisions).toEqual(clamp);
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
			// own IDs may appear under "Peer challenges to your revisions", never as listed peer items
			expect(gptDebatePrompt).not.toContain("- `openai/gpt-4o#1`:");

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

		// gpt adds an item in its Round 2 turn: claude has not been shown it, so it is open until claude, who already
		// spoke, is re-queued in the same round to confirm it
		let uncoveredAfterGptTurn: unknown;
		const unsubscribe = session.subscribe(() => {
			const gptTurn = session.entries.find(
				(e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.kind === "rebuttal" && e.reviewerKey === gpt.key,
			);
			if (uncoveredAfterGptTurn === undefined && gptTurn?.status === "done") {
				uncoveredAfterGptTurn = session.getConvergence().uncovered;
			}
		});
		await session.runDebateRound();
		unsubscribe();
		expect(uncoveredAfterGptTurn).toEqual([{ id: "openai/gpt-4o#2", by: claude.label }]);
		const afterFirstDebate = session.getConvergence();
		expect(afterFirstDebate.disputes).toEqual([]);
		expect(afterFirstDebate.converged).toBe(true);
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

	it("reports silent reviewers as stalled and ends the auto run before synthesis when none finished", async () => {
		// a model that never sends an event; its stream ends only when the request is aborted
		const silent: ModelStreamFn = (_model, _context, options) => ({
			async *[Symbol.asyncIterator]() {
				const { promise, resolve } = Promise.withResolvers<void>();
				options.signal.addEventListener("abort", () => resolve(), { once: true });
				await promise;
			},
			result: async () => ({ role: "assistant", content: [], stopReason: "aborted" }) as unknown as AssistantMessage,
		});
		// real time: the stall window runs on the platform clock
		const session = new CouncilSession({
			planTitle: "Stall Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: [claude, gpt],
			initialReviewers: [claude, gpt],
			streamFn: silent,
			modelStallMs: 20,
		});

		await expect(session.runAutoPipeline(claude.model)).rejects.toThrow(
			"No reviewer finished Round 1 (see the Council tab) — press r to retry.",
		);
		const critiques = session.entries.filter(isReviewerTurnEntry);
		expect(critiques.map(e => e.status)).toEqual(["error", "error"]);
		expect(critiques.map(e => e.errorMessage?.startsWith(`Stalled: no response from ${e.reviewerKey.split("/")[1]}`))).toEqual([true, true]);
		expect(session.latestSynthesis).toBeUndefined();
		expect(session.isActive()).toBe(false);
	});

	describe("operator questions", () => {
		const question = "Should retries be bounded?";
		const autoStages = (session: CouncilSession, options: { maxDebateRounds?: number } = {}) => {
			const stages: string[] = [];
			const run = session.runAutoPipeline(claude.model, { ...options, onStageChange: s => stages.push(s) });
			return { stages, run };
		};
		/** claude asks the operator in its Round 1 critique and needs one revision gpt agrees to */
		const askingCritique = scriptedCouncil((model, { round, peerIds, prompt }) => {
			if (prompt.startsWith("# Operator Follow-up")) return [];
			const positions = peerIds.map(id => ({ id, stance: "agree" as const }));
			if (model === gpt.model) return [reportPosition("APPROVE", [], positions)];
			const report = reportPosition("NEEDS REVISION", ["Bound retries"], positions);
			return [round === 1 ? withReportFields(report, { questionForOperator: question }) : report];
		});

		it("pauses an auto run on a reviewer's question until the operator answers it", async () => {
			const { streamFn } = makeMockStreamFn(askingCritique);
			const session = newSession(streamFn);

			const first = autoStages(session);
			const err = await first.run.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(OperatorQuestionPending);
			expect((err as Error).message).toContain(`${claude.label} asks: "${question}"`);
			expect(first.stages).toEqual(["Round 1 Critiques"]);
			expect(session.getOpenOperatorQuestions()).toEqual([
				{ reviewerKey: claude.key, reviewerLabel: claude.label, question, entryId: expect.any(String) },
			]);

			expect(await session.askCouncil("@claude Yes, three attempts")).toEqual({ status: "answered" });
			expect(session.getOpenOperatorQuestions()).toEqual([]);
			const resumed = autoStages(session);
			expect((await resumed.run).status).toBe("done");
			expect(resumed.stages.at(-1)).toBe("Synthesizing Consensus");
		});

		it("does not count a message sent before the question was reported as its answer", async () => {
			const gate = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			const { streamFn } = makeMockStreamFn(async (model, context) => {
				if (!isSynthesis(context) && debateRound(context) === undefined && !turnPrompt(context).startsWith("# Operator Follow-up")) {
					started.resolve();
					await gate.promise;
				}
				return askingCritique(model, context);
			});
			const session = newSession(streamFn);

			const first = autoStages(session);
			await started.promise;
			// queued while claude's critique streams, before its question exists
			expect(await session.askCouncil("Keep it small")).toEqual({ status: "queued" });
			gate.resolve();

			expect(await first.run.catch((e: unknown) => e)).toBeInstanceOf(OperatorQuestionPending);
			expect(session.getOpenOperatorQuestions().map(q => q.question)).toEqual([question]);
			await settle(session);
		});

		it("pauses once per question, so a resumed run continues without an answer", async () => {
			const { streamFn } = makeMockStreamFn(askingCritique);
			const session = newSession(streamFn);

			expect(await autoStages(session).run.catch((e: unknown) => e)).toBeInstanceOf(OperatorQuestionPending);
			const resumed = autoStages(session);
			expect((await resumed.run).status).toBe("done");
			expect(resumed.stages).toEqual(["Round 1 Critiques", "Round 2 Debate", "Synthesizing Consensus"]);
			// still open for the operator, but it no longer stops the run
			expect(session.getOpenOperatorQuestions().map(q => q.question)).toEqual([question]);
		});

		it("counts debate rounds already held when a paused run resumes", async () => {
			const { streamFn } = makeMockStreamFn(
				scriptedCouncil((model, { round, peerIds }) => {
					const report = reportPosition("BLOCK", [`Fix raised by ${model.id}`], peerIds.map(id => ({ id, stance: "dispute", reason: "no" })));
					return [model === claude.model && round === 2 ? withReportFields(report, { questionForOperator: question }) : report];
				}),
			);
			const session = newSession(streamFn);

			const first = autoStages(session, { maxDebateRounds: 2 });
			expect(await first.run.catch((e: unknown) => e)).toBeInstanceOf(OperatorQuestionPending);
			expect(first.stages).toEqual(["Round 1 Critiques", "Round 2 Debate"]);

			const resumed = autoStages(session, { maxDebateRounds: 2 });
			await resumed.run;
			expect(resumed.stages).toEqual(["Round 1 Critiques", "Round 3 Debate", "Synthesizing Consensus"]);
		});
	});
});

describe("stabilizeRevisionIds", () => {
	const held = [
		{ id: "a#1", summary: "Add retry" },
		{ id: "a#2", summary: "Log errors" },
	];
	const summaries = (...s: string[]) => s.map(summary => ({ summary }));

	it("keeps an unchanged summary's ID and never reissues a dropped one", () => {
		const round2 = stabilizeRevisionIds("a", summaries("Log errors", "Clamp timeout"), held, 3);
		expect(round2).toEqual({
			revisions: [
				{ id: "a#2", summary: "Log errors" },
				{ id: "a#3", summary: "Clamp timeout" },
			],
			nextNumber: 4,
		});
		expect(stabilizeRevisionIds("a", summaries("Add retry"), round2.revisions, round2.nextNumber)).toEqual({
			revisions: [{ id: "a#4", summary: "Add retry" }],
			nextNumber: 5,
		});
	});

	it("matches ignoring case and whitespace, and reuses each held ID at most once", () => {
		expect(stabilizeRevisionIds("a", summaries("  log   ERRORS ", "Log errors"), held, 3)).toEqual({
			revisions: [
				{ id: "a#2", summary: "  log   ERRORS " },
				{ id: "a#3", summary: "Log errors" },
			],
			nextNumber: 4,
		});
	});

	it("keeps the sequence on an empty report and numbers past a larger held ID", () => {
		expect(stabilizeRevisionIds("a", [], held, 3)).toEqual({ revisions: [], nextNumber: 3 });
		expect(stabilizeRevisionIds("a", summaries("Pin deps"), [{ id: "a#5", summary: "Old" }], 2)).toEqual({
			revisions: [{ id: "a#6", summary: "Pin deps" }],
			nextNumber: 7,
		});
	});
});

describe("roundtable debate rounds", () => {
	const claude = makeFakeReviewer("anthropic", "claude-3-7-sonnet", "claude");
	const gpt = makeFakeReviewer("openai", "gpt-4o", "gpt");
	const gemini = makeFakeReviewer("google", "gemini-2.5-pro", "gemini");

	function newSession(streamFn: ModelStreamFn, reviewers: ReviewerMember[], codeReader?: CodebaseReader): CouncilSession {
		return new CouncilSession({
			planTitle: "Roundtable Plan",
			planFilePath: "plan.md",
			planContent: "Plan content",
			availableReviewers: reviewers,
			initialReviewers: reviewers,
			streamFn,
			codeReader,
		});
	}

	function debateTurns(session: CouncilSession, round: number): ReviewerTurnEntry[] {
		return session.entries.filter((e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.kind === "rebuttal" && e.round === round);
	}

	type Calls = ReturnType<typeof makeMockStreamFn>["calls"];

	/** the turn prompt of the reviewer's first request whose prompt includes `marker` */
	function promptOf(calls: Calls, reviewer: ReviewerMember, marker: string): string {
		const call = calls.find(c => c.model === reviewer.model && turnPrompt(c.context).includes(marker));
		if (!call) throw new Error(`no ${reviewer.model.id} prompt with ${marker}`);
		return turnPrompt(call.context);
	}

	it("lets a challenged author answer in the same round, so a single round converges", async () => {
		const { streamFn, calls } = makeMockStreamFn(
			scriptedCouncil((model, { round, peerIds }) => {
				if (model === gpt.model) {
					return round === 1
						? [reportPosition("NEEDS REVISION", ["Add retry", "Log errors"])]
						: [reportPosition("NEEDS REVISION", ["Log errors"], peerIds.map(id => ({ id, stance: "agree" })))];
				}
				if (round === 1) return [reportPosition("APPROVE")];
				return [
					reportPosition("APPROVE", [], [
						{ id: "openai/gpt-4o#1", stance: "dispute", reason: "already retried" },
						{ id: "openai/gpt-4o#2", stance: "agree" },
					]),
				];
			}),
		);
		const session = newSession(streamFn, [gpt, claude]);

		await session.startInitialCritiques();
		await session.runDebateRound();

		// claude holds no revisions, so it examines gpt's proposals before gpt speaks
		const turns = debateTurns(session, 2);
		expect(turns.map(t => [t.reviewerKey, t.roundtableTurn])).toEqual([
			[claude.key, { step: 1 }],
			[gpt.key, { step: 2 }],
		]);
		expect(turns.map(t => t.position?.promptedItemIds)).toEqual([["openai/gpt-4o#1", "openai/gpt-4o#2"], []]);

		const gptPrompt = promptOf(calls, gpt, "Council Debate: Round 2");
		expect(gptPrompt).toContain("You have the floor (turn 2; peers: @claude-3-7-sonnet).");
		const critiqueAt = gptPrompt.indexOf(`### Critique from ${claude.label}\nReview from claude-3-7-sonnet for round 1\n`);
		const replyAt = gptPrompt.indexOf(`### Round 2 rebuttal from ${claude.label}\nReview from claude-3-7-sonnet for round 2\n`);
		expect(critiqueAt).toBeGreaterThan(-1);
		expect(replyAt).toBeGreaterThan(critiqueAt);
		expect(gptPrompt).toContain(
			`### Peer challenges to your revisions\n- **${claude.label}** challenged your \`openai/gpt-4o#1\` (Add retry): already retried\n`,
		);

		expect(session.getConvergence()).toEqual({
			converged: true,
			items: [{ id: "openai/gpt-4o#2", summary: "Log errors" }],
			disputes: [],
			uncovered: [],
			unreported: [],
		});
	});

	describe("disputed author speaks first and a settled round ends early", () => {
		// Round 2 ends with only gpt#1 disputed (by claude); gpt retracts it in Round 3
		const turn = (model: Model, { round, peerIds }: ScriptedTurn): MockToolCall[] => {
			if (model === gpt.model) {
				return [reportPosition(round < 3 ? "NEEDS REVISION" : "APPROVE", round < 3 ? ["Clamp budgets"] : [], peerIds.map(id => ({ id, stance: "agree" })))];
			}
			if (round === 1) return [reportPosition("APPROVE")];
			const stance = model === claude.model ? "dispute" : "agree";
			return [reportPosition("APPROVE", [], peerIds.map(id => ({ id, stance, reason: "already clamped" })))];
		};

		const cases: Array<{ name: string; before: (session: CouncilSession) => Promise<unknown>; speakers: ReviewerMember[]; note?: string }> = [
			{ name: "without operator input", before: async () => {}, speakers: [gpt] },
			{
				name: "unless a later speaker has an unseen operator message",
				before: session => session.askCouncil("@gpt Is the clamp needed?"),
				speakers: [gpt, claude, gemini],
				note: `[To ${gpt.label}]: Is the clamp needed?`,
			},
			{
				name: "unless a later speaker has an unseen operator reader answer",
				before: session => session.askCouncil("@reader Where is the clamp?"),
				speakers: [gpt, claude, gemini],
				note: "[Operator → Reader]: Where is the clamp?\n[Reader]: Reader: Where is the clamp?",
			},
		];

		for (const c of cases) {
			it(c.name, async () => {
				const { streamFn, calls } = makeMockStreamFn(scriptedCouncil(turn));
				const session = newSession(streamFn, [claude, gpt, gemini], makeFakeReader().reader);

				await session.startInitialCritiques();
				await session.runDebateRound();
				// claude's dispute hands gpt the floor at once
				expect(debateTurns(session, 2).map(t => t.reviewerKey)).toEqual([claude.key, gpt.key, gemini.key]);
				expect(promptOf(calls, gemini, "Council Debate: Round 2")).toContain(
					`- \`openai/gpt-4o#1\`: Clamp budgets\n  - Disputed by **${claude.label}**: already clamped\n`,
				);
				expect(session.getConvergence().disputes).toEqual([{ id: "openai/gpt-4o#1", by: claude.label, reason: "already clamped" }]);

				await c.before(session);
				await session.runDebateRound();
				expect(debateTurns(session, 3).map(t => t.reviewerKey)).toEqual(c.speakers.map(s => s.key));
				expect(session.getConvergence().converged).toBe(true);
				if (c.note) expect(promptOf(calls, claude, "Council Debate: Round 3")).toContain(c.note);
			});
		}
	});

	it("delivers unseen peer turns once, keeps operator input for the next debate turn, and redelivers after a failed turn", async () => {
		const { reader } = makeFakeReader();
		const { streamFn, calls } = makeMockStreamFn((model, context) => {
			const round = debateRound(context);
			const prompt = turnPrompt(context);
			if (round !== undefined) {
				if (model === gpt.model && round === 2) return { text: "", stopReason: "error", error: "Rate limit" };
				return { text: `${model.id} round ${round}`, toolCalls: [reportPosition("APPROVE")] };
			}
			if (!prompt.startsWith("# Operator Follow-up")) return { text: `${model.id} critique`, toolCalls: [reportPosition("APPROVE")] };
			if (model === gpt.model) return { text: "gpt reply" };
			// claude's second reply is tool-only: it must not displace the first
			return prompt.includes("Why approve?") ? { text: "Claude reply one" } : { text: "", toolCalls: [reportPosition("APPROVE")] };
		});
		const session = newSession(streamFn, [claude, gpt], reader);

		await session.startInitialCritiques();
		await session.askCouncil("@claude Why approve?");
		await session.askCouncil("@claude Report only");
		await session.askCouncil("@reader Where is X?");
		await session.askCouncil("@gpt What do you think?");

		const gptReplyPrompt = promptOf(calls, gpt, "What do you think?");
		const peerResponses = [...gptReplyPrompt.matchAll(/^\*\*(.+)\*\*:$/gm)].map(m => m[1]);
		expect(peerResponses).toEqual([`${claude.label} · Round 1 critique`, `${claude.label} · Round 1 reply`]);
		expect(gptReplyPrompt).toContain(`**${claude.label} · Round 1 reply**:\nClaude reply one\n`);

		const operatorNotes = [
			`[To ${claude.label}]: Why approve?`,
			`[To ${claude.label}]: Report only`,
			"[Operator → Reader]: Where is X?\n[Reader]: Reader: Where is X?",
		];
		await session.runDebateRound();
		expect(debateTurns(session, 2).map(t => [t.reviewerKey, t.status])).toEqual([
			[claude.key, "done"],
			[gpt.key, "error"],
		]);
		const failedPrompt = promptOf(calls, gpt, "Council Debate: Round 2");
		for (const note of operatorNotes) expect(failedPrompt).toContain(note);
		// gpt's own question and the peer turns its reply already received are not repeated
		expect(failedPrompt).not.toContain("What do you think?");
		expect(failedPrompt).not.toContain("Claude reply one");
		expect(failedPrompt).not.toContain("claude-3-7-sonnet critique");
		expect(failedPrompt).toContain(`### Round 2 rebuttal from ${claude.label}\nclaude-3-7-sonnet round 2\n`);

		// the failed turn consumed nothing, so the retry round delivers the same input again
		await session.runDebateRound();
		const retryPrompt = promptOf(calls, gpt, "Council Debate: Round 3");
		for (const note of operatorNotes) expect(retryPrompt).toContain(note);
		const priorAt = retryPrompt.indexOf(`### Round 2 rebuttal from ${claude.label}\nclaude-3-7-sonnet round 2\n`);
		expect(priorAt).toBeGreaterThan(-1);
		expect(retryPrompt.indexOf(`### Round 3 rebuttal from ${claude.label}\nclaude-3-7-sonnet round 3\n`)).toBeGreaterThan(priorAt);
		expect(debateTurns(session, 3).map(t => t.status)).toEqual(["done", "done"]);
	});

	it("delivers a peer's unseen prior-round rebuttal and its later targeted reply in order", async () => {
		const { streamFn, calls } = makeMockStreamFn((model, context) => {
			const round = debateRound(context);
			if (round !== undefined) return { text: `${model.id} round ${round}`, toolCalls: [reportPosition("APPROVE")] };
			if (turnPrompt(context).startsWith("# Operator Follow-up")) return { text: `${model.id} explains` };
			return { text: `${model.id} critique`, toolCalls: [reportPosition("APPROVE")] };
		});
		const session = newSession(streamFn, [claude, gpt]);

		await session.startInitialCritiques();
		await session.runDebateRound();
		await session.askCouncil("@gpt Explain more");
		await session.runDebateRound();

		const claudePrompt = promptOf(calls, claude, "Council Debate: Round 3");
		const rebuttalAt = claudePrompt.indexOf(`### Round 2 rebuttal from ${gpt.label}\ngpt-4o round 2\n`);
		const replyAt = claudePrompt.indexOf(`### Round 2 reply from ${gpt.label}\ngpt-4o explains\n`);
		expect(rebuttalAt).toBeGreaterThan(-1);
		expect(replyAt).toBeGreaterThan(rebuttalAt);
		expect(claudePrompt).toContain(`[To ${gpt.label}]: Explain more`);
	});

	it("starts no later speaker after an abort and keeps a restarted round's floor when the stopped speaker settles late", async () => {
		const gates = new Map([2, 3].map(round => [round, Promise.withResolvers<void>()]));
		const started = new Map([2, 3].map(round => [round, Promise.withResolvers<void>()]));
		const { streamFn, calls } = makeMockStreamFn(async (model, context) => {
			const round = debateRound(context);
			const gate = round === undefined ? undefined : gates.get(round);
			if (round !== undefined && gate) {
				started.get(round)?.resolve();
				// ignores the abort signal: the stopped request settles only when its gate opens
				await gate.promise;
			}
			return { text: `${model.id} round ${round ?? 1}`, toolCalls: [reportPosition("APPROVE")] };
		});
		const session = newSession(streamFn, [claude, gpt]);
		await session.startInitialCritiques();

		const stopped = session.runDebateRound();
		await started.get(2)?.promise;
		expect(session.activeSpeaker).toEqual({ reviewerKey: claude.key, modelId: claude.model.id, label: claude.label, kind: "rebuttal", step: 1 });
		session.abortActiveRound();
		expect(session.activeSpeaker).toBeUndefined();

		const restarted = session.runDebateRound();
		await started.get(3)?.promise;
		gates.get(2)?.resolve();
		await stopped;
		// the stopped round's cleanup must not release the restarted one
		expect(session.isBusy()).toBe(true);
		expect(session.activeSpeaker).toMatchObject({ reviewerKey: claude.key, kind: "rebuttal", step: 1 });
		expect(calls.filter(c => debateRound(c.context) === 2).map(c => c.model.id)).toEqual([claude.model.id]);
		expect(debateTurns(session, 2).map(t => [t.reviewerKey, t.status])).toEqual([[claude.key, "aborted"]]);

		gates.get(3)?.resolve();
		await restarted;
		expect(session.activeSpeaker).toBeUndefined();
		expect(session.isBusy()).toBe(false);
		expect(debateTurns(session, 3).map(t => [t.reviewerKey, t.status])).toEqual([
			[claude.key, "done"],
			[gpt.key, "done"],
		]);
	});

	describe("reactive floor", () => {
		it("lets a challenged author answer at once and the challenger confirm the narrowed item in the same round", async () => {
			const { streamFn, calls } = makeMockStreamFn(
				scriptedCouncil((model, { round, peerIds, prompt }) => {
					if (model === gpt.model) {
						const challenged = prompt.includes("### Peer challenges to your revisions");
						return [reportPosition("NEEDS REVISION", [challenged ? "Clamp negative budgets" : "Clamp budgets"])];
					}
					if (round === 1) return [reportPosition("APPROVE")];
					const disputer = model === claude.model;
					return [
						reportPosition(
							"APPROVE",
							[],
							peerIds.map(id =>
								disputer && id === "openai/gpt-4o#1"
									? { id, stance: "dispute" as const, reason: "too broad" }
									: { id, stance: "agree" as const },
							),
						),
					];
				}),
			);
			const session = newSession(streamFn, [claude, gpt, gemini]);

			await session.startInitialCritiques();
			await session.runDebateRound();

			const turns = debateTurns(session, 2);
			expect(turns.map(t => t.reviewerKey)).toEqual([claude.key, gpt.key, gemini.key, claude.key]);
			expect(turns.map(t => t.roundtableTurn?.step)).toEqual([1, 2, 3, 4]);
			const claudePrompts = calls
				.filter(c => c.model === claude.model && debateRound(c.context) === 2)
				.map(c => turnPrompt(c.context));
			expect(claudePrompts).toHaveLength(2);
			expect(claudePrompts[1]).toContain(`### Round 2 rebuttal from ${gpt.label}`);
			expect(claudePrompts[1]).toContain("- `openai/gpt-4o#2`: Clamp negative budgets");
			expect(session.getConvergence()).toEqual({
				converged: true,
				items: [{ id: "openai/gpt-4o#2", summary: "Clamp negative budgets" }],
				disputes: [],
				uncovered: [],
				unreported: [],
			});
			expect(turns[1].positionDelta).toEqual({
				added: [{ id: "openai/gpt-4o#2", summary: "Clamp negative budgets" }],
				dropped: [{ id: "openai/gpt-4o#1", summary: "Clamp budgets" }],
				agreed: [],
				disputed: [],
			});
		});

		it("caps each reviewer at two turns a round while a dispute keeps bouncing", async () => {
			const { streamFn } = makeMockStreamFn(
				scriptedCouncil((model, { peerIds }) => [
					reportPosition("NEEDS REVISION", [`Fix raised by ${model.id}`], peerIds.map(id => ({ id, stance: "dispute", reason: "no" }))),
				]),
			);
			const session = newSession(streamFn, [claude, gpt]);

			await session.startInitialCritiques();
			await session.runDebateRound();

			expect(debateTurns(session, 2).map(t => t.reviewerKey)).toEqual([claude.key, gpt.key, claude.key, gpt.key]);
			expect(session.getConvergence().disputes.map(d => d.id)).toEqual(["openai/gpt-4o#1", "anthropic/claude-3-7-sonnet#1"]);
		});

		const handoffCases = [
			{ name: "hands the floor to the peer named in nextSpeaker", handoff: true, order: [gpt, gemini, claude] },
			{ name: "keeps the order for a passing @mention in prose", handoff: false, order: [gpt, claude, gemini] },
		];
		for (const c of handoffCases) {
			it(c.name, async () => {
				const { streamFn } = makeMockStreamFn((model, context) => {
					const report = reportPosition("APPROVE");
					if (model !== gpt.model || debateRound(context) !== 2) return { text: `${model.id} review`, toolCalls: [report] };
					return {
						text: "I agree with @gemini-2.5-pro",
						toolCalls: [c.handoff ? withReportFields(report, { nextSpeaker: "@gemini-2.5-pro" }) : report],
					};
				});
				const session = newSession(streamFn, [gpt, claude, gemini]);

				await session.startInitialCritiques();
				await session.runDebateRound();

				expect(debateTurns(session, 2).map(t => t.reviewerKey)).toEqual(c.order.map(r => r.key));
			});
		}
	});

	describe("operator messages sent while the council is busy", () => {
		/** reviewers approve and answer follow-ups at once; turns matching `gated` signal `started` and wait for `release` */
		function gatedCouncil(gated: (model: Model, context: Context) => boolean) {
			const gate = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			const mock = makeMockStreamFn(async (model, context) => {
				if (turnPrompt(context).startsWith("# Operator Follow-up")) return { text: `${model.id} answers` };
				if (gated(model, context)) {
					started.resolve();
					await gate.promise;
				}
				return { text: `${model.id} turn`, toolCalls: [reportPosition("APPROVE")] };
			});
			return { ...mock, started: started.promise, release: () => gate.resolve() };
		}
		const followUps = (calls: Calls) => calls.filter(c => turnPrompt(c.context).startsWith("# Operator Follow-up"));
		const isCritique = (_model: Model, context: Context) => debateRound(context) === undefined;
		const isClaudeRound2 = (model: Model, context: Context) => model === claude.model && debateRound(context) === 2;

		it("queues an @model message during Round 1 and answers it once the round ends", async () => {
			const { streamFn, calls, started, release } = gatedCouncil(isCritique);
			const session = newSession(streamFn, [claude, gpt]);
			const round1 = session.startInitialCritiques();
			await started;
			const callsBefore = calls.length;

			expect(await session.askCouncil("@gpt Is step 2 safe?")).toEqual({ status: "queued", target: gpt });
			expect(calls.length).toBe(callsBefore);
			expect(session.entries.filter(e => e.kind === "user").map(e => e.text)).toEqual(["Is step 2 safe?"]);
			expect(session.pendingAskCount).toBe(1);

			release();
			await round1;
			await settle(session);
			expect(followUps(calls).map(c => c.model.id)).toEqual([gpt.model.id]);
			expect(turnPrompt(followUps(calls)[0].context)).toContain("Is step 2 safe?");
			expect(session.pendingAskCount).toBe(0);
		});

		it("gives an @model message the next debate turn, so it needs no reply pass", async () => {
			const { streamFn, calls, started, release } = gatedCouncil(isClaudeRound2);
			const session = newSession(streamFn, [claude, gpt, gemini]);
			await session.startInitialCritiques();
			const round = session.runDebateRound();
			await started;

			expect(await session.askCouncil("@gemini Check the overlay")).toEqual({ status: "queued", target: gemini });
			release();
			await round;
			await settle(session);

			expect(debateTurns(session, 2).map(t => t.reviewerKey)).toEqual([claude.key, gemini.key, gpt.key]);
			expect(promptOf(calls, gemini, "Council Debate: Round 2")).toContain(
				`### Operator Guidance\n[To ${gemini.label}]: Check the overlay`,
			);
			expect(followUps(calls)).toEqual([]);
			expect(session.pendingAskCount).toBe(0);
		});

		it("delivers a broadcast to later debate speakers and replies only for the speaker who missed it", async () => {
			const { streamFn, calls, started, release } = gatedCouncil(isClaudeRound2);
			const session = newSession(streamFn, [claude, gpt, gemini]);
			await session.startInitialCritiques();
			const round = session.runDebateRound();
			await started;

			expect(await session.askCouncil("Keep it small")).toEqual({ status: "queued" });
			release();
			await round;
			await settle(session);

			for (const reviewer of [gpt, gemini]) {
				expect(promptOf(calls, reviewer, "Council Debate: Round 2")).toContain("### Operator Guidance\nKeep it small");
			}
			expect(followUps(calls).map(c => c.model.id)).toEqual([claude.model.id]);
			expect(turnPrompt(followUps(calls)[0].context)).toContain("Keep it small");
		});

		it("drops queued messages when the round is stopped", async () => {
			const { streamFn, calls, started, release } = gatedCouncil(isCritique);
			const session = newSession(streamFn, [claude, gpt]);
			const round1 = session.startInitialCritiques();
			await started;

			await session.askCouncil("@gpt Is step 2 safe?");
			session.abortActiveRound();
			expect(session.pendingAskCount).toBe(0);
			release();
			await round1;
			await settle(session);
			expect(followUps(calls)).toEqual([]);
		});
	});

	it("answers a broadcast question one reviewer at a time, each building on the answers before it", async () => {
		const { streamFn, calls } = makeMockStreamFn((model, context) =>
			turnPrompt(context).startsWith("# Operator Follow-up")
				? { text: `${model.id} answers` }
				: { text: `${model.id} critique`, toolCalls: [reportPosition("APPROVE")] },
		);
		const session = newSession(streamFn, [claude, gpt, gemini]);
		await session.startInitialCritiques();

		expect(await session.askCouncil("How risky is step 3?")).toEqual({ status: "answered" });

		const replies = calls.filter(c => turnPrompt(c.context).startsWith("# Operator Follow-up")).map(c => [c.model.id, turnPrompt(c.context)]);
		expect(replies.map(([id]) => id)).toEqual([claude.model.id, gpt.model.id, gemini.model.id]);
		const [, geminiPrompt] = replies[2];
		expect(geminiPrompt).toContain("You are answering 3 of 3.");
		expect(geminiPrompt).toContain("### Peers so far");
		expect(geminiPrompt).toContain(`**${claude.label} · Round 1 reply**:\nclaude-3-7-sonnet answers\n`);
		expect(geminiPrompt).toContain(`**${gpt.label} · Round 1 reply**:\ngpt-4o answers\n`);
		// the first to answer has no peer answers yet
		expect(replies[0][1]).not.toContain("· Round 1 reply**");
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

	function newSession(
		streamFn: ModelStreamFn,
		codeReader: CodebaseReader | undefined,
		extra: { maxReaderQueriesPerTurn?: number; reviewers?: ReviewerMember[]; modelStallMs?: number } = {},
	) {
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
			modelStallMs: extra.modelStallMs,
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

	it("waits out a reader slower than the stall window without stalling the reviewer", async () => {
		// real time: the reviewer's stall window runs on the platform clock while the reader answers
		const { reader } = makeFakeReader(async input => {
			await Bun.sleep(80);
			return `Reader: ${input.question}`;
		});
		const { streamFn } = makeMockStreamFn((_model, context) =>
			readerAnswered(context)
				? { text: "Verified review", toolCalls: [reportPosition("APPROVE")] }
				: { text: "Checking", toolCalls: [{ name: "ask_codebase", arguments: { question: "where is foo?" } }] },
		);
		const session = newSession(streamFn, reader, { reviewers: [claude], modelStallMs: 20 });

		await session.startInitialCritiques();

		const critique = critiqueOf(session, claude.key);
		expect([critique.status, critique.readerQueryCount, critique.position?.verdict]).toEqual(["done", 1, "APPROVE"]);
		expect(critique.text).toContain("Verified review");
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
		await session.askCouncil("@reader Where is resolvePlanReview called?");
		await session.askCouncil("@scout Which tests cover it?");
		await session.askCouncil("And the overlay?", READER_TARGET_KEY);

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

	it("stabilizes a report sent alongside ask_codebase when the final step does not report", async () => {
		const { reader } = makeFakeReader();
		const { streamFn } = makeMockStreamFn((model, context) => {
			const round = debateRound(context) ?? 1;
			if (model === claude.model) {
				// claude keeps disputing so gpt speaks every round
				const peerIds = [...turnPrompt(context).matchAll(/^- `([^`]+)`: /gm)].map(m => m[1]);
				return { text: "Claude", toolCalls: [reportPosition("APPROVE", [], peerIds.map(id => ({ id, stance: "dispute", reason: "no" })))] };
			}
			if (round === 1) return { text: "R1", toolCalls: [reportPosition("NEEDS REVISION", ["Add retry", "Log errors"])] };
			if (round === 3) return { text: "R3", toolCalls: [reportPosition("NEEDS REVISION", ["Add retry"])] };
			// Round 2 reports beside a reader query; neither the final step nor the forced follow-up reports again
			if (lastPrompt(context).startsWith(FORCED_REPORT_MARKER) || readerAnswered(context)) return { text: "" };
			return {
				text: "Checking",
				toolCalls: [{ name: "ask_codebase", arguments: { question: "retry?" } }, reportPosition("NEEDS REVISION", ["Log errors", "Clamp timeout"])],
			};
		});
		const session = newSession(streamFn, reader);
		const gptRevisions = (round: number) =>
			session.entries.find((e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.reviewerKey === gpt.key && e.round === round)?.position?.revisions;

		await session.startInitialCritiques();
		await session.runDebateRound();
		expect(gptRevisions(2)).toEqual([
			{ id: "openai/gpt-4o#2", summary: "Log errors" },
			{ id: "openai/gpt-4o#3", summary: "Clamp timeout" },
		]);

		// the dropped "Add retry" comes back as a new item, numbered after the fallback's minted #3
		await session.runDebateRound();
		expect(gptRevisions(3)).toEqual([{ id: "openai/gpt-4o#4", summary: "Add retry" }]);
	});
});
