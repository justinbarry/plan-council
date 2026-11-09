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
import { parseEffort } from "@oh-my-pi/pi-tui/thinking";
import { modelKey, resolveCouncilRoster, resolveModeratorModel, resolveReaderModel, resolveSynthesizer } from "../src/models";
import { parsePlanCouncilSettings } from "../src/settings";

function makeFakeModel(
	provider: string,
	id: string,
	family: string,
	opts?: { thinking?: Model["thinking"]; reasoning?: boolean },
): Model {
	return {
		id,
		provider,
		name: `${id} model`,
		description: "fake model for test",
		contextWindow: 128000,
		maxTokens: 4096,
		thinking: opts?.thinking ?? false,
		reasoning: opts?.reasoning,
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

	it("parses and clamps maxAutoRefines, where 0 turns automatic refining off", () => {
		const parsed = [undefined, 0, -3, 11, "4", 1.6, "bad"].map(
			raw => parsePlanCouncilSettings(raw === undefined ? {} : { maxAutoRefines: raw }).maxAutoRefines,
		);
		expect(parsed).toEqual([2, 0, 0, 10, 4, 2, 2]);
	});

	it("splits CSV reviewerModels and trims whitespace", () => {
		const parsed = parsePlanCouncilSettings({ reviewerModels: " anthropic/claude-3-5-sonnet, , openai/gpt-4o " });
		expect(parsed.reviewerModels).toEqual(["anthropic/claude-3-5-sonnet", "openai/gpt-4o"]);
	});

	it("falls back to default shortcut when blank", () => {
		expect(parsePlanCouncilSettings({ shortcut: "   " }).shortcut).toBe("ctrl+n");
		expect(parsePlanCouncilSettings({ shortcut: "ctrl+p" }).shortcut).toBe("ctrl+p");
	});

	it("parses code reader settings and clamps the per-turn query budget", () => {
		const defaults = parsePlanCouncilSettings({});
		expect([defaults.enableCodeReader, defaults.readerModel, defaults.maxReaderQueriesPerTurn]).toEqual([true, undefined, 3]);
		expect(parsePlanCouncilSettings({ enableCodeReader: false }).enableCodeReader).toBe(false);
		expect(parsePlanCouncilSettings({ readerModel: "  @smol:low " }).readerModel).toBe("@smol:low");
		expect(parsePlanCouncilSettings({ readerModel: "   " }).readerModel).toBeUndefined();
		const budgets = [0, 99, "4", "bad", 2.6, Number.NaN].map(
			raw => parsePlanCouncilSettings({ maxReaderQueriesPerTurn: raw }).maxReaderQueriesPerTurn,
		);
		expect(budgets).toEqual([1, 6, 4, 3, 3, 3]);
	});

	it("parses moderator settings", () => {
		const defaults = parsePlanCouncilSettings({});
		expect(defaults.enableModerator).toBe(true);
		expect(defaults.moderatorModel).toBeUndefined();
		expect(parsePlanCouncilSettings({ enableModerator: false }).enableModerator).toBe(false);
		expect(parsePlanCouncilSettings({ enableModerator: true }).enableModerator).toBe(true);
		expect(parsePlanCouncilSettings({ moderatorModel: "  @smol:low " }).moderatorModel).toBe("@smol:low");
		expect(parsePlanCouncilSettings({ moderatorModel: "   " }).moderatorModel).toBeUndefined();
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
		expect(resolveSynthesizer(query, settingsWithExplicit, [])?.model.id).toBe("gpt-4o");

		const settingsDefault = parsePlanCouncilSettings({});
		// slow role is gemini
		expect(resolveSynthesizer(query, settingsDefault, [])?.model.id).toBe("gemini-2.5-pro");
	});

	it("resolves the reader through @council_reader, @council-reader, @smol, @fast, @default, then the session model", () => {
		const roleNames = ["council_reader", "council-reader", "smol", "fast", "default"];
		const models = roleNames.map(role => makeFakeModel("test", `${role}-model`, role));
		const settings = parsePlanCouncilSettings({});
		for (let i = 0; i < roleNames.length; i++) {
			const roles = Object.fromEntries(roleNames.slice(i).map((role, j) => [role, models[i + j]]));
			const query = makeFakeModelQuery({ available: [claude, ...models], roles, current: claude });
			expect(resolveReaderModel(query, settings, [])?.model).toBe(models[i]);
		}

		const reviewer = { key: modelKey(gpt4o), label: "gpt-4o (openai)", family: "gpt", model: gpt4o };
		expect(resolveReaderModel(makeFakeModelQuery({ available: [claude], current: claude }), settings, [reviewer])).toEqual({
			model: claude,
		});
		expect(resolveReaderModel(makeFakeModelQuery({ available: [gpt4o] }), settings, [reviewer])).toEqual({ model: gpt4o });
		expect(resolveReaderModel(makeFakeModelQuery({ available: [] }), settings, [])).toBeUndefined();
	});

	it("prefers an explicit readerModel and falls back to the reader chain when it does not resolve", () => {
		const smol = makeFakeModel("openai", "gpt-4o-mini", "gpt");
		const query = makeFakeModelQuery({ available: [claude, gpt4o, smol], roles: { smol }, current: claude });
		expect(resolveReaderModel(query, parsePlanCouncilSettings({ readerModel: "gpt-4o" }), [])?.model).toBe(gpt4o);
		expect(resolveReaderModel(query, parsePlanCouncilSettings({ readerModel: "missing-model" }), [])?.model).toBe(smol);
	});

	it("resolves the moderator through @council_moderator, @council-moderator, @smol, then @fast", () => {
		const roleNames = ["council_moderator", "council-moderator", "smol", "fast"];
		const models = roleNames.map(role => makeFakeModel("test", `${role}-model`, role));
		const settings = parsePlanCouncilSettings({});
		for (let i = 0; i < roleNames.length; i++) {
			const roles = Object.fromEntries(roleNames.slice(i).map((role, j) => [role, models[i + j]]));
			const query = makeFakeModelQuery({ available: [claude, ...models], roles, current: claude });
			expect(resolveModeratorModel(query, settings)?.model).toBe(models[i]);
		}
	});

	it("honors an explicit moderatorModel with a :low suffix and returns undefined when none of the chain resolves", () => {
		const efforts = ["low", "medium", "high", "xhigh"].map(parseEffort).filter((e): e is NonNullable<typeof e> => e !== undefined);
		const fast = makeFakeModel("openai", "gpt-4o-mini", "gpt", { reasoning: true, thinking: { mode: "effort", efforts } });
		const query = makeFakeModelQuery({ available: [claude, fast], roles: { fast }, current: claude });

		const resolvedWithEffort = resolveModeratorModel(
			query,
			parsePlanCouncilSettings({ moderatorModel: "gpt-4o-mini:low" }),
		);
		expect(resolvedWithEffort?.model).toBe(fast);
		expect(resolvedWithEffort?.thinkingLevel?.toString()).toBe("low");

		const emptyQuery = makeFakeModelQuery({ available: [claude], current: claude });
		expect(resolveModeratorModel(emptyQuery, parsePlanCouncilSettings({}))).toBeUndefined();
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

	it("tells reviewers about ask_codebase only when a reader is available", () => {
		expect(renderCritiqueSystem()).not.toContain("ask_codebase");
		expect(renderCritiqueSystem({ hasCodeReader: true, maxReaderQueriesPerTurn: 4 })).toContain(
			"`ask_codebase` tool (up to 4 calls per turn)",
		);
		const debate = { round: 2, peerCritiques: [{ reviewerLabel: "gpt-4o (openai)", critiqueText: "x" }] };
		expect(renderDebateRebuttal(debate)).not.toContain("ask_codebase");
		expect(renderDebateRebuttal({ ...debate, hasCodeReader: true })).toContain("verify the code with `ask_codebase`");
	});

	it("renders the Round 1 prompt unchanged when no files are attached", () => {
		const base = { planTitle: "T", planFilePath: "plan.md", planContent: "Plan body" };
		const expected =
			"# Plan Review: T\nFile: `plan.md`\n\n## Proposed Plan\nPlan body\n\nPerform your Round 1 critique according to your review criteria. Be direct, rigorous, and cite specific lines or steps from the plan.";
		expect(renderCritiqueRound(base)).toBe(expected);
		expect(renderCritiqueRound({ ...base, referencedFiles: [] })).toBe(expected);
	});

	it("renders attached file excerpts verbatim after the plan", () => {
		const excerptBlock = "```ts\n1: const f = a -> b; // MUST NOT != x\n2: {{#each x}}y{{/each}}\n```";
		const rendered = renderCritiqueRound({
			planTitle: "T",
			planFilePath: "plan.md",
			planContent: "Plan body",
			referencedFiles: [
				{ path: "src/a->b.ts", rangeLabel: "lines 1–2", excerptBlock },
				{ path: "src/c.ts", rangeLabel: "line 1", excerptBlock: "```ts\n1: c\n```" },
			],
		});
		expect(rendered).toContain(
			`Plan body\n\n## Referenced Repository Files\nNumbered working-tree excerpts captured during council initialization for paths named in the plan (line numbers reflect the current file and may be offset from plan citations):\n\n### \`src/a->b.ts\` (lines 1–2)\n${excerptBlock}\n\n### \`src/c.ts\` (line 1)\n\`\`\`ts\n1: c\n\`\`\`\n\nPerform your Round 1 critique`,
		);
	});

	it("tells reviewers to trust attached excerpts and keep ask_codebase for what they do not cover", () => {
		const sys = renderCritiqueSystem({ hasCodeReader: true });
		expect(sys).toContain("`ask_codebase` tool (up to 3 calls per turn)");
		expect(sys).toContain(
			"When the prompt includes `## Referenced Repository Files`, treat those numbered working-tree excerpts as ground truth for the shown lines unless a line or excerpt is marked `[line truncated]` or `[truncated ...]` or working-tree drift is in question",
		);
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

		// the instructions name the section; only the section heading itself must be absent
		expect(renderDebateRebuttal({ round: 2, peerCritiques: [], peerItems: [] })).not.toContain("---\n### Peer required revisions\n");
	});

	it("renders a roundtable turn with the floor, turn headings, challenges to own revisions, and annotated peer items verbatim", () => {
		const rendered = renderDebateRebuttal({
			round: 2,
			roundtable: { speaker: 2, peerHandles: ["@claude-3-7-sonnet", "@gemini-2.5-pro"] },
			peerCritiques: [
				{ reviewerLabel: "claude-3-7-sonnet (anthropic)", critiqueText: "R1: a -> b", round: 1, kind: "critique" },
				{ reviewerLabel: "gemini-2.5-pro (google)", critiqueText: "R2: keep {{raw}}", round: 2, kind: "rebuttal" },
			],
			ownDisputes: [
				{ id: "openai/gpt-4o#1", summary: "Retry -> twice", by: "claude-3-7-sonnet (anthropic)", reason: "already {{raw}} != needed" },
			],
			peerItems: [
				{
					id: "anthropic/claude-3-7-sonnet#1",
					summary: "Guard a -> b",
					disputes: [{ by: "gemini-2.5-pro (google)", reason: "covered by {{x}}" }],
				},
				{
					id: "google/gemini-2.5-pro#1",
					summary: "Pin deps",
					disputes: [
						{ by: "claude-3-7-sonnet (anthropic)", reason: "pinned != locked" },
						{ by: "grok-3 (xai)", reason: "" },
					],
				},
			],
		});

		expect(rendered).toContain("You have the floor (turn 2; peers: @claude-3-7-sonnet, @gemini-2.5-pro).");
		expect(rendered).toContain("### Critique from claude-3-7-sonnet (anthropic)\nR1: a -> b\n");
		expect(rendered).toContain("### Round 2 rebuttal from gemini-2.5-pro (google)\nR2: keep {{raw}}\n");
		expect(rendered).toContain(
			"### Peer challenges to your revisions\n- **claude-3-7-sonnet (anthropic)** challenged your `openai/gpt-4o#1` (Retry -> twice): already {{raw}} != needed\n",
		);
		expect(rendered).toContain(
			[
				"### Peer required revisions",
				"- `anthropic/claude-3-7-sonnet#1`: Guard a -> b",
				"  - Disputed by **gemini-2.5-pro (google)**: covered by {{x}}",
				"- `google/gemini-2.5-pro#1`: Pin deps",
				"  - Disputed by **claude-3-7-sonnet (anthropic)**: pinned != locked",
				"  - Disputed by **grok-3 (xai)**",
				"",
			].join("\n"),
		);
		// stance targets are read from `- \`id\`: ` lines, which only peer items use
		expect([...rendered.matchAll(/^- `([^`]+)`: /gm)].map(m => m[1])).toEqual([
			"anthropic/claude-3-7-sonnet#1",
			"google/gemini-2.5-pro#1",
		]);
		expect(rendered).toContain("### Roundtable Instructions");
		expect(rendered).not.toContain("### Instructions for Rebuttal");
	});

	it("renders a bare rebuttal without a lead-in or floor", () => {
		const rendered = renderDebateRebuttal({ round: 2, peerCritiques: [] });
		expect(rendered).not.toContain("Examine their assessments below");
		expect(rendered).not.toContain("You have the floor");
		expect(rendered).toContain("### Instructions for Rebuttal");
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
