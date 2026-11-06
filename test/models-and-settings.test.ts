import {
	renderCritiqueRound,
	renderCritiqueSystem,
	renderDebateRebuttal,
	renderSynthesizeSystem,
	renderSynthesizeUser,
	renderUserFollowup,
} from "../src/prompts/render";
import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionModelQuery } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { modelKey, resolveCouncilRoster, resolveSynthesizerModel } from "../src/models";
import { parsePlanCouncilSettings } from "../src/settings";

function makeFakeModel(provider: string, id: string, family: string): Model {
	return {
		id,
		provider,
		name: `${id} model`,
		description: "fake model for test",
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
}

function makeFakeModelQuery(opts: {
	available: Model[];
	current?: Model;
	familyMap?: Record<string, string>;
	roles?: Record<string, Model | undefined>;
}): ExtensionModelQuery {
	const mapBySpec = new Map<string, Model>();
	for (const m of opts.available) {
		mapBySpec.set(m.id, m);
		mapBySpec.set(`${m.provider}/${m.id}`, m);
	}
	if (opts.roles) {
		for (const [role, m] of Object.entries(opts.roles)) {
			if (m) {
				mapBySpec.set(role, m);
				mapBySpec.set(`@${role}`, m);
			}
		}
	}

	return {
		list: () => opts.available,
		current: () => opts.current,
		resolve: (spec: string) => mapBySpec.get(spec),
		family: (m: Model) => opts.familyMap?.[m.id] ?? (m.identity.class || m.provider),
	};
}

describe("settings parser", () => {
	it("uses defaults on empty raw input", () => {
		const parsed = parsePlanCouncilSettings({});
		expect(parsed.autoStart).toBe(false);
		expect(parsed.reviewerModels).toEqual([]);
		expect(parsed.maxReviewers).toBe(3);
		expect(parsed.synthesizerModel).toBeUndefined();
		expect(parsed.shortcut).toBe("ctrl+n");
		expect(parsed.includeSessionContext).toBe(true);
	});

	it("parses and clamps maxReviewers", () => {
		expect(parsePlanCouncilSettings({ maxReviewers: 10 }).maxReviewers).toBe(6);
		expect(parsePlanCouncilSettings({ maxReviewers: 0 }).maxReviewers).toBe(1);
		expect(parsePlanCouncilSettings({ maxReviewers: -5 }).maxReviewers).toBe(1);
		expect(parsePlanCouncilSettings({ maxReviewers: 4.8 }).maxReviewers).toBe(5);
		expect(parsePlanCouncilSettings({ maxReviewers: "5" }).maxReviewers).toBe(5);
		expect(parsePlanCouncilSettings({ maxReviewers: "invalid" }).maxReviewers).toBe(3);
	});

	it("parses and clamps maxDebateRounds", () => {
		expect(parsePlanCouncilSettings({}).maxDebateRounds).toBe(3);
		expect(parsePlanCouncilSettings({ maxDebateRounds: "7" }).maxDebateRounds).toBe(5);
		expect(parsePlanCouncilSettings({ maxDebateRounds: 0 }).maxDebateRounds).toBe(1);
		expect(parsePlanCouncilSettings({ maxDebateRounds: 2.4 }).maxDebateRounds).toBe(2);
		expect(parsePlanCouncilSettings({ maxDebateRounds: "invalid" }).maxDebateRounds).toBe(3);
	});

	it("splits CSV reviewerModels and trims whitespace", () => {
		const parsed = parsePlanCouncilSettings({ reviewerModels: " anthropic/claude-3-5-sonnet, , openai/gpt-4o " });
		expect(parsed.reviewerModels).toEqual(["anthropic/claude-3-5-sonnet", "openai/gpt-4o"]);
	});

	it("falls back to default shortcut when blank", () => {
		expect(parsePlanCouncilSettings({ shortcut: "   " }).shortcut).toBe("ctrl+n");
		expect(parsePlanCouncilSettings({ shortcut: "ctrl+p" }).shortcut).toBe("ctrl+p");
	});
});

describe("model roster resolution", () => {
	const claude = makeFakeModel("anthropic", "claude-3-7-sonnet", "claude");
	const gpt4o = makeFakeModel("openai", "gpt-4o", "gpt");
	const gemini = makeFakeModel("google", "gemini-2.5-pro", "gemini");
	const deepseek = makeFakeModel("deepseek", "deepseek-r1", "deepseek");
	const claudeHaiku = makeFakeModel("anthropic", "claude-3-5-haiku", "claude");

	it("returns warning when no models are available", () => {
		const query = makeFakeModelQuery({ available: [] });
		const roster = resolveCouncilRoster(query, parsePlanCouncilSettings({}));
		expect(roster.reviewers).toHaveLength(0);
		expect(roster.available).toHaveLength(0);
		expect(roster.warnings).toContain("No authenticated chat models available.");
	});

	it("auto-selects diverse cross-family models excluding current planning model", () => {
		const query = makeFakeModelQuery({
			available: [claude, gpt4o, gemini, deepseek, claudeHaiku],
			current: claude,
			roles: { slow: gpt4o, default: gemini },
		});
		const roster = resolveCouncilRoster(query, parsePlanCouncilSettings({ maxReviewers: 3 }));
		const reviewerKeys = roster.reviewers.map(r => r.key);

		expect(reviewerKeys).not.toContain(modelKey(claude));
		expect(roster.reviewers).toHaveLength(3);
		// Check that families are distinct
		const families = new Set(roster.reviewers.map(r => r.family));
		expect(families.size).toBe(3);
	});

	it("falls back to single model when only one model is available in catalog", () => {
		const query = makeFakeModelQuery({
			available: [claude],
			current: claude,
		});
		const roster = resolveCouncilRoster(query, parsePlanCouncilSettings({}));
		expect(roster.reviewers).toHaveLength(1);
		expect(roster.reviewers[0].key).toBe(modelKey(claude));
	});

	it("falls back to filling up to 2 models if only same-family models exist", () => {
		const query = makeFakeModelQuery({
			available: [claude, claudeHaiku],
			current: undefined,
		});
		const roster = resolveCouncilRoster(query, parsePlanCouncilSettings({ maxReviewers: 3 }));
		expect(roster.reviewers).toHaveLength(2);
		expect(roster.reviewers.map(r => r.key)).toEqual([modelKey(claude), modelKey(claudeHaiku)]);
	});

	it("resolves explicit reviewerModels and reports unknown specs in warnings", () => {
		const query = makeFakeModelQuery({
			available: [claude, gpt4o],
			roles: { slow: claude },
		});
		const settings = parsePlanCouncilSettings({ reviewerModels: "gpt-4o, non-existent-model" });
		const roster = resolveCouncilRoster(query, settings);

		expect(roster.reviewers).toHaveLength(1);
		expect(roster.reviewers[0].key).toBe(modelKey(gpt4o));
		expect(roster.warnings).toHaveLength(1);
		expect(roster.warnings[0]).toContain('Unknown or unauthenticated reviewer model: "non-existent-model"');
	});

	it("resolves synthesizer model with proper fallbacks", () => {
		const query = makeFakeModelQuery({
			available: [claude, gpt4o, gemini],
			roles: { slow: gemini },
			current: claude,
		});
		const settingsWithExplicit = parsePlanCouncilSettings({ synthesizerModel: "gpt-4o" });
		expect(resolveSynthesizerModel(query, settingsWithExplicit, [])?.id).toBe("gpt-4o");

		const settingsDefault = parsePlanCouncilSettings({});
		// slow role is gemini
		expect(resolveSynthesizerModel(query, settingsDefault, [])?.id).toBe("gemini-2.5-pro");
	});

	it("prioritizes custom council roles and automatically adds @ prefix when resolving", () => {
		const council1 = makeFakeModel("google", "gemini-2.5-flash", "gemini");
		const council2 = makeFakeModel("openai", "gpt-4o", "openai");
		const query = makeFakeModelQuery({
			available: [claude, council1, council2],
			roles: {
				"@council1": council1,
				"@council2": council2,
			},
		});

		const roster = resolveCouncilRoster(query, parsePlanCouncilSettings({}));
		const reviewerKeys = roster.reviewers.map(r => r.key);
		expect(reviewerKeys).toContain(modelKey(council1));
		expect(reviewerKeys).toContain(modelKey(council2));
	});

	it("resolves role backup chains when custom council roles are undefined", () => {
		const planModel = makeFakeModel("google", "gemini-2.5-pro", "gemini");
		const smolModel = makeFakeModel("openai", "gpt-4o-mini", "openai");
		const query = makeFakeModelQuery({
			available: [claude, planModel, smolModel],
			roles: {
				"@plan": planModel,
				"@smol": smolModel,
			},
		});

		// council1 and council2 undefined -> fall back to @plan and @smol
		const roster = resolveCouncilRoster(query, parsePlanCouncilSettings({ reviewerModels: "council1, council2" }));
		expect(roster.reviewers).toHaveLength(2);
		expect(roster.reviewers[0].key).toBe(modelKey(planModel));
		expect(roster.reviewers[1].key).toBe(modelKey(smolModel));
	});

	it("filters out outdated historical dated snapshots like *-20240620", () => {
		const oldSnapshot = makeFakeModel("anthropic", "claude-3-5-sonnet-20240620", "claude");
		const modernModel = makeFakeModel("google", "gemini-2.5-pro", "gemini");
		const query = makeFakeModelQuery({
			available: [oldSnapshot, modernModel],
		});

		const roster = resolveCouncilRoster(query, parsePlanCouncilSettings({}));
		const reviewerKeys = roster.reviewers.map(r => r.key);
		expect(reviewerKeys).not.toContain(modelKey(oldSnapshot));
		expect(reviewerKeys).toContain(modelKey(modernModel));
	});
});

describe("prompt renderers", () => {
	it("renders critique system and round1 with exact verbatim preservation", () => {
		const sys = renderCritiqueSystem();
		expect(sys).toContain("### Verdict");
		expect(sys).toContain("### Blocking Issues");

		const verbatimPlan = "# My Plan\n```ts\nconst x = a -> b;\nconst y = '<test>';\n```\n- item 1\n- item 2";
		const verbatimCtx = "User wants: fix the `foo -> bar` pipeline & check <special> chars.";

		const r1 = renderCritiqueRound({
			round: 1,
			planTitle: "Add Feature X",
			planFilePath: "plans/feat.md",
			planContent: verbatimPlan,
			sessionContext: verbatimCtx,
		});

		expect(r1).toContain("Perform your Round 1 critique");

		const r2 = renderCritiqueRound({
			round: 2,
			planTitle: "Add Feature X",
			planFilePath: "plans/feat.md",
			planContent: verbatimPlan,
		});
		expect(r2).toContain("Perform your Round 2 critique");

		expect(r1).toContain("File: `plans/feat.md`");
		expect(r1).toContain(verbatimPlan);
		expect(r1).toContain(verbatimCtx);
	});

	it("renders debate rebuttal preserving peer critiques verbatim", () => {
		const peer1 = "Peer 1 notes: race condition in `step 2` -> line 44: <tag>";
		const peer2 = "Peer 2 says: approve with condition: verify `build()` output";
		const opNotes = "Focus on whether step 2 really races.";

		const rebuttal = renderDebateRebuttal({
			round: 2,
			peerCritiques: [
				{ reviewerLabel: "Claude 3.7", critiqueText: peer1 },
				{ reviewerLabel: "GPT-4o", critiqueText: peer2 },
			],
			operatorNotes: opNotes,
		});

		expect(rebuttal).toContain("# Council Debate: Round 2");
		expect(rebuttal).toContain("### Critique from Claude 3.7");
		expect(rebuttal).toContain(peer1);
		expect(rebuttal).toContain(peer2);
		expect(rebuttal).toContain(opNotes);
	});

	it("renders user follow-up preserving question and peer updates", () => {
		const followup = renderUserFollowup({
			userMessage: "What about Windows path separators `\\` vs `/`?",
			peerUpdates: [{ reviewerLabel: "Claude 3.7", updateText: "We should use `path.normalize`." }],
		});

		expect(followup).toContain("What about Windows path separators `\\` vs `/`?");
		expect(followup).toContain("We should use `path.normalize`.");
	});

	it("lists peer revision IDs and model-written summaries verbatim in debate and follow-up prompts", () => {
		const peerItems = [
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Guard `a < b` & keep {{raw}} \"quoted\"" },
			{ id: "openai/gpt-4o#2", summary: "Add rollback step" },
		];
		const expected = [
			"- `anthropic/claude-3-7-sonnet#1`: Guard `a < b` & keep {{raw}} \"quoted\"",
			"- `openai/gpt-4o#2`: Add rollback step",
		].join("\n");

		const rebuttal = renderDebateRebuttal({ round: 2, peerCritiques: [], peerItems });
		expect(rebuttal).toContain(`### Peer required revisions\n${expected}`);
		expect(renderUserFollowup({ userMessage: "Why?", peerItems })).toContain(`### Peer required revisions\n${expected}`);

		expect(renderDebateRebuttal({ round: 2, peerCritiques: [], peerItems: [] })).not.toContain("Peer required revisions");
	});

	it("renders synthesize system and user prompt with verbatim history", () => {
		const sys = renderSynthesizeSystem();
		expect(sys).toContain("## Required Plan Revisions");
		expect(sys).toContain("## Agreed Keepers / Non-Changes");

		const history = "Round 1:\n- C: risk found\n- G: no risk\nRound 2:\n- C: retracted";
		const userPrompt = renderSynthesizeUser({
			planTitle: "My Plan",
			planFilePath: "plan.md",
			planContent: "Plan content here",
			discussionHistory: history,
		});

		expect(userPrompt).toContain(history);
		expect(userPrompt).toContain("Plan content here");
	});
});
