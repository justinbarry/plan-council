import { describe, expect, it, spyOn } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ExtensionModelQuery } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { parseEffort } from "@oh-my-pi/pi-tui/thinking";
import { CouncilSession } from "../src/council-session";
import { modelKey, resolveCouncilRoster, resolveSynthesizerModel } from "../src/models";
import { parsePlanCouncilSettings } from "../src/settings";

// native effort values keep the fixtures reasoning capabilities checked by the library types
const efforts = ["low", "medium", "high", "xhigh"].map(parseEffort).filter(effort => effort !== undefined);

const sol: Model = {
	id: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://example.invalid",
	compat: undefined,
	identity: { class: "openai", family: "gpt" },
	reasoning: true,
	thinking: { mode: "effort", efforts },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

const opus: Model = {
	...sol,
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	provider: "anthropic",
	api: "anthropic-messages",
	identity: { class: "anthropic", family: "claude" },
};

const limited: Model = {
	...sol,
	id: "limited-reasoning-model",
	thinking: { mode: "effort", efforts: efforts.filter(effort => effort.toString() !== "xhigh") },
};

/** resolve selectors through omp while keeping the model catalog local to the test */
function makeModelQuery(
	roles: Record<string, string> = {},
	available: Model[] = [sol, opus],
	host: { resolveSelection?: boolean } = {},
): ExtensionModelQuery {
	const resolveRole = (spec: string) => resolveModelRoleValue(spec, available, { roleLookup: { getModelRole: role => roles[role] } });
	const query: ExtensionModelQuery = {
		list: () => available,
		current: () => sol,
		resolve: spec => resolveRole(spec).model,
		family: model => model.identity.class,
	};
	if (!host.resolveSelection) return query;
	// newer omp hosts also expose the level a role or suffix configures
	return Object.assign(query, {
		resolveSelection: (spec: string) => {
			const { model, thinkingLevel } = resolveRole(spec);
			return model ? { model, thinkingLevel } : undefined;
		},
	});
}

/** complete a model request, reporting an approving position, without calling a provider */
function completedStream(model: Model): ReturnType<typeof ai.createAssistantMessageEventStream> {
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "Approve with no blocking issues" },
			{ type: "toolCall", id: "call-0", name: "report_position", arguments: { verdict: "APPROVE", revisions: [], positions: [] } },
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	const stream = ai.createAssistantMessageEventStream();
	stream.push({ type: "done", reason: "toolUse", message });
	return stream;
}

// each selected reviewer must retain the effort requested by the operator
describe("per-reviewer reasoning selection", () => {
	// the explicit roster must allow the planning model as a reviewer with its own effort
	it("preserves different efforts for explicit reviewers and their available model entries", () => {
		const roster = resolveCouncilRoster(makeModelQuery(), parsePlanCouncilSettings({
			reviewerModels: "openai-codex/gpt-6.1-sol:xhigh, anthropic/claude-opus-5-5:high",
		}));

		expect(roster.warnings).toEqual([]);
		expect(roster.reviewers.map(reviewer => [reviewer.key, reviewer.thinkingLevel])).toEqual([
			[modelKey(sol), "xhigh"],
			[modelKey(opus), "high"],
		]);
		for (const reviewer of roster.reviewers) {
			expect(roster.available.find(available => available.key === reviewer.key)).toBe(reviewer);
		}
	});

	// council role fallbacks must still work when the operator adds an effort suffix
	it.each(["council1:xhigh", "@advisor:xhigh"])("preserves an explicit effort through %s", selector => {
		const roster = resolveCouncilRoster(makeModelQuery({ plan: modelKey(sol), advisor: modelKey(sol) }), parsePlanCouncilSettings({
			reviewerModels: selector,
		}));

		expect(roster.warnings).toEqual([]);
		expect(roster.reviewers.map(reviewer => [reviewer.key, reviewer.thinkingLevel])).toEqual([[modelKey(sol), "xhigh"]]);
	});

	// model ids with a literal max suffix must keep their existing meaning
	it("does not reinterpret a literal model id as a reasoning setting", () => {
		const literal: Model = { ...sol, id: "example:max" };
		const roster = resolveCouncilRoster(makeModelQuery({}, [literal]), parsePlanCouncilSettings({
			reviewerModels: "openai-codex/example:max",
		}));

		expect(roster.warnings).toEqual([]);
		expect(roster.reviewers.map(reviewer => [reviewer.key, reviewer.thinkingLevel])).toEqual([[modelKey(literal), undefined]]);
	});

	// reviewer suffix handling must not change which model synthesis selects
	it("preserves the existing synthesizer lookup when an explicit selector has no match", () => {
		const query = makeModelQuery({ plan: modelKey(sol), smol: modelKey(opus) });
		const model = resolveSynthesizerModel(query, parsePlanCouncilSettings({ synthesizerModel: "council2:high" }), []);
		expect(model).toBe(sol);
	});
});

// a role's configured level reaches reviewers when the omp host reports it
describe("role thinking levels", () => {
	const withSelection = { resolveSelection: true };
	const levels = (reviewers: { key: string; thinkingLevel?: unknown }[]) =>
		reviewers.map(reviewer => [reviewer.key, reviewer.thinkingLevel?.toString()]);

	it("uses the role's level for a selector without a suffix, and keeps defaults on older hosts", () => {
		const roles = { plan: `${modelKey(sol)}:high` };
		const settings = parsePlanCouncilSettings({ reviewerModels: "plan" });
		expect(levels(resolveCouncilRoster(makeModelQuery(roles, [sol, opus], withSelection), settings).reviewers)).toEqual([
			[modelKey(sol), "high"],
		]);
		expect(levels(resolveCouncilRoster(makeModelQuery(roles), settings).reviewers)).toEqual([[modelKey(sol), undefined]]);
	});

	it("lets an explicit suffix override the role's level", () => {
		const query = makeModelQuery({ plan: `${modelKey(sol)}:high` }, [sol, opus], withSelection);
		const roster = resolveCouncilRoster(query, parsePlanCouncilSettings({ reviewerModels: "plan:medium" }));
		expect(levels(roster.reviewers)).toEqual([[modelKey(sol), "medium"]]);
	});

	it("limits a role's level to what the model supports", () => {
		const query = makeModelQuery({ plan: `${modelKey(limited)}:xhigh` }, [sol, opus, limited], withSelection);
		const roster = resolveCouncilRoster(query, parsePlanCouncilSettings({ reviewerModels: "plan" }));
		expect(levels(roster.reviewers)).toEqual([[modelKey(limited), "high"]]);
	});

	it("applies role levels to council roles and auto-selected reviewers", () => {
		const council = makeModelQuery(
			{ council1: `${modelKey(sol)}:xhigh`, council2: `${modelKey(opus)}:low` },
			[sol, opus],
			withSelection,
		);
		expect(levels(resolveCouncilRoster(council, parsePlanCouncilSettings({})).reviewers)).toEqual([
			[modelKey(sol), "xhigh"],
			[modelKey(opus), "low"],
		]);

		// the session model (sol) is skipped, so the @plan role's model is auto-selected with its level
		const auto = makeModelQuery({ plan: `${modelKey(opus)}:high` }, [sol, opus], withSelection);
		expect(levels(resolveCouncilRoster(auto, parsePlanCouncilSettings({})).reviewers)).toEqual([[modelKey(opus), "high"]]);
	});
});

// inspect the native stream boundary so a lost request option fails the test
describe("per-reviewer reasoning requests", () => {
	// later reviewer interactions must use the same per model effort
	it("forwards distinct efforts through critiques debate replies and model selection without changing synthesis", async () => {
		const calls: Array<{ model: Model; options: SimpleStreamOptions | undefined }> = [];
		const stream = spyOn(ai, "streamSimple").mockImplementation((model, _context, options) => {
			calls.push({ model, options });
			return completedStream(model);
		});
		const roster = resolveCouncilRoster(makeModelQuery(), parsePlanCouncilSettings({
			reviewerModels: "openai-codex/gpt-6.1-sol:xhigh, anthropic/claude-opus-5-5:high",
		}));
		const session = new CouncilSession({
			planTitle: "Review plan",
			planFilePath: "plan.md",
			planContent: "Check the proposed change",
			availableReviewers: roster.available,
			initialReviewers: roster.reviewers,
			sessionId: "reviewer-reasoning-test",
		});

		try {
			await session.startInitialCritiques();
			await session.runDebateRound();
			await session.askCouncil("Check the remaining risks");
			await session.askCouncil("@gpt-6.1-sol Check the first risk");
			session.setReviewers([modelKey(sol)]);
			await session.askCouncil("Check after selecting one reviewer");

			expect(calls.filter(call => call.model.id === sol.id)).toHaveLength(5);
			expect(calls.filter(call => call.model.id === opus.id)).toHaveLength(3);
			for (const call of calls) {
				expect(call.options?.reasoning?.toString()).toBe(call.model.id === sol.id ? "xhigh" : "high");
				expect(call.options?.disableReasoning).toBeFalsy();
				expect(call.options?.sessionId).toBe("reviewer-reasoning-test");
			}

			await session.synthesizeFeedback(sol);
			expect(calls).toHaveLength(9);
			expect(calls.at(-1)?.options?.reasoning).toBeUndefined();
		} finally {
			session.dispose();
			stream.mockRestore();
		}
	});

	// selectors must preserve defaults disable reasoning or use the models highest supported effort
	it.each([
		["openai-codex/gpt-6.1-sol", sol, undefined, false],
		["openai-codex/gpt-6.1-sol:off", sol, undefined, true],
		["openai-codex/limited-reasoning-model:xhigh", limited, "high", false],
	] as const)("handles reasoning defaults and model limits for %s", async (selector, model, expectedEffort, disabled) => {
		const calls: Array<SimpleStreamOptions | undefined> = [];
		const stream = spyOn(ai, "streamSimple").mockImplementation((model, _context, options) => {
			calls.push(options);
			return completedStream(model);
		});
		const roster = resolveCouncilRoster(makeModelQuery({}, [model]), parsePlanCouncilSettings({ reviewerModels: selector }));
		const session = new CouncilSession({
			planTitle: "Review plan",
			planFilePath: "plan.md",
			planContent: "Check the proposed change",
			availableReviewers: roster.available,
			initialReviewers: roster.reviewers,
		});

		try {
			await session.startInitialCritiques();
			expect(calls).toHaveLength(1);
			expect(calls[0]?.reasoning?.toString()).toBe(expectedEffort);
			expect(Boolean(calls[0]?.disableReasoning)).toBe(disabled);
		} finally {
			session.dispose();
			stream.mockRestore();
		}
	});
});
